import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { LiveArtifact } from "./live-tool-types.ts";

interface CanvasV5PreviewModule {
  ArtifactBody: React.ComponentType<{ artifact: LiveArtifact; raw: boolean }>;
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
