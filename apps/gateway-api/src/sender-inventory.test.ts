// Tests del inventario de bandejas.
//
// Lo que protegen es una sola cosa: que un dato que no se midio no pueda parecer un cero. Esta
// semana aparecieron SEIS sensores con esa misma falla y todos se leian como salud.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import { leerInventarioFabrica } from "./sender-inventory.ts";

const ahora = new Date("2026-07-30T12:00:00.000Z");

async function workspaceCon(input: {
  bindings?: unknown[];
  credenciales?: unknown[];
}): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "inv-fabrica-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  if (input.bindings) await ws.updateInventoryJson("domains.json", () => ({ bindings: input.bindings }));
  if (input.credenciales) {
    await ws.updateInventoryJson("smtp-credentials.json", () => ({ smtpCredentials: input.credenciales }));
  }
  return ws;
}

const cred = (domain: string, extra: Record<string, unknown> = {}) => ({
  domain,
  serverSlug: `nodo-${domain.replace(/\W/g, "")}`,
  status: "configured",
  createdAt: "2026-06-24T00:00:00.000Z",
  sshAccess: { user: "delivrix-ops", port: 22 },
  ...extra
});

const bind = (domain: string, extra: Record<string, unknown> = {}) => ({
  domain,
  serverSlug: `nodo-${domain.replace(/\W/g, "")}`,
  serverIp: "192.0.2.10",
  ...extra
});

test("el denominador son las CREDENCIALES, no los bindings", async () => {
  // Medido en produccion: 66 credenciales configuradas contra 59 bindings. Todo el sistema
  // itera bindings, asi que 7 bandejas no las toca ningun sondeo — y el reporte del abanico
  // salia 59/59, que se lee como cobertura total.
  const ws = await workspaceCon({
    credenciales: [cred("a.com"), cred("b.com"), cred("huerfana.com")],
    bindings: [bind("a.com"), bind("b.com")]
  });

  const inv = await leerInventarioFabrica({ workspace: ws, now: () => ahora });

  assert.equal(inv.totalBandejas, 3, "el total es de credenciales");
  assert.equal(inv.medibles, 2, "solo 2 puede alcanzarlas un sondeo");
  assert.deepEqual(inv.sinBinding, ["huerfana.com"]);
});

test("las bandejas que ningun sondeo alcanza van PRIMERO, no al fondo", async () => {
  const ws = await workspaceCon({
    credenciales: [cred("zzz-sana.com"), cred("aaa-ciega.com")],
    bindings: [bind("zzz-sana.com")]
  });

  const inv = await leerInventarioFabrica({ workspace: ws, now: () => ahora });

  assert.equal(inv.bandejas[0]?.domain, "aaa-ciega.com", "el riesgo va arriba, aunque ordene despues alfabeticamente");
  assert.equal(inv.bandejas[0]?.sinMedicion, "sin_binding");
});

test("un conflicto de inventario sale marcado y SIN datos de medicion", async () => {
  // El slug alimenta todas las sondas: medir el nodo equivocado devuelve un resultado correcto
  // de otra maquina y se lo atribuye a este dominio.
  const ws = await workspaceCon({
    credenciales: [cred("discordante.com", { serverSlug: "server85" })],
    bindings: [bind("discordante.com", { serverSlug: "server60" })]
  });

  const inv = await leerInventarioFabrica({ workspace: ws, now: () => ahora });

  assert.deepEqual(inv.enConflicto, ["discordante.com"]);
  assert.deepEqual(inv.bandejas[0]?.conflicto, { enBindings: "server60", enCredencial: "server85" });
  assert.equal(inv.bandejas[0]?.sinMedicion, "conflicto_de_inventario");
});

test("sin medicion es null CON MOTIVO, nunca un cero", async () => {
  const ws = await workspaceCon({ credenciales: [cred("nueva.com")], bindings: [bind("nueva.com")] });
  const inv = await leerInventarioFabrica({ workspace: ws, now: () => ahora });

  const b = inv.bandejas[0]!;
  assert.equal(b.sinMedicion, "nunca_medida");
  // Nada de esta fila puede leerse como "todo bien": el motivo viaja con el dato.
  assert.notEqual(b.sinMedicion, null);
});

test("edad desconocida es null, no 'recien creado'", async () => {
  const ws = await workspaceCon({
    credenciales: [cred("con-fecha.com"), cred("sin-fecha.com", { createdAt: undefined })],
    bindings: [bind("con-fecha.com"), bind("sin-fecha.com")]
  });

  const inv = await leerInventarioFabrica({ workspace: ws, now: () => ahora });
  assert.equal(inv.bandejas.find((b) => b.domain === "con-fecha.com")?.edadDias, 36);
  assert.equal(inv.bandejas.find((b) => b.domain === "sin-fecha.com")?.edadDias, null);
});

test("una credencial a medio aprovisionar no es producto", async () => {
  const ws = await workspaceCon({
    credenciales: [cred("lista.com"), cred("pendiente.com", { status: "pending_install" })],
    bindings: [bind("lista.com"), bind("pendiente.com")]
  });

  const inv = await leerInventarioFabrica({ workspace: ws, now: () => ahora });
  assert.equal(inv.totalBandejas, 1);
  assert.equal(inv.bandejas[0]?.domain, "lista.com");
});

test("si no se puede leer el inventario, la pantalla queda ROTULADA parcial", async () => {
  // El modo de falla que hay que hacer imposible: hoy, con Postgres caido, la pantalla pinta
  // ceros y el cartel que explica por que dice algo falso.
  const vacio = await workspaceCon({});
  const inv = await leerInventarioFabrica({ workspace: vacio, now: () => ahora });

  assert.equal(inv.parcial, true);
  assert.ok(inv.motivosParcial.length > 0, "el motivo se muestra, no se traga");
  assert.equal(inv.totalBandejas, 0);
});

test("el acceso ops se declara: sin el, el nodo no se puede medir", async () => {
  const ws = await workspaceCon({
    credenciales: [cred("con-ssh.com"), cred("sin-ssh.com", { sshAccess: null })],
    bindings: [bind("con-ssh.com"), bind("sin-ssh.com")]
  });

  const inv = await leerInventarioFabrica({ workspace: ws, now: () => ahora });
  assert.equal(inv.bandejas.find((b) => b.domain === "con-ssh.com")?.tieneAccesoOps, true);
  assert.equal(inv.bandejas.find((b) => b.domain === "sin-ssh.com")?.tieneAccesoOps, false);
});
