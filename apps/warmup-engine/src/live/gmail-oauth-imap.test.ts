import assert from "node:assert/strict";
import test from "node:test";

import {
  createGmailOAuthImapClient,
  type ImapFetchLike,
  type ImapFlowCtor,
  type ImapFlowLike,
  type MailboxLockLike
} from "./mail-adapters.ts";
import type { AccessTokenProvider } from "./google-oauth-token-provider.ts";

const ACCESS_TOKEN = "ya29.FAKE-ACCESS-TOKEN-do-not-leak";

/** Provider fake: cuenta llamadas y devuelve un token reconocible (para detectar leaks/uso). */
function fakeProvider(): AccessTokenProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async getAccessToken() {
      state.calls += 1;
      return ACCESS_TOKEN;
    }
  };
}

/** Constructor ImapFlow fake para el CLIENT del reader (list/search/fetchAll por carpeta). */
function fakeImapClientCtor(cfg: {
  gmail: boolean;
  boxes: string[];
  searchByFolder: Record<string, number[]>;
  fetchByFolder: Record<string, ImapFetchLike[]>;
  events: string[];
  seen: unknown[];
}): ImapFlowCtor {
  return class implements ImapFlowLike {
    capabilities = new Map<string, boolean>(cfg.gmail ? [["X-GM-EXT-1", true]] : []);
    private current = "";
    constructor(config: unknown) {
      cfg.seen.push(config);
    }
    async connect(): Promise<void> {
      cfg.events.push("connect");
    }
    async logout(): Promise<void> {
      cfg.events.push("logout");
    }
    async list(): Promise<Array<{ path: string }>> {
      return cfg.boxes.map((path) => ({ path }));
    }
    async getMailboxLock(path: string): Promise<MailboxLockLike> {
      this.current = path;
      cfg.events.push(`open:${path}`);
      return { release: () => cfg.events.push(`release:${path}`) };
    }
    async search(): Promise<number[] | false> {
      return cfg.searchByFolder[this.current] ?? [];
    }
    async fetchAll(): Promise<ImapFetchLike[]> {
      return cfg.fetchByFolder[this.current] ?? [];
    }
  };
}

function headerBlock(testId: string): string {
  return `From: sender@warmup.test\r\nSubject: hi\r\nX-Delivrix-Test-Id: ${testId}\r\n`;
}

test("OAuth Gmail ImapClient: pasa accessToken + user (forma XOAUTH2, sin `type`) y clasifica por labels", async () => {
  const seen: unknown[] = [];
  const events: string[] = [];
  const provider = fakeProvider();
  const client = createGmailOAuthImapClient(
    provider,
    { host: "imap.gmail.com", user: "infradelivrixdemo@gmail.com" },
    {
      ImapFlow: fakeImapClientCtor({
        gmail: true,
        boxes: ["INBOX", "[Gmail]/All Mail", "[Gmail]/Spam"],
        searchByFolder: { "[Gmail]/All Mail": [10] },
        fetchByFolder: {
          "[Gmail]/All Mail": [
            { headers: headerBlock("g-1"), labels: new Set<string>(["\\Inbox", "CATEGORY_PROMOTIONS"]) }
          ]
        },
        events,
        seen
      })
    }
  );

  const msgs = await client.search({ headerName: "X-Delivrix-Test-Id", headerValue: "g-1" });

  // Auth XOAUTH2: user + accessToken presentes, SIN `type` (forma imapflow).
  const cfg = seen[0] as { host: string; port: number; auth: { user: string; accessToken: string; type?: string } };
  assert.equal(cfg.host, "imap.gmail.com");
  assert.equal(cfg.port, 993);
  assert.equal(cfg.auth.user, "infradelivrixdemo@gmail.com");
  assert.equal(cfg.auth.accessToken, ACCESS_TOKEN);
  assert.equal(cfg.auth.type, undefined);
  assert.equal(provider.calls, 1);

  // Devuelve ImapMessages clasificables (gmailRaw + labels ⇒ el reader clasifica por labels).
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].folder, "[Gmail]/All Mail");
  assert.equal(msgs[0].gmailRaw, true);
  assert.deepEqual(msgs[0].gmailLabels, ["\\Inbox", "CATEGORY_PROMOTIONS"]);
  assert.equal(msgs[0].headers["X-Delivrix-Test-Id"], "g-1");
  // Recorrió carpetas y cerró sesión.
  assert.equal(events[events.length - 1], "logout");
});

test("OAuth Gmail ImapClient: no-Gmail ⇒ mapea por carpeta (sin labels)", async () => {
  const client = createGmailOAuthImapClient(
    fakeProvider(),
    { host: "imap.other.test", user: "seed@other.test", folders: ["INBOX", "Junk"] },
    {
      ImapFlow: fakeImapClientCtor({
        gmail: false,
        boxes: ["INBOX", "Junk"],
        searchByFolder: { Junk: [2] },
        fetchByFolder: { Junk: [{ headers: headerBlock("n-1") }] },
        events: [],
        seen: []
      })
    }
  );

  const msgs = await client.search({ headerName: "X-Delivrix-Test-Id", headerValue: "n-1" });

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].folder, "Junk");
  assert.equal(msgs[0].gmailRaw, undefined);
  assert.equal(msgs[0].gmailLabels, undefined);
});
