import assert from "node:assert/strict";
import test from "node:test";
import { createZipArchive } from "./zip-archive.ts";
import { readZipEntries } from "./zip-archive.test-helpers.ts";

const fixedNow = new Date("2026-06-22T14:00:00.000Z");

test("createZipArchive escribe entradas legibles con nombre y contenido intactos", () => {
  const archive = createZipArchive(
    [
      { name: "uno.md", content: "# uno\n" },
      { name: "dos.md", content: "# dos con acentos: ñáé\n" }
    ],
    fixedNow
  );

  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const entries = readZipEntries(archive);
  assert.deepEqual(entries.map((entry) => entry.name), ["uno.md", "dos.md"]);
  assert.equal(entries[0]?.content, "# uno\n");
  assert.equal(entries[1]?.content, "# dos con acentos: ñáé\n");
});

test("createZipArchive comprime cuando conviene y guarda plano cuando no", () => {
  const repetitive = "credencial\n".repeat(500);
  const archive = createZipArchive(
    [
      { name: "grande.md", content: repetitive },
      { name: "corto.md", content: "x" }
    ],
    fixedNow
  );

  const entries = readZipEntries(archive);
  const grande = entries.find((entry) => entry.name === "grande.md");
  const corto = entries.find((entry) => entry.name === "corto.md");
  assert.equal(grande?.method, 8);
  assert.equal(grande?.content, repetitive);
  // Deflate agranda un archivo de 1 byte, así que ese va sin comprimir.
  assert.equal(corto?.method, 0);
  assert.equal(corto?.content, "x");
  assert.ok(archive.length < repetitive.length);
});

test("createZipArchive desambigua nombres repetidos en vez de perder entradas", () => {
  const archive = createZipArchive(
    [
      { name: "smtp.md", content: "primero" },
      { name: "smtp.md", content: "segundo" }
    ],
    fixedNow
  );

  const entries = readZipEntries(archive);
  assert.deepEqual(entries.map((entry) => entry.name), ["smtp.md", "smtp-2.md"]);
  assert.equal(entries[1]?.content, "segundo");
});

test("createZipArchive aplana rutas y no deja escapar con ..", () => {
  const archive = createZipArchive(
    [{ name: "../../etc/passwd.md", content: "no" }],
    fixedNow
  );

  const entries = readZipEntries(archive);
  assert.equal(entries[0]?.name, "etc_passwd.md");
});

test("createZipArchive conserva dígitos y guiones del dominio en el nombre", () => {
  const archive = createZipArchive(
    [{ name: "smtp-credentials-delivrix-mail3.com.md", content: "ok" }],
    fixedNow
  );

  const entries = readZipEntries(archive);
  assert.equal(entries[0]?.name, "smtp-credentials-delivrix-mail3.com.md");
});

test("createZipArchive produce un archivo vacío válido", () => {
  const archive = createZipArchive([], fixedNow);
  assert.deepEqual(readZipEntries(archive), []);
});
