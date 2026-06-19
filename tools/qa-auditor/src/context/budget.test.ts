import test from "node:test";
import assert from "node:assert/strict";
import { classifyPath, buildBoundedDiff } from "./budget.ts";
import type { ChangedFile } from "../github/client.ts";

test("classifyPath reconoce categorias clave", () => {
  assert.equal(classifyPath("package-lock.json"), "lockfile");
  assert.equal(classifyPath("package.json"), "dependency-manifest");
  assert.equal(classifyPath("apps/gateway-api/src/main.ts"), "source");
  assert.equal(classifyPath("assets/logo.png"), "binary");
  assert.equal(classifyPath("dist/bundle.js"), "generated");
  assert.equal(classifyPath("app.min.js"), "generated");
  assert.equal(classifyPath("config/gateway.yaml"), "config");
});

function file(partial: Partial<ChangedFile> & { filename: string }): ChangedFile {
  return {
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    ...partial
  };
}

test("buildBoundedDiff omite binarios, generados y archivos sin patch", () => {
  const files: ChangedFile[] = [
    file({ filename: "assets/logo.png", patch: "binario" }),
    file({ filename: "dist/bundle.js", patch: "generado" }),
    file({ filename: "src/c.ts", patch: "@@ -1 +1 @@\n-old\n+new" }),
    file({ filename: "src/d.ts", patch: undefined })
  ];
  const bounded = buildBoundedDiff(files, { maxDiffBytes: 100_000, maxFilePatchBytes: 24_000 });

  assert.deepEqual(bounded.includedFiles, ["src/c.ts"]);
  const reasons = Object.fromEntries(bounded.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons["assets/logo.png"], "binary");
  assert.equal(reasons["dist/bundle.js"], "generated");
  assert.equal(reasons["src/d.ts"], "sin-patch");
});

test("buildBoundedDiff trunca lockfiles de forma agresiva", () => {
  const files: ChangedFile[] = [file({ filename: "package-lock.json", patch: "L".repeat(5000) })];
  const bounded = buildBoundedDiff(files, { maxDiffBytes: 100_000, maxFilePatchBytes: 24_000 });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.includes("[patch truncado"));
  // header + <= 2000 de patch + sufijo de truncado: muy por debajo de 5000.
  assert.ok(bounded.text.length < 3000);
});

test("buildBoundedDiff respeta el presupuesto global de bytes", () => {
  const files: ChangedFile[] = [
    file({ filename: "src/a.ts", patch: "A".repeat(900) }),
    file({ filename: "src/b.ts", patch: "B".repeat(900) })
  ];
  const bounded = buildBoundedDiff(files, { maxDiffBytes: 1000, maxFilePatchBytes: 24_000 });
  assert.equal(bounded.truncated, true);
  // El segundo archivo no entra entero: o se trunca o se marca como omitido.
  assert.ok(bounded.includedFiles.length >= 1);
});
