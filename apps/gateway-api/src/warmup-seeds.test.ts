// Tests del registro de semillas. Lo que protegen: que el app password NUNCA quede en claro en el
// JSON, que el AAD ate el secreto a su semilla, que la rotación reparta de verdad, y que apagar
// una semilla no la borre.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import {
  agregarSemilla,
  coberturaPorProveedor,
  descifrarSemilla,
  elegirSemilla,
  leerSemillas,
  marcarSemilla,
  marcarVerificada,
  semillasActivas,
  SEEDS_FILE,
  validarSemillaNueva,
  WarmupSeedError,
  type SeedRegistry,
  type WarmupSeed
} from "./warmup-seeds.ts";

// 32 bytes: la llave de cifrado de credenciales.
const ENV = { CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") };
const ahora = new Date("2026-08-03T12:00:00.000Z");

async function ws(): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "seeds-"));
  return new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
}

function seed(overrides: Partial<WarmupSeed> = {}): WarmupSeed {
  return {
    address: "a@gmail.com",
    provider: "gmail",
    enabled: true,
    imap: { host: "imap.gmail.com", port: 993 },
    secretEncrypted: { algorithm: "aes-256-gcm", iv: "x", authTag: "y", ciphertext: "z" },
    addedAt: ahora.toISOString(),
    ...overrides
  };
}

test("el app password NUNCA queda en claro en el registro", async () => {
  const workspace = await ws();
  await agregarSemilla({
    workspace,
    env: ENV,
    address: "Semilla@Gmail.com",
    provider: "gmail",
    secret: "hunter2-app-password",
    now: () => ahora
  });

  const crudo = JSON.stringify(await workspace.readInventoryJson<SeedRegistry>(SEEDS_FILE));
  assert.ok(!crudo.includes("hunter2"), "el secreto no puede aparecer en el JSON");
  assert.ok(crudo.includes("aes-256-gcm"));

  const { seeds } = await leerSemillas(workspace);
  assert.equal(seeds[0]?.address, "semilla@gmail.com", "la dirección se normaliza");
  assert.equal(descifrarSemilla(seeds[0]!, ENV), "hunter2-app-password", "y se recupera para conectarse");
});

test("el AAD ata el secreto a SU semilla: copiarlo a otra dirección no descifra", async () => {
  const workspace = await ws();
  await agregarSemilla({ workspace, env: ENV, address: "a@gmail.com", provider: "gmail", secret: "clave-de-a" });
  const { seeds } = await leerSemillas(workspace);
  const robada = { ...seeds[0]!, address: "otra@gmail.com" };
  assert.throws(() => descifrarSemilla(robada, ENV), "el payload no sirve en otra semilla");
});

test("agregar dos veces la misma dirección REEMPLAZA, no duplica", async () => {
  const workspace = await ws();
  await agregarSemilla({ workspace, env: ENV, address: "a@gmail.com", provider: "gmail", secret: "vieja" });
  await agregarSemilla({ workspace, env: ENV, address: "A@GMAIL.COM", provider: "gmail", secret: "nueva" });
  const { seeds } = await leerSemillas(workspace);
  assert.equal(seeds.length, 1, "una sola entrada por dirección");
  assert.equal(descifrarSemilla(seeds[0]!, ENV), "nueva", "gana la rotación más reciente");
});

test("una semilla sin app password se rechaza (no sirve de nada)", async () => {
  const workspace = await ws();
  await assert.rejects(
    () => agregarSemilla({ workspace, env: ENV, address: "a@gmail.com", provider: "gmail", secret: "" }),
    WarmupSeedError
  );
});

test("proveedor y dirección se validan; el IMAP sale del proveedor si no se pisa", () => {
  assert.throws(() => validarSemillaNueva({ address: "no-es-mail", provider: "gmail" }), /direccion invalida/);
  assert.throws(() => validarSemillaNueva({ address: "a@b.com", provider: "hotmail" }), /proveedor invalido/);
  assert.deepEqual(validarSemillaNueva({ address: "a@b.com", provider: "yahoo" }).imap, {
    host: "imap.mail.yahoo.com",
    port: 993
  });
  // Outlook/Hotmail entran como `outlook`: es el mismo IMAP.
  assert.equal(validarSemillaNueva({ address: "a@b.com", provider: "outlook" }).imap.host, "outlook.office365.com");
  assert.equal(validarSemillaNueva({ address: "a@b.com", provider: "gmail", imapHost: "otro.host" }).imap.host, "otro.host");
  assert.throws(() => validarSemillaNueva({ address: "a@b.com", provider: "gmail", imapPort: 0 }), /puerto IMAP/);
});

