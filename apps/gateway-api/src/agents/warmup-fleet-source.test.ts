import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { buildDiagnosticInstructions, loadWarmupFleet } from "./warmup-fleet-source.ts";

async function workspaceWith(input: {
  bindings?: unknown[];
  smtpCredentials?: unknown[];
}): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "fleet-source-"));
  const workspace = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  if (input.bindings) {
    await workspace.updateInventoryJson("domains.json", () => ({ bindings: input.bindings }));
  }
  if (input.smtpCredentials) {
    await workspace.updateInventoryJson("smtp-credentials.json", () => ({
      smtpCredentials: input.smtpCredentials
    }));
  }
  return workspace;
}

const binding = (domain: string, extra: Record<string, unknown> = {}) => ({
  domain,
  serverSlug: `contabo-${domain.replace(/\W/g, "")}`,
  serverIp: "192.0.2.10",
  status: "main_domain_bound",
  ...extra
});

test("carga la flota del mismo inventario que usa la rampa", async () => {
  const workspace = await workspaceWith({
    bindings: [binding("uno.com"), binding("dos.com"), binding("tres.com")]
  });

  const fleet = await loadWarmupFleet({ workspace });

  assert.equal(fleet.totalInInventory, 3);
  assert.equal(fleet.domains.length, 3);
  assert.deepEqual(fleet.domains.map((entry) => entry.domain), ["uno.com", "dos.com", "tres.com"]);
  assert.ok(fleet.domains.every((entry) => entry.serverSlug && entry.serverIp));
});

test("descarta los bindings sin serverSlug o sin serverIp, y el descarte queda visible", async () => {
  // Un agente sin esos dos datos no puede construir los params de su primera tool. Pero el
  // descarte no puede ser invisible: totalInInventory vs domains.length lo delata sin log.
  const workspace = await workspaceWith({
    bindings: [
      binding("ok.com"),
      { domain: "sin-slug.com", serverIp: "192.0.2.11" },
      { domain: "sin-ip.com", serverSlug: "contabo-x" },
      { serverSlug: "contabo-y", serverIp: "192.0.2.12" }
    ]
  });

  const fleet = await loadWarmupFleet({ workspace });

  assert.equal(fleet.totalInInventory, 4, "el total refleja lo leido");
  assert.equal(fleet.domains.length, 1, "solo el usable entra al abanico");
  assert.equal(fleet.domains[0]?.domain, "ok.com");
});

test("normaliza el dominio igual que el resto del gateway", async () => {
  const workspace = await workspaceWith({
    bindings: [binding("MiDominio.COM."), binding("  otro.com  ")]
  });

  const fleet = await loadWarmupFleet({ workspace });

  assert.deepEqual(fleet.domains.map((entry) => entry.domain), ["midominio.com", "otro.com"]);
});

test("filtrar por dominios reporta los que no existen en vez de ignorarlos", async () => {
  const workspace = await workspaceWith({
    bindings: [binding("uno.com"), binding("dos.com")]
  });

  const fleet = await loadWarmupFleet({
    workspace,
    onlyDomains: ["DOS.com.", "fantasma.com"]
  });

  assert.deepEqual(fleet.domains.map((entry) => entry.domain), ["dos.com"]);
  assert.deepEqual(fleet.notFound, ["fantasma.com"], "pedir un dominio inexistente no se traga en silencio");
});

test("marca que dominios tienen credencial, pero NO los excluye por defecto", async () => {
  // Un dominio sin credencial es justamente uno de los casos que interesa diagnosticar.
  const workspace = await workspaceWith({
    bindings: [binding("con-cred.com"), binding("sin-cred.com")],
    smtpCredentials: [
      { domain: "con-cred.com", status: "configured" },
      { domain: "otro-mas.com", status: "configured" }
    ]
  });

  const fleet = await loadWarmupFleet({ workspace });

  assert.equal(fleet.domains.length, 2, "los dos entran");
  assert.equal(fleet.domains.find((e) => e.domain === "con-cred.com")?.hasCredential, true);
  assert.equal(fleet.domains.find((e) => e.domain === "sin-cred.com")?.hasCredential, false);

  const soloConCred = await loadWarmupFleet({ workspace, requireCredential: true });
  assert.deepEqual(soloConCred.domains.map((e) => e.domain), ["con-cred.com"]);
});

test("una credencial que no esta 'configured' no cuenta", async () => {
  const workspace = await workspaceWith({
    bindings: [binding("pendiente.com")],
    smtpCredentials: [{ domain: "pendiente.com", status: "provisioning" }]
  });

  const fleet = await loadWarmupFleet({ workspace });
  assert.equal(fleet.domains[0]?.hasCredential, false);
});

