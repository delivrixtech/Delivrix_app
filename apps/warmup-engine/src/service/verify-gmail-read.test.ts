import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyGmailRead,
  type VerifyImapFlowCtor,
  type VerifyImapFlowLike
} from "./verify-gmail-read.ts";
import type { AccessTokenProvider } from "../live/google-oauth-token-provider.ts";

const ACCESS_TOKEN = "ya29.FAKE-VERIFY-TOKEN-do-not-leak";

function fakeProvider(): AccessTokenProvider {
  return {
    async getAccessToken() {
      return ACCESS_TOKEN;
    }
  };
}

function fakeCtor(cfg: {
  boxes: string[];
  statusByFolder: Record<string, { messages?: number; unseen?: number }>;
  seen: unknown[];
}): VerifyImapFlowCtor {
  return class implements VerifyImapFlowLike {
    constructor(config: unknown) {
      cfg.seen.push(config);
    }
    async connect(): Promise<void> {}
    async logout(): Promise<void> {}
    async list(): Promise<Array<{ path: string }>> {
      return cfg.boxes.map((path) => ({ path }));
    }
    async status(path: string): Promise<{ messages?: number; unseen?: number }> {
      return cfg.statusByFolder[path] ?? {};
    }
  };
}

test("verifyGmailRead: usa el accessToken, filtra carpetas relevantes y resume por carpeta", async () => {
  const seen: unknown[] = [];
  const logs: string[] = [];
  const result = await verifyGmailRead(
    { WARMUP_GMAIL_SEED_USER: "infradelivrixdemo@gmail.com", WARMUP_GMAIL_IMAP_HOST: "imap.gmail.com" },
    {
      tokenProvider: fakeProvider(),
      logger: { info: (m) => logs.push(m) },
      ImapFlow: fakeCtor({
        boxes: ["INBOX", "[Gmail]/Spam", "[Gmail]/Sent Mail", "[Gmail]/All Mail"],
        statusByFolder: {
          INBOX: { messages: 5, unseen: 2 },
          "[Gmail]/Spam": { messages: 1, unseen: 1 },
          "[Gmail]/All Mail": { messages: 9, unseen: 0 }
        },
        seen
      })
    }
  );

  // Auth XOAUTH2 con el token minteado; carpetas irrelevantes (Sent) excluidas.
  const cfg = seen[0] as { auth: { user: string; accessToken: string } };
  assert.equal(cfg.auth.accessToken, ACCESS_TOKEN);
  assert.equal(cfg.auth.user, "infradelivrixdemo@gmail.com");

  assert.equal(result.connected, true);
  assert.deepEqual(
    result.folders.map((f) => f.path).sort(),
    ["INBOX", "[Gmail]/All Mail", "[Gmail]/Spam"]
  );
  const inbox = result.folders.find((f) => f.path === "INBOX");
  assert.equal(inbox?.messages, 5);
  assert.equal(inbox?.unseen, 2);

  // NINGUNA línea de log debe filtrar el token.
  assert.ok(logs.every((l) => !l.includes(ACCESS_TOKEN)), "el resumen no debe imprimir el access token");
  assert.ok(logs.some((l) => l.includes("CERO correo enviado")));
});
