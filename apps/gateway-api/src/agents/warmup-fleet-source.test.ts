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
