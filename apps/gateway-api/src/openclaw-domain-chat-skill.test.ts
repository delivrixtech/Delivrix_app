import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDomainInventoryAnswer,
  buildDomainInventoryReportBlocks,
  isDomainInventoryIntent,
  maybeHandleOpenClawDomainChatSkill
} from "./openclaw-domain-chat-skill.ts";

test("domain chat skill detects Spanish domain inventory requests", () => {
  assert.equal(isDomainInventoryIntent("enlistame los 16 dominios de ionos"), true);
  assert.equal(isDomainInventoryIntent("necesito que me enlistes los 16 dominios de IONOS"), true);
  assert.equal(isDomainInventoryIntent("Como asi, no puedes enlistarme los dominios?"), true);
  assert.equal(isDomainInventoryIntent("necesito revisar DNS de dominios"), true);
  assert.equal(isDomainInventoryIntent("continua con el plan"), false);
  assert.equal(isDomainInventoryIntent([
    "OpenClaw, retomá configure_complete_smtp desde el estado real auditado.",
    "domain=controldelivrix.app serverSlug=server10 serverIp=45.136.70.47",
    "Primero verificá DNS A actual y proponé ApprovalGate para provision_smtp_postfix."
  ].join(" ")), false);
  assert.equal(isDomainInventoryIntent([
    "Parámetros: brand=controldelivrix domain=controldelivrix.app",
    "smtpHost=smtp.controldelivrix.app budgetUsdMax=30",
    "Continuar desde post-DNS, no crear VPS nuevo."
  ].join(" ")), false);
});

test("domain chat skill lets operational SMTP prompts reach Bedrock", async () => {
  const response = await maybeHandleOpenClawDomainChatSkill({
    body: {
      msgId: "smtp-resume-1",
      message: [
        "OpenClaw, retomá configure_complete_smtp desde el estado real auditado.",
        "domain=controldelivrix.app serverSlug=server10 serverIp=45.136.70.47",
        "Verificá DNS A actual y proponé ApprovalGate para provision_smtp_postfix."
      ].join(" ")
    },
    chatProxy: {} as never,
    canvasLiveEvents: {} as never,
    auditLog: {
      append: async () => undefined
    },
    ionosDomains: {
      listInventory: async () => {
        throw new Error("domain inventory should not run");
      }
    },
    ionosDns: {
      listInventory: async () => {
        throw new Error("dns inventory should not run");
      }
    }
  });

  assert.equal(response, null);
});

test("domain chat skill builds deterministic IONOS inventory answer", () => {
  const answer = buildDomainInventoryAnswer({
    source: {
      kind: "live",
      apiBase: "https://api.hosting.ionos.com/domains/v1",
      fetchedAt: "2026-05-26T02:00:00.000Z",
      responseOk: true,
      tenantConfigured: false
    },
    domains: [
      {
        id: "d-2",
        name: "filecorppro.net",
        status: "ACTIVE",
        autoRenew: true,
        expiresAt: "2027-01-01",
        nameservers: []
      },
      {
        id: "d-1",
        name: "nfcorpreport.com",
        status: "ACTIVE",
        autoRenew: false,
        nameservers: []
      }
    ]
  }, {
    source: {
      kind: "live",
      apiKind: "hosting-dns",
      apiBase: "https://api.hosting.ionos.com/dns",
      fetchedAt: "2026-05-26T02:00:00.000Z",
      responseOk: true
    },
    zones: [
      {
        id: "z-1",
        name: "nfcorpreport.com",
        records: [
          { id: "a-1", name: "@", type: "A", content: "203.0.113.10" },
          { id: "mx-1", name: "@", type: "MX", content: "mail.nfcorpreport.com" }
        ]
      }
    ]
  }, new Date("2026-05-26T02:05:00.000Z"));

  assert.match(answer, /Encontré 2 dominios registrados en IONOS/);
  assert.match(answer, /1\. filecorppro\.net/);
  assert.match(answer, /2\. nfcorpreport\.com/);
  assert.match(answer, /1 dominios tienen al menos A \+ MX/);
  assert.match(answer, /No hice compras, no cambie DNS/);
});

test("domain chat skill returns assistant ack and emits canvas report events", async () => {
  const emitted: unknown[] = [];
  const assistantEvents: unknown[] = [];
  const auditEvents: unknown[] = [];
  const now = new Date("2026-05-26T02:05:00.000Z");

  const response = await maybeHandleOpenClawDomainChatSkill({
    body: {
      msgId: "domain-smoke-1",
      message: "necesito que me enlistes los dominios de IONOS"
    },
    chatProxy: {
      broadcast: (event: unknown) => {
        assistantEvents.push(event);
      },
      handleAgentMessage: async (event: unknown) => {
        assistantEvents.push(event);
        return event;
      }
    } as never,
    canvasLiveEvents: {
      emit: async (event: unknown) => {
        emitted.push(event);
        return event;
      }
    } as never,
    auditLog: {
      append: async (event: unknown) => {
        auditEvents.push(event);
      }
    } as never,
    ionosDomains: {
      listInventory: async () => ({
        source: {
          kind: "live",
          apiBase: "https://api.hosting.ionos.com/domains/v1",
          fetchedAt: now.toISOString(),
          responseOk: true,
          tenantConfigured: false
        },
        domains: [
          {
            id: "d-1",
            name: "nfcorpreport.com",
            status: "ACTIVE",
            autoRenew: true,
            nameservers: []
          }
        ]
      })
    },
    ionosDns: {
      listInventory: async () => ({
        source: {
          kind: "live",
          apiKind: "hosting-dns",
          apiBase: "https://api.hosting.ionos.com/dns",
          fetchedAt: now.toISOString(),
          responseOk: true
        },
        zones: [
          {
            id: "z-1",
            name: "nfcorpreport.com",
            records: [
              { id: "a-1", name: "@", type: "A", content: "203.0.113.10" },
              { id: "mx-1", name: "@", type: "MX", content: "mail.nfcorpreport.com" }
            ]
          }
        ]
      })
    },
    now: () => now
  });

  assert.equal(response?.msgId, "domain-smoke-1");
  assert.equal(response?.queued, true);
  assert.equal(response?.assistant?.source, "delivrix.domain_inventory");
  assert.match(response?.assistant?.content ?? "", /nfcorpreport\.com/);
  assert.equal(emitted.some((event) => isEventType(event, "oc.task.declare")), true);
  assert.equal(emitted.some((event) => isEventType(event, "oc.action.now")), true);
  assert.equal(emitted.some((event) => isEventType(event, "oc.artifact.declare")), true);
  assert.equal(emitted.filter((event) => isEventType(event, "oc.artifact.block")).length, 3);
  assert.equal(assistantEvents.some((event) => isEventType(event, "ASSISTANT_DONE")), true);
  assert.equal(auditEvents.length, 1);
});