test("apagar una semilla NO la borra, y se puede reactivar", async () => {
  const workspace = await ws();
  await agregarSemilla({ workspace, env: ENV, address: "a@gmail.com", provider: "gmail", secret: "k" });

  assert.equal(await marcarSemilla({ workspace, address: "a@gmail.com", enabled: false }), true);
  const apagada = await leerSemillas(workspace);
  assert.equal(apagada.seeds.length, 1, "sigue en el registro");
  assert.equal(semillasActivas(apagada.seeds).length, 0, "pero no se usa para calentar");

  await marcarSemilla({ workspace, address: "a@gmail.com", enabled: true });
  assert.equal(semillasActivas((await leerSemillas(workspace)).seeds).length, 1);
});

test("marcar una dirección que no está devuelve false en vez de inventar la semilla", async () => {
  const workspace = await ws();
  assert.equal(await marcarSemilla({ workspace, address: "fantasma@gmail.com", enabled: false }), false);
});

test("sin registro: lista vacía Y el flag que lo distingue de 'todas apagadas'", async () => {
  const { seeds, existeRegistro } = await leerSemillas(await ws());
  assert.deepEqual(seeds, []);
  assert.equal(existeRegistro, false, "'nunca se creó' no es 'existe y está vacío'");
});

test("la rotación reparte entre semillas y no le pega siempre a la misma", () => {
  const seeds = [seed({ address: "a@gmail.com" }), seed({ address: "b@yahoo.com", provider: "yahoo" }), seed({ address: "c@outlook.com", provider: "outlook" })];
  const usadas = new Set<string>();
  for (let vuelta = 0; vuelta < 9; vuelta += 1) usadas.add(elegirSemilla(seeds, "dominio.com", vuelta)!.address);
  assert.equal(usadas.size, 3, "un dominio recorre TODAS las semillas: si no, no mide otros proveedores");

  // Y dos dominios en la misma vuelta no caen siempre en la misma casilla (desfase por dominio).
  const distintos = new Set(
    ["uno.com", "dos.com", "tres.com", "cuatro.com"].map((d) => elegirSemilla(seeds, d, 0)!.address)
  );
  assert.ok(distintos.size > 1, "los nodos no golpean todos a la misma semilla en la misma vuelta");
});

test("la rotación ignora las apagadas y devuelve null si no queda ninguna", () => {
  const seeds = [seed({ address: "viva@gmail.com" }), seed({ address: "muerta@gmail.com", enabled: false })];
  for (let v = 0; v < 5; v += 1) assert.equal(elegirSemilla(seeds, "x.com", v)?.address, "viva@gmail.com");
  assert.equal(elegirSemilla([seed({ enabled: false })], "x.com", 0), null, "sin semillas activas NO se inventa una");
  assert.equal(elegirSemilla([], "x.com", 0), null);
});

test("la cobertura por proveedor delata el punto ciego (todo Gmail = no sabés de Outlook)", () => {
  const soloGmail = [seed({ address: "a@gmail.com" }), seed({ address: "b@gmail.com" })];
  assert.deepEqual(coberturaPorProveedor(soloGmail), { gmail: 2 });
  const variado = [...soloGmail, seed({ address: "c@yahoo.com", provider: "yahoo" })];
  assert.deepEqual(coberturaPorProveedor(variado), { gmail: 2, yahoo: 1 });
});

test("verifiedAt se sella con el probe: una semilla sin verificar se distingue", async () => {
  const workspace = await ws();
  await agregarSemilla({ workspace, env: ENV, address: "a@gmail.com", provider: "gmail", secret: "k", now: () => ahora });
  assert.equal((await leerSemillas(workspace)).seeds[0]?.verifiedAt, null, "nace sin verificar");
  await marcarVerificada({ workspace, address: "a@gmail.com", now: () => ahora });
  assert.equal((await leerSemillas(workspace)).seeds[0]?.verifiedAt, ahora.toISOString());
});