test("un inventario ausente o vacio devuelve flota vacia, no tira", async () => {
  const vacio = await workspaceWith({});
  const fleet = await loadWarmupFleet({ workspace: vacio });
  assert.deepEqual(fleet.domains, []);
  assert.equal(fleet.totalInInventory, 0);

  const sinBindings = await workspaceWith({ bindings: [] });
  const fleet2 = await loadWarmupFleet({ workspace: sinBindings });
  assert.deepEqual(fleet2.domains, []);
});

test("las instrucciones llevan los datos que las tools exigen y prohiben escribir", async () => {
  const texto = buildDiagnosticInstructions({
    domain: "ejemplo.com",
    serverSlug: "contabo-123",
    serverIp: "192.0.2.44",
    hasCredential: false
  });

  // Sin estos tres el agente no puede construir los params de read_smtp_reachability.
  assert.match(texto, /ejemplo\.com/);
  assert.match(texto, /contabo-123/);
  assert.match(texto, /192\.0\.2\.44/);
  assert.match(texto, /NO/, "el faltante de credencial se declara");
  // Las dos fallas que hay que distinguir, y el limite de alcance.
  assert.match(texto, /incomunicado/);
  assert.match(texto, /rechazado por el destino/);
  assert.match(texto, /No envies correo/);
});

// --- message-id: sin el, read_delivery_reason es inllamable ------------------

const auditWith = (events: Array<{ action?: string; metadata?: Record<string, unknown> }>) => ({
  list: async () => events
});

test("saca el messageId mas reciente por dominio del audit log", async () => {
  const workspace = await workspaceWith({ bindings: [binding("uno.com"), binding("dos.com")] });
  const auditLog = auditWith([
    { action: "oc.smtp.real_email_sent", metadata: { messageId: "<delivrix-viejo@uno.com>" } },
    { action: "oc.warmup.seed_sent", metadata: { messageId: "<ignorado@uno.com>" } },
    { action: "oc.smtp.real_email_sent", metadata: { messageId: "<delivrix-nuevo@uno.com>" } },
    { action: "oc.smtp.real_email_sent", metadata: { messageId: "<delivrix-x@ajeno.com>" } }
  ]);

  const fleet = await loadWarmupFleet({ workspace, auditLog });

  // El audit esta en orden cronologico: gana el ultimo.
  assert.equal(fleet.domains.find((e) => e.domain === "uno.com")?.recentMessageId, "<delivrix-nuevo@uno.com>");
  // Un dominio sin envios no inventa messageId.
  assert.equal(fleet.domains.find((e) => e.domain === "dos.com")?.recentMessageId, undefined);
});

test("solo cuentan los oc.smtp.real_email_sent, no cualquier evento con messageId", async () => {
  const workspace = await workspaceWith({ bindings: [binding("uno.com")] });
  const auditLog = auditWith([
    { action: "oc.warmup.seed_sent", metadata: { messageId: "<no-cuenta@uno.com>" } },
    { action: "oc.smtp.run_state_reconciled", metadata: { messageId: "<tampoco@uno.com>" } }
  ]);

  const fleet = await loadWarmupFleet({ workspace, auditLog });
  assert.equal(fleet.domains[0]?.recentMessageId, undefined);
});

test("sin auditLog el abanico corre igual, con una tool menos", async () => {
  const workspace = await workspaceWith({ bindings: [binding("uno.com")] });
  const fleet = await loadWarmupFleet({ workspace });
  assert.equal(fleet.domains.length, 1);
  assert.equal(fleet.domains[0]?.recentMessageId, undefined);
});

test("un audit log que tira no rompe el abanico", async () => {
  const workspace = await workspaceWith({ bindings: [binding("uno.com")] });
  const roto = { list: async () => { throw new Error("audit ilegible"); } };
  const fleet = await loadWarmupFleet({ workspace, auditLog: roto });
  assert.equal(fleet.domains.length, 1, "la flota se carga igual");
  assert.equal(fleet.domains[0]?.recentMessageId, undefined);
});

test("las instrucciones dicen que hacer en los dos casos", async () => {
  const conId = buildDiagnosticInstructions({
    domain: "ejemplo.com",
    serverSlug: "contabo-1",
    serverIp: "192.0.2.1",
    hasCredential: true,
    recentMessageId: "<delivrix-abc@ejemplo.com>"
  });
  assert.match(conId, /<delivrix-abc@ejemplo\.com>/);
  assert.match(conId, /Usa el messageId de arriba con read_delivery_reason/);

  const sinId = buildDiagnosticInstructions({
    domain: "ejemplo.com",
    serverSlug: "contabo-1",
    serverIp: "192.0.2.1",
    hasCredential: true
  });
  assert.match(sinId, /NO HAY/);
  // Sin esto el agente pide la tool, recibe invalid_params y no sabe por que.
  assert.match(sinId, /Sin messageId NO podes usar read_delivery_reason/);
  // Y esto es lo que se midio en vivo el 2026-07-29: la version anterior terminaba con
  // "deci que no hay evidencia de entrega reciente", y el modelo lo leia como permiso para
  // concluir. Cerraba con CERO tools en el 46% de la flota. Ahora las otras cuatro son
  // obligatorias y se nombran, y cerrar sin ellas se declara invalido de forma explicita.
  assert.match(sinId, /Es la UNICA que se saltea/);
  assert.match(sinId, /read_smtp_reachability, read_dkim_status, read_mxtoolbox_health, inspect_smtp_inventory/);
  assert.match(sinId, /no es una respuesta valida/);
  assert.match(sinId, /NO significa que/);
});