test("domain inventory report blocks summarize DNS read-only evidence", () => {
  const blocks = buildDomainInventoryReportBlocks({
    source: {
      kind: "live",
      apiBase: "https://api.hosting.ionos.com/domains/v1",
      fetchedAt: "2026-05-26T02:00:00.000Z",
      responseOk: true,
      tenantConfigured: false
    },
    domains: [
      {
        id: "d-1",
        name: "nfcorpreport.com",
        status: "ACTIVE",
        autoRenew: true,
        nameservers: []
      }
    ]
  }, {
    source: {
      kind: "live",
      apiKind: "hosting-dns",
      apiBase: "https://api.hosting.ionos.com/dns",
      fetchedAt: "2026-05-26T02:00:00.000Z",
      responseOk: true
    },
    zones: [
      {
        id: "z-1",
        name: "nfcorpreport.com",
        records: [
          { id: "a-1", name: "@", type: "A", content: "203.0.113.10" }
        ]
      }
    ]
  }, new Date("2026-05-26T02:05:00.000Z"));

  assert.equal(blocks.length, 3);
  assert.match(blocks[0].content, /1 dominios IONOS/);
  assert.match(blocks[1].content, /nfcorpreport\.com \| active \| A:1 \| MX:0/);
  assert.match(blocks[2].content, /no se hicieron compras/);
});

test("domain chat skill NO secuestra prompts de configuracion SMTP (regresion content is required)", () => {
  // Estos mensajes en lenguaje natural crasheaban el chat con "content is required."
  // porque el clasificador los mandaba al skill local de inventario (IONOS 0 dominios).
  // Deben ir al modelo (Bedrock) -> isDomainInventoryIntent === false.
  assert.equal(isDomainInventoryIntent("crea un nuevo smtp"), false);
  assert.equal(isDomainInventoryIntent(
    "Configura este; controlledgerdesk.com y luego vamos por el siguiente; Con el mismo presupuesto, y datos de envio."
  ), false);
  assert.equal(isDomainInventoryIntent(
    "Hay una lista de dominios adquiridos sin configurar, lo que haremos es aprovecharlos; Configura este; controlledgerdesk.com"
  ), false);
  assert.equal(isDomainInventoryIntent(
    "genial, configuremos este controlcorpfiling.com correo de prueba; juanestebancanar@gmail.com"
  ), false);
});

test("domain chat skill deja reputacion y blacklist a Bedrock/MXToolbox", () => {
  assert.equal(isDomainInventoryIntent(
    "¿Este dominio está quemado annualrenewalnational.com o listado? Revisa reputación."
  ), false);
  assert.equal(isDomainInventoryIntent(
    "revisa si el dominio annualrenewalnational.com esta en blacklist"
  ), false);
  assert.equal(isDomainInventoryIntent(
    "¿la IP 8.8.8.8 está listada en MXToolbox o Spamhaus?"
  ), false);
});

test("domain chat skill sigue detectando inventario PURO", () => {
  assert.equal(isDomainInventoryIntent("enlistame los dominios de ionos"), true);
  assert.equal(isDomainInventoryIntent("muestra los dominios registrados"), true);
  assert.equal(isDomainInventoryIntent("cuales dominios tengo en ionos"), true);
});

test("domain inventory report blocks nunca emiten content vacio con 0 dominios (regresion content is required)", () => {
  const blocks = buildDomainInventoryReportBlocks({
    source: {
      kind: "live",
      apiBase: "https://api.hosting.ionos.com/domains/v1",
      fetchedAt: "2026-06-10T02:00:00.000Z",
      responseOk: true,
      tenantConfigured: false
    },
    domains: []
  }, {
    source: {
      kind: "live",
      apiKind: "hosting-dns",
      apiBase: "https://api.hosting.ionos.com/dns",
      fetchedAt: "2026-06-10T02:00:00.000Z",
      responseOk: true
    },
    zones: []
  }, new Date("2026-06-10T02:05:00.000Z"));

  for (const block of blocks) {
    assert.ok(block.content.trim().length > 0, `bloque ${block.blockId} no debe estar vacio`);
  }
});

function isEventType(event: unknown, type: string): boolean {
  return typeof event === "object" && event !== null && "type" in event && event.type === type;
}
