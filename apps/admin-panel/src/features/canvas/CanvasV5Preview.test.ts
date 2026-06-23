import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { LiveArtifact } from "./live-tool-types.ts";

interface CanvasV5PreviewModule {
  ArtifactBody: React.ComponentType<{ artifact: LiveArtifact; raw: boolean }>;
  canvasMessageKeyFromTaskId: (taskId: string) => string | null;
  selectPreviewArtifact: (candidate: LiveArtifact | null, artifacts: LiveArtifact[]) => LiveArtifact | null;
}

interface UiV2Module {
  OpenClawIntentProvider: React.ComponentType<{ children: React.ReactNode; onNavigate?: (section: string) => void }>;
  ToastProvider: React.ComponentType<{ children: React.ReactNode }>;
}

let server: ViteDevServer | null = null;

async function loadModules(): Promise<CanvasV5PreviewModule & UiV2Module> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  const canvas = await server.ssrLoadModule("/src/features/canvas/CanvasV5Preview.tsx") as CanvasV5PreviewModule;
  const ui = await server.ssrLoadModule("/src/shared/ui/v2/index.ts") as UiV2Module;
  return { ...canvas, ...ui };
}

after(async () => {
  await server?.close();
});

test("CanvasV5Preview renders SMTP credential artifact without leaking credential material", async () => {
  const { ArtifactBody, OpenClawIntentProvider, ToastProvider } = await loadModules();
  const artifact = makeArtifact({
    kind: "smtp_credential",
    title: "Credencial SMTP example-mail.com",
    payload: {
      kind: "smtp_credential",
      domain: "example-mail.com",
      host: "smtp.example-mail.com",
      username: "mailer@example-mail.com",
      ports: { submission: 587, smtps: 465 },
      hasCredential: true,
      password: "smtp-password-must-not-render",
      smtpCredentialEncrypted: {
        ciphertext: "ciphertext-must-not-render",
        authTag: "auth-tag-must-not-render"
      }
    } as any
  });

  const markup = renderToStaticMarkup(
    React.createElement(OpenClawIntentProvider, null,
      React.createElement(ToastProvider, null,
        React.createElement(ArtifactBody, { artifact, raw: false })
      )
    )
  );
  const rawMarkup = renderToStaticMarkup(React.createElement(ArtifactBody, { artifact, raw: true }));

  for (const surface of [markup, rawMarkup]) {
    assert.match(surface, /example-mail\.com/);
    assert.match(surface, /smtp\.example-mail\.com/);
    assert.match(surface, /mailer@example-mail\.com/);
    assert.doesNotMatch(surface, /smtp-password-must-not-render/);
    assert.doesNotMatch(surface, /ciphertext-must-not-render/);
    assert.doesNotMatch(surface, /auth-tag-must-not-render/);
  }
  assert.match(markup, /Descargar credencial/);
  assert.match(markup, /Ir a Sender Pool/);
});

test("CanvasV5Preview keeps unknown artifact kinds on the prose fallback", async () => {
  const { ArtifactBody } = await loadModules();
  const artifact = makeArtifact({
    kind: "report",
    title: "Reporte",
    blocks: [{ id: "block-1", order: 1, kind: "paragraph", content: "Fallback ok", editable: false, status: "complete" }]
  });

  const markup = renderToStaticMarkup(React.createElement(ArtifactBody, { artifact, raw: false }));

  assert.match(markup, /Fallback ok/);
});

test("CanvasV5Preview still renders the existing typed artifacts", async () => {
  const { ArtifactBody } = await loadModules();
  const artifacts: LiveArtifact[] = [
    makeArtifact({
      kind: "inventory",
      payload: {
        kind: "inventory",
        servers: [{ slug: "server10", domain: "example-mail.com", ipv4: "203.0.113.10", provider: "webdock", status: "running" }]
      }
    }),
    makeArtifact({
      kind: "blacklist_report",
      payload: {
        kind: "blacklist_report",
        target: "203.0.113.10",
        source: "mxtoolbox",
        evaluatedAt: "2026-06-23T00:00:00.000Z",
        checks: [{ list: "Spamhaus ZEN", status: "pass" }]
      }
    }),
    makeArtifact({
      kind: "dns_zone",
      payload: {
        kind: "dns_zone",
        domain: "example-mail.com",
        records: [{ name: "smtp.example-mail.com", type: "A", value: "203.0.113.10" }]
      }
    }),
    makeArtifact({
      kind: "smtp_run",
      payload: {
        kind: "smtp_run",
        runId: "run-1",
        identity: { domain: "example-mail.com", smtpHost: "smtp.example-mail.com" },
        steps: [{ step: 1, skill: "configure_postfix", status: "done", label: "Configurar Postfix" }]
      }
    })
  ];

  const markup = artifacts
    .map((artifact) => renderToStaticMarkup(React.createElement(ArtifactBody, { artifact, raw: false })))
    .join("\n");

  assert.match(markup, /server10/);
  assert.match(markup, /Spamhaus ZEN/);
  assert.match(markup, /smtp\.example-mail\.com/);
  assert.match(markup, /Configurar Postfix/);
});

