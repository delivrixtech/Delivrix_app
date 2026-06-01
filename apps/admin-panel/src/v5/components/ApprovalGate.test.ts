/**
 * ApprovalGate tests — node:test + renderToStaticMarkup + signProposal puro.
 *
 * El repo no usa vitest ni React Testing Library. Patrón canónico
 * (ver `ChatWidget.test.ts`): vite ssrLoadModule + renderToStaticMarkup.
 * Para interacciones (timer, click, fetch) testeamos la función pura
 * `signProposal` y aserciones sobre markup inicial / con props.
 *
 * Cobertura (≥ 8 casos):
 *  1. Render inicial muestra el dryRunSummary.
 *  2. Botón "Firmar y ejecutar" inicialmente disabled (timer > 0).
 *  3. minReadSeconds=0 + sin gates blocked → botón habilitado.
 *  4. Con gate blocked → botón disabled aún con minReadSeconds=0.
 *  5. signProposal envía POST con actorId + signature al endpoint correcto.
 *  6. signProposal devuelve signatureId / signedAt cuando ok.
 *  7. signProposal throw cuando HTTP no-ok (con message del payload).
 *  8. Botón "Rechazar" presente y accesible.
 *  9. MonoCode renderiza el auditId.
 * 10. Categoría supervised_local_state aplica tone warning + label correcto.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createServer, type ViteDevServer } from "vite";

type Gate = {
  id: string;
  label: string;
  status: "ok" | "pending" | "blocked";
  responsable?: string;
};

type ApprovalGateModule = {
  ApprovalGate: ComponentType<{
    auditId: string;
    category:
      | "allowed_read_only"
      | "allowed_dry_run"
      | "supervised_local_state"
      | "future_live_requires_new_phase";
    agentRole: string;
    dryRunSummary: string;
    gates: Gate[];
    proposedAt: string;
    actorId?: string;
    minReadSeconds?: number;
    onSigned?: (r: { signatureId: string; signedAt: string }) => void;
    onRejected?: (reason?: string) => void;
    onClose?: () => void;
    fetchImpl?: typeof fetch;
  }>;
  signProposal: (
    input: { auditId: string; actorId: string; signature: string },
    fetchImpl?: typeof fetch
  ) => Promise<{
    ok: boolean;
    signatureId?: string;
    signedAt?: string;
    message?: string;
  }>;
};

let server: ViteDevServer | null = null;

async function loadModule(): Promise<ApprovalGateModule> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server.ssrLoadModule(
    "/src/v5/components/ApprovalGate.tsx"
  ) as Promise<ApprovalGateModule>;
}

after(async () => {
  await server?.close();
});

function wrap(node: React.ReactElement): string {
  // QueryClient nuevo por test: aísla cache + evita warnings de useMutation
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client }, node)
  );
}

const baseProps = {
  auditId: "audit_abc123_def",
  category: "supervised_local_state" as const,
  agentRole: "dns-senior",
  dryRunSummary:
    "PLAN: crear A record envios.example.com → 1.2.3.4 (IONOS). Esperado: 2 cambios.",
  gates: [
    { id: "g1", label: "DNS write actuator listo", status: "ok" as const },
    { id: "g2", label: "Rollback script preparado", status: "ok" as const }
  ],
  proposedAt: "2026-05-29T15:00:00.000Z"
};

/* ============================================================
 * Render-level (SSR) tests
 * ============================================================ */

test("1. Renderiza con dryRunSummary visible", async () => {
  const { ApprovalGate } = await loadModule();
  const markup = wrap(
    React.createElement(ApprovalGate, {
      ...baseProps,
      minReadSeconds: 5
    })
  );
  assert.match(markup, /PLAN: crear A record envios\.example\.com/);
  assert.match(markup, /Dry-run propuesto por el agente/);
});

test("2. Botón 'Firmar y ejecutar' deshabilitado inicial (timer > 0)", async () => {
  const { ApprovalGate } = await loadModule();
  const markup = wrap(
    React.createElement(ApprovalGate, {
      ...baseProps,
      minReadSeconds: 5
    })
  );
  // Caption del timer visible
  assert.match(markup, /Botón habilita en 5s/);
  // Botón sign disabled
  const signBtnMatch = markup.match(/<button[^>]*data-testid="approval-gate-sign"[^>]*>/);
  assert.ok(signBtnMatch, "debe existir el botón firmar");
  assert.match(signBtnMatch[0], /\sdisabled(?:=|\s|>)/, "el botón firmar debe estar disabled mientras corre el timer");
  assert.match(markup, /Firmar y ejecutar/);
});

test("3. Con minReadSeconds=0 y gates ok el botón firmar NO está disabled", async () => {
  const { ApprovalGate } = await loadModule();
  const markup = wrap(
    React.createElement(ApprovalGate, {
      ...baseProps,
      minReadSeconds: 0
    })
  );
  assert.match(markup, /Lectura completa\. Podés firmar y ejecutar\./);
  // El botón sign no debe llevar el atributo disabled
  const signBtnMatch = markup.match(
    /<button[^>]*data-testid="approval-gate-sign"[^>]*>/
  );
  assert.ok(signBtnMatch, "debe existir el botón firmar");
  assert.doesNotMatch(
    signBtnMatch[0],
    /\sdisabled(?:=|\s|>)/,
    "con timer=0 y gates ok el botón firmar no puede estar disabled"
  );
});

