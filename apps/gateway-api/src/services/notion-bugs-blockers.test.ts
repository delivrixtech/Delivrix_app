import assert from "node:assert/strict";
import test from "node:test";

import {
  createBugsBlockersEntry,
  createNotionBugsBlockersDepsFromEnv,
  DEFAULT_BUGS_BLOCKERS_DATABASE_ID,
  type BugsBlockersEntry
} from "./notion-bugs-blockers.ts";

const entry: BugsBlockersEntry = {
  issueTitle: "[auto] mail.acme.com — bounce rate 8.0% supera 5.0%",
  category: "Flagged Server",
  severity: "High",
  affectedServer: "mail.acme.com",
  description: "Health agent: bounce rate 8.0% supera el umbral 5.0%.",
  reportedDate: "2026-07-06"
};

test("sin NOTION_API_KEY se omite el side-effect (patron decision-skip-notion)", async () => {
  const result = await createBugsBlockersEntry(entry, { apiKey: undefined });
  assert.deepEqual(result, { ok: false, skipped: true, reason: "notion_api_key_missing" });
});

test("arma el payload exacto del Flow 3 del Agent Integration Guide", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: "page-789", url: "https://notion.so/page-789" }), { status: 200 });
  }) as typeof fetch;

  const result = await createBugsBlockersEntry(entry, { apiKey: "secret_test", fetchImpl });

  assert.deepEqual(result, { ok: true, pageId: "page-789", url: "https://notion.so/page-789" });
  assert.equal(calls.length, 1);
  const captured = calls[0];
  assert.equal(captured.url, "https://api.notion.com/v1/pages");
  const headers = captured.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer secret_test");
  assert.equal(headers["Notion-Version"], "2022-06-28");

  const payload = JSON.parse(String(captured.init.body));
  assert.equal(payload.parent.database_id, DEFAULT_BUGS_BLOCKERS_DATABASE_ID);
  assert.equal(payload.properties["Issue"].title[0].text.content, entry.issueTitle);
  assert.deepEqual(payload.properties["Status"], { select: { name: "Open" } });
  assert.deepEqual(payload.properties["Severity"], { select: { name: "High" } });
  assert.deepEqual(payload.properties["Category"], { select: { name: "Flagged Server" } });
  assert.equal(payload.properties["Affected Server"].rich_text[0].text.content, "mail.acme.com");
  assert.deepEqual(payload.properties["Reported Date"], { date: { start: "2026-07-06" } });
  assert.deepEqual(payload.properties["Reported By"], { select: { name: "Agent" } });
  assert.deepEqual(payload.properties["Agent Flagged"], { checkbox: true });
});

test("propaga errores HTTP de Notion sin lanzar", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ code: "validation_error" }), { status: 400 })) as typeof fetch;

  const result = await createBugsBlockersEntry(entry, { apiKey: "secret_test", fetchImpl });

  assert.equal(result.ok, false);
  assert.equal("skipped" in result && result.skipped, false);
  if (!result.ok && !result.skipped) {
    assert.equal(result.status, 400);
    assert.match(result.error, /validation_error/);
  }
});

test("deps desde env usan el database id de Bugs & Blockers por defecto", () => {
  const deps = createNotionBugsBlockersDepsFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(deps.apiKey, undefined);
  assert.equal(deps.databaseId, DEFAULT_BUGS_BLOCKERS_DATABASE_ID);

  const custom = createNotionBugsBlockersDepsFromEnv({
    NOTION_API_KEY: " secret_x ",
    NOTION_BUGS_BLOCKERS_DB_ID: "custom-db"
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(custom.apiKey, "secret_x");
  assert.equal(custom.databaseId, "custom-db");
});