// --- conflicto de inventario: el nodo equivocado da un veredicto confiado y falso ----------

test("detecta cuando domains.json y la credencial discrepan sobre el nodo", async () => {
  // Medido en produccion: 5 de 59 dominios estan asi. El serverSlug alimenta LAS 5 tools,
  // asi que sondear el nodo equivocado devuelve un resultado correcto DE OTRA MAQUINA.
  const workspace = await workspaceWith({
    bindings: [
      { domain: "stale.com", serverSlug: "server60", serverIp: "192.0.2.1" },
      { domain: "coherente.com", serverSlug: "server85", serverIp: "192.0.2.2" }
    ],
    smtpCredentials: [
      { domain: "stale.com", status: "configured", serverSlug: "server85" },
      { domain: "coherente.com", status: "configured", serverSlug: "server85" }
    ]
  });

  const fleet = await loadWarmupFleet({ workspace });
  const stale = fleet.domains.find((e) => e.domain === "stale.com");
  const coherente = fleet.domains.find((e) => e.domain === "coherente.com");

  assert.deepEqual(stale?.bindingConflict, { fromBindings: "server60", fromCredentials: "server85" });
  assert.equal(coherente?.bindingConflict, undefined, "sin discrepancia no se marca nada");
  // No se adivina cual de los dos gana: el binding se deja como estaba y se marca el conflicto.
  assert.equal(stale?.serverSlug, "server60");
});

test("con conflicto se OMITE el messageId: no es atribuible a ningun nodo", async () => {
  const workspace = await workspaceWith({
    bindings: [{ domain: "stale.com", serverSlug: "server60", serverIp: "192.0.2.1" }],
    smtpCredentials: [{ domain: "stale.com", status: "configured", serverSlug: "server85" }]
  });
  const auditLog = auditWith([
    { action: "oc.smtp.real_email_sent", metadata: { messageId: "<delivrix-x@stale.com>" } }
  ]);

  const fleet = await loadWarmupFleet({ workspace, auditLog });
  assert.equal(
    fleet.domains[0]?.recentMessageId,
    undefined,
    "sin saber que nodo es, el mensaje tampoco se puede atribuir"
  );
});

test("una credencial sin serverSlug no inventa un conflicto", async () => {
  const workspace = await workspaceWith({
    bindings: [{ domain: "x.com", serverSlug: "server1", serverIp: "192.0.2.1" }],
    smtpCredentials: [{ domain: "x.com", status: "configured" }]
  });

  const fleet = await loadWarmupFleet({ workspace });
  assert.equal(fleet.domains[0]?.bindingConflict, undefined);
  assert.equal(fleet.domains[0]?.hasCredential, true);
});

test("las instrucciones con conflicto prohiben atribuir la medicion", async () => {
  const texto = buildDiagnosticInstructions({
    domain: "stale.com",
    serverSlug: "server60",
    serverIp: "192.0.2.1",
    hasCredential: true,
    bindingConflict: { fromBindings: "server60", fromCredentials: "server85" }
  });

  assert.match(texto, /EL INVENTARIO SE CONTRADICE/);
  assert.match(texto, /server60/);
  assert.match(texto, /server85/);
  assert.match(texto, /indeterminado/);
  // La frase que evita el veredicto confiado y falso.
  assert.match(texto, /peor\s+que no tener dato/);
});

// --- abstencion correcta != veredicto vacio --------------------------------

test("cero sondas CON conflicto de inventario es abstencion correcta, no falta de evidencia", async () => {
  // Medido en la corrida completa del 2026-07-30: los 5 dominios que cerraron sin sondear eran
  // EXACTAMENTE los 5 con conflicto. No sondear ahi es el acierto — el prompt le pide al agente
  // que no atribuya a este dominio nada medido en un nodo que quizas no es el suyo.
  const { statusOfForTests } = await import("./warmup-audit-run.ts");
  const sesion = { status: "completed" as const, toolCallCount: 0 };

  assert.equal(
    statusOfForTests({ item: { bindingConflict: { fromBindings: "a", fromCredentials: "b" } }, result: sesion }),
    "abstenido"
  );
  // Sin conflicto, cero sondas es un veredicto escrito sobre nada.
  assert.equal(statusOfForTests({ item: {}, result: sesion }), "sin_evidencia");
  // Y con sondas, es un diagnostico.
  assert.equal(statusOfForTests({ item: {}, result: { ...sesion, toolCallCount: 4 } }), "ok");
});