test("4. Con gate status=blocked el botón firmar está deshabilitado aunque timer=0", async () => {
  const { ApprovalGate } = await loadModule();
  const markup = wrap(
    React.createElement(ApprovalGate, {
      ...baseProps,
      minReadSeconds: 0,
      gates: [
        { id: "g1", label: "DNS actuator listo", status: "ok" },
        { id: "g2", label: "Rollback no preparado", status: "blocked" }
      ]
    })
  );
  const signBtnMatch = markup.match(
    /<button[^>]*data-testid="approval-gate-sign"[^>]*>/
  );
  assert.ok(signBtnMatch);
  assert.match(
    signBtnMatch[0],
    /disabled/,
    "con un gate blocked el botón firmar debe estar disabled"
  );
  // Contador de gates refleja 1 bloqueado
  assert.match(markup, /1 ok · 1 bloqueados/);
});

test("8. Botón 'Rechazar' presente y accesible", async () => {
  const { ApprovalGate } = await loadModule();
  const markup = wrap(
    React.createElement(ApprovalGate, {
      ...baseProps,
      minReadSeconds: 0
    })
  );
  assert.match(
    markup,
    /<button[^>]*data-testid="approval-gate-reject"[^>]*>/
  );
  assert.match(markup, /Rechazar/);
});

test("9. MonoCode renderiza el auditId en header", async () => {
  const { ApprovalGate } = await loadModule();
  const markup = wrap(
    React.createElement(ApprovalGate, {
      ...baseProps,
      auditId: "audit_unique_xyz_999"
    })
  );
  assert.match(markup, /audit_unique_xyz_999/);
  // y va dentro de un MonoCode (font-mono class del primitive)
  assert.match(markup, /font-mono[^"]*"[^>]*>audit_unique_xyz_999/);
});

test("10. Categoría supervised_local_state aplica label + pill warning", async () => {
  const { ApprovalGate } = await loadModule();
  const markup = wrap(
    React.createElement(ApprovalGate, {
      ...baseProps,
      category: "supervised_local_state"
    })
  );
  assert.match(markup, /Supervised, requiere firma/);
  // pill tone warning emite bg-warning-soft (clase del primitive Pill)
  assert.match(markup, /bg-warning-soft/);
});

/* ============================================================
 * signProposal (pure) tests — fetch mock
 * ============================================================ */

test("5. signProposal POSTea al endpoint correcto con actorId + signature", async () => {
  const { signProposal } = await loadModule();
  let captured: { url: string; init?: RequestInit } | null = null;
  const fakeFetch: typeof fetch = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(
      JSON.stringify({
        ok: true,
        signatureId: "sig_abc",
        signedAt: "2026-05-29T15:00:05.000Z"
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  await signProposal(
    {
      auditId: "audit_xyz_123",
      actorId: "operator/juanes",
      signature: "operator/juanes@2026-05-29T15:00:00.000Z"
    },
    fakeFetch
  );
  if (!captured) {
    assert.fail("fetch debe haberse llamado");
  }
  const call: { url: string; init?: RequestInit } = captured;
  assert.equal(call.url, "/v1/openclaw/proposals/audit_xyz_123/sign");
  assert.equal(call.init?.method, "POST");
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  const body = JSON.parse(String(call.init?.body ?? "{}")) as {
    actorId: string;
    signature: string;
  };
  assert.equal(body.actorId, "operator/juanes");
  assert.match(body.signature, /^operator\/juanes@/);
});

test("6. signProposal devuelve signatureId + signedAt cuando HTTP ok", async () => {
  const { signProposal } = await loadModule();
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        ok: true,
        signatureId: "sig_zzz",
        signedAt: "2026-05-29T15:01:00.000Z"
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const result = await signProposal(
    {
      auditId: "audit_xyz",
      actorId: "operator/juanes",
      signature: "fake"
    },
    fakeFetch
  );
  assert.equal(result.ok, true);
  assert.equal(result.signatureId, "sig_zzz");
  assert.equal(result.signedAt, "2026-05-29T15:01:00.000Z");
});

test("7. signProposal throw con message del payload cuando HTTP 4xx", async () => {
  const { signProposal } = await loadModule();
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        message: "audit chain mismatch: expected hash H_prev"
      }),
      { status: 409, headers: { "content-type": "application/json" } }
    );
  await assert.rejects(
    () =>
      signProposal(
        {
          auditId: "audit_xyz",
          actorId: "operator/juanes",
          signature: "fake"
        },
        fakeFetch
      ),
    /audit chain mismatch/
  );
});

test("7b. signProposal lanza error genérico cuando el server no devuelve JSON", async () => {
  const { signProposal } = await loadModule();
  const fakeFetch: typeof fetch = async () =>
    new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain" }
    });
  await assert.rejects(
    () =>
      signProposal(
        {
          auditId: "audit_xyz",
          actorId: "operator/juanes",
          signature: "fake"
        },
        fakeFetch
      ),
    /Sign failed \(HTTP 500\)/
  );
});
