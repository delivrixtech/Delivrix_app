import test from "node:test";
import assert from "node:assert/strict";
import { createGithubClient } from "./client.ts";
import { COMMENT_MARKER } from "../report/render.ts";

type Call = { url: string; method: string; headers: any; body: any };

function res(status: number, body: unknown, isText = false): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (isText ? String(body) : JSON.stringify(body))
  };
}

function recorder(handler: (call: Call) => any): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("upsertMarkerComment crea un comentario cuando no existe el marcador", async () => {
  const { fetchImpl, calls } = recorder((call) => {
    if (call.url.includes("/comments") && call.method === "GET") {
      return res(200, []);
    }
    return res(201, {});
  });
  const client = createGithubClient({ token: "t", owner: "o", repo: "r", fetchImpl });
  const result = await client.upsertMarkerComment(42, COMMENT_MARKER, "cuerpo");
  assert.equal(result, "created");
  const post = calls.find((c) => c.method === "POST");
  assert.ok(post);
  assert.ok(post?.url.includes("/issues/42/comments"));
});

test("upsertMarkerComment actualiza el comentario existente del bot", async () => {
  const { fetchImpl, calls } = recorder((call) => {
    if (call.url.includes("/comments") && call.method === "GET") {
      return res(200, [{ id: 5, body: `reporte previo ${COMMENT_MARKER}` }]);
    }
    return res(200, {});
  });
  const client = createGithubClient({ token: "t", owner: "o", repo: "r", fetchImpl });
  const result = await client.upsertMarkerComment(42, COMMENT_MARKER, "nuevo");
  assert.equal(result, "updated");
  const patch = calls.find((c) => c.method === "PATCH");
  assert.ok(patch?.url.includes("/issues/comments/5"));
});

test("getPullRequestDiff pide el media type de diff", async () => {
  const { fetchImpl, calls } = recorder(() => res(200, "diff text", true));
  const client = createGithubClient({ token: "t", owner: "o", repo: "r", fetchImpl });
  const diff = await client.getPullRequestDiff(7);
  assert.equal(diff, "diff text");
  assert.equal(calls[0].headers.accept, "application/vnd.github.diff");
  assert.equal(calls[0].headers["x-github-api-version"], "2022-11-28");
});

test("request reintenta ante 5xx y luego tiene exito", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    return n === 1 ? res(500, {}) : res(200, []);
  }) as unknown as typeof fetch;
  const client = createGithubClient({
    token: "t",
    owner: "o",
    repo: "r",
    fetchImpl,
    sleep: async () => {}
  });
  const comments = await client.listIssueComments(1);
  assert.deepEqual(comments, []);
  assert.equal(n, 2);
});
