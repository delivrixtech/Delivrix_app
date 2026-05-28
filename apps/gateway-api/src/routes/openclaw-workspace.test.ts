import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import {
  handleOpenClawWorkspaceError,
  handleOpenClawWorkspaceFileHttp,
  handleOpenClawWorkspaceTreeHttp,
  WorkspaceReadRateLimiter
} from "./openclaw-workspace.ts";

test("GET /v1/openclaw/workspace/tree lists live workspace nodes", async () => {
  const route = await routeHarness();
  await seedWorkspace(route.rootDir);

  const response = await route.tree("/");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.path, "/");
  assert.equal(response.body.source.kind, "live");
  assert.equal(response.body.source.trusted, true);
  assert.deepEqual(response.body.nodes.map((node: { name: string }) => node.name), [
    "executions",
    "inventory",
    "learnings",
    "skills"
  ]);
});

test("GET /v1/openclaw/workspace/tree hides sensitive key material", async () => {
  const route = await routeHarness();
  await seedWorkspace(route.rootDir);

  const response = await route.tree("/inventory");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.nodes.map((node: { name: string }) => node.name), ["domains.json"]);
});

test("GET /v1/openclaw/workspace/file returns file content and audits read", async () => {
  const route = await routeHarness();
  await seedWorkspace(route.rootDir);

  const response = await route.file("/executions/2026-05-28/010215-register_domain_route53-demo-success.md");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.path, "/executions/2026-05-28/010215-register_domain_route53-demo-success.md");
  assert.equal(response.body.mimeType, "text/markdown");
  assert.equal(response.body.content, "# register domain\n\nok\n");
  assert.equal(response.body.size, Buffer.byteLength("# register domain\n\nok\n"));

  const events = await route.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.workspace.read_file");
  assert.equal(events.at(-1)?.actorId, "operator-via-panel");
  assert.equal(events.at(-1)?.targetId, "/executions/2026-05-28/010215-register_domain_route53-demo-success.md");
});

test("GET /v1/openclaw/workspace/file blocks traversal", async () => {
  const route = await routeHarness();
  await seedWorkspace(route.rootDir);

  const response = await route.file("/../../etc/passwd");

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_path");
});

test("GET /v1/openclaw/workspace/file blocks direct sensitive files", async () => {
  const route = await routeHarness();
  await seedWorkspace(route.rootDir);

  const response = await route.file("/inventory/dkim-keys/example/default.private");

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "forbidden_path");
});

test("GET /v1/openclaw/workspace/file blocks files over size cap", async () => {
  const route = await routeHarness({ maxFileBytes: 16 });
  await seedWorkspace(route.rootDir);

  const response = await route.file("/executions/2026-05-28/010215-register_domain_route53-demo-success.md");

  assert.equal(response.statusCode, 413);
  assert.equal(response.body.error, "file_too_large");
});

test("GET /v1/openclaw/workspace/tree rate limits repeated reads", async () => {
  const route = await routeHarness({
    rateLimiter: new WorkspaceReadRateLimiter(1, 60_000, () => 1_000)
  });
  await seedWorkspace(route.rootDir);

  assert.equal((await route.tree("/")).statusCode, 200);
  const second = await route.tree("/");

  assert.equal(second.statusCode, 429);
  assert.equal(second.body.error, "rate_limited");
});

async function routeHarness(options: {
  maxFileBytes?: number;
  rateLimiter?: WorkspaceReadRateLimiter;
} = {}): Promise<{
  rootDir: string;
  auditLog: LocalFileAuditLog;
  tree: (path: string) => Promise<{ statusCode: number; body: any }>;
  file: (path: string) => Promise<{ statusCode: number; body: any }>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "delivrix-openclaw-workspace-"));
  const auditLog = new LocalFileAuditLog(join(rootDir, "audit.jsonl"));
  return {
    rootDir,
    auditLog,
    tree: (path) => runRoute(
      (request, response) => handleOpenClawWorkspaceTreeHttp({
        request,
        response,
        auditLog,
        rootDir,
        maxFileBytes: options.maxFileBytes,
        rateLimiter: options.rateLimiter
      }),
      {
        method: "GET",
        url: `/v1/openclaw/workspace/tree?path=${encodeURIComponent(path)}`
      }
    ),
    file: (path) => runRoute(
      (request, response) => handleOpenClawWorkspaceFileHttp({
        request,
        response,
        auditLog,
        rootDir,
        maxFileBytes: options.maxFileBytes,
        rateLimiter: options.rateLimiter
      }),
      {
        method: "GET",
        url: `/v1/openclaw/workspace/file?path=${encodeURIComponent(path)}`
      }
    )
  };
}

async function seedWorkspace(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, "executions", "2026-05-28"), { recursive: true });
  await mkdir(join(rootDir, "inventory", "dkim-keys", "example"), { recursive: true });
  await mkdir(join(rootDir, "learnings"), { recursive: true });
  await mkdir(join(rootDir, "skills"), { recursive: true });
  await writeFile(
    join(rootDir, "executions", "2026-05-28", "010215-register_domain_route53-demo-success.md"),
    "# register domain\n\nok\n",
    "utf8"
  );
  await writeFile(join(rootDir, "inventory", "domains.json"), "{\"domains\":[]}\n", "utf8");
  await writeFile(join(rootDir, "inventory", "dkim-keys", "example", "default.private"), "secret", "utf8");
}

async function runRoute(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  }
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  const request = requestWithBody(input);
  try {
    await handler(request, response as unknown as ServerResponse);
  } catch (error) {
    if (!handleOpenClawWorkspaceError(error, response as unknown as ServerResponse)) {
      throw error;
    }
  }
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

function requestWithBody(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const request = Readable.from([]) as IncomingMessage;
  request.method = input.method;
  request.url = input.url;
  request.headers = input.headers ?? {};
  return request;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}