test("CanvasV5Preview keeps the SMTP credential artifact visible over the same-message prose report", async () => {
  const { selectPreviewArtifact } = await loadModules();
  const msgId = "0c783c78-1111-4222-8333-123456789abc";
  const credential = makeArtifact({
    id: "smtp-credential-controlnational.com",
    taskId: `bedrock:${msgId}`,
    kind: "smtp_credential",
    title: "Credencial SMTP controlnational.com",
    createdAt: "2026-06-23T20:00:00.000Z",
    payload: {
      kind: "smtp_credential",
      domain: "controlnational.com",
      host: "smtp.controlnational.com",
      username: "mailer@controlnational.com",
      ports: { submission: 587, smtps: 465 },
      hasCredential: true
    }
  });
  const proseReport = makeArtifact({
    id: "artifact-chat-report",
    taskId: "chat-0c783c78-20260623200005",
    kind: "report",
    title: "SMTP AUTH configurada",
    createdAt: "2026-06-23T20:00:05.000Z",
    blocks: [{ id: "summary", order: 1, kind: "paragraph", content: "SMTP AUTH configurada.", editable: false, status: "complete" }]
  });

  assert.equal(selectPreviewArtifact(proseReport, [credential, proseReport]), credential);
});

test("CanvasV5Preview keeps a normal report when no SMTP credential sibling exists", async () => {
  const { selectPreviewArtifact } = await loadModules();
  const proseReport = makeArtifact({
    id: "artifact-normal-report",
    taskId: "chat-0c783c78-20260623200005",
    kind: "report",
    title: "Reporte normal",
    createdAt: "2026-06-23T20:00:05.000Z",
    blocks: [{ id: "summary", order: 1, kind: "paragraph", content: "Reporte normal.", editable: false, status: "complete" }]
  });

  assert.equal(selectPreviewArtifact(proseReport, [proseReport]), proseReport);
});

test("CanvasV5Preview does not promote old SMTP credential artifacts from other messages", async () => {
  const { selectPreviewArtifact } = await loadModules();
  const credential = makeArtifact({
    id: "smtp-credential-old",
    taskId: "bedrock:11111111-1111-4111-8111-111111111111",
    kind: "smtp_credential",
    createdAt: "2026-06-23T19:59:00.000Z",
    payload: {
      kind: "smtp_credential",
      domain: "old.example",
      host: "smtp.old.example",
      username: "mailer@old.example",
      ports: { submission: 587, smtps: 465 },
      hasCredential: true
    }
  });
  const unrelatedReport = makeArtifact({
    id: "artifact-current-report",
    taskId: "chat-22222222-20260623200005",
    kind: "report",
    createdAt: "2026-06-23T20:00:05.000Z",
    blocks: [{ id: "summary", order: 1, kind: "paragraph", content: "Reporte normal.", editable: false, status: "complete" }]
  });

  assert.equal(selectPreviewArtifact(unrelatedReport, [credential, unrelatedReport]), unrelatedReport);
});

test("CanvasV5Preview leaves non-report latest artifacts unchanged", async () => {
  const { selectPreviewArtifact } = await loadModules();
  const credential = makeArtifact({
    id: "smtp-credential-example.com",
    taskId: "bedrock:33333333-3333-4333-8333-333333333333",
    kind: "smtp_credential",
    payload: {
      kind: "smtp_credential",
      domain: "example.com",
      host: "smtp.example.com",
      username: "mailer@example.com",
      ports: { submission: 587, smtps: 465 },
      hasCredential: true
    }
  });
  const candidates: LiveArtifact[] = [
    makeArtifact({
      id: "inventory-webdock",
      taskId: "bedrock:33333333-3333-4333-8333-333333333333",
      kind: "inventory",
      payload: {
        kind: "inventory",
        servers: [{ slug: "server10", status: "running" }]
      }
    }),
    makeArtifact({
      id: "blacklist-report",
      taskId: "bedrock:33333333-3333-4333-8333-333333333333",
      kind: "blacklist_report",
      payload: {
        kind: "blacklist_report",
        target: "smtp.example.com",
        source: "mxtoolbox",
        evaluatedAt: "2026-06-23T20:00:00.000Z",
        checks: []
      }
    }),
    makeArtifact({
      id: "dns-zone",
      taskId: "bedrock:33333333-3333-4333-8333-333333333333",
      kind: "dns_zone",
      payload: {
        kind: "dns_zone",
        domain: "example.com",
        records: []
      }
    }),
    makeArtifact({
      id: "smtp-run",
      taskId: "bedrock:33333333-3333-4333-8333-333333333333",
      kind: "smtp_run",
      payload: {
        kind: "smtp_run",
        runId: "run-1",
        identity: { domain: "example.com" },
        steps: []
      }
    }),
    makeArtifact({ id: "plan", taskId: "bedrock:33333333-3333-4333-8333-333333333333", kind: "plan" }),
    makeArtifact({ id: "proposal", taskId: "bedrock:33333333-3333-4333-8333-333333333333", kind: "proposal" }),
    makeArtifact({ id: "template", taskId: "bedrock:33333333-3333-4333-8333-333333333333", kind: "template" })
  ];

  for (const candidate of candidates) {
    assert.equal(selectPreviewArtifact(candidate, [candidate, credential]), candidate);
  }
});

test("CanvasV5Preview extracts comparable message keys from Bedrock and chat task ids", async () => {
  const { canvasMessageKeyFromTaskId } = await loadModules();
  const msgId = "0C783C78-1111-4222-8333-123456789ABC";

  assert.equal(canvasMessageKeyFromTaskId(`bedrock:${msgId}`), "0c783c78");
  assert.equal(canvasMessageKeyFromTaskId("chat-0c783c78-20260623200005"), "0c783c78");
  assert.equal(canvasMessageKeyFromTaskId("chat-without-uuid"), null);
});

function makeArtifact(overrides: Partial<LiveArtifact>): LiveArtifact {
  return {
    id: "artifact-test",
    taskId: "task-test",
    kind: "report",
    title: "Artifact test",
    editable: false,
    approvalStatus: "pending",
    blocks: [],
    createdAt: "2026-06-23T00:00:00.000Z",
    ...overrides
  } as LiveArtifact;
}
