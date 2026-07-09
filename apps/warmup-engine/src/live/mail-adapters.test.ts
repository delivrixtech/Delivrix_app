import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodemailerSmtpAuthProbe,
  createImapflowAuthProbe,
  createImapflowClient,
  createNodemailerSmtpClient,
  type SecretResolver,
  type ResolvedSecret,
  type CreateTransportFn,
  type NodemailerTransportLike,
  type ImapFlowCtor,
  type ImapFlowLike,
  type ImapFetchLike,
  type MailboxLockLike
} from "./mail-adapters.ts";
import type { AuthProbeOptions } from "../checks/liveness-checks.ts";
import type { SmtpSendInfo } from "../runtime/transport.ts";

// ── Secret RECONOCIBLE: si aparece en cualquier detail/error, el adapter lo filtró ──────────────────
const SECRET_PASS = "SUPER-SECRET-PASS-8f3a-do-not-leak";
const SECRET_TOKEN = "ya29.SECRET-ACCESS-TOKEN-do-not-leak";

function passResolver(over: Partial<ResolvedSecret> = {}): SecretResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(secretRef: string): Promise<ResolvedSecret> {
      calls.push(secretRef);
      return { user: "seed@acme.com", pass: SECRET_PASS, ...over } as ResolvedSecret;
    }
  };
}

function smtpOpts(over: Partial<AuthProbeOptions> = {}): AuthProbeOptions {
  return { host: "smtp.acme.com", port: 587, user: "seed@acme.com", secretRef: "vault://acme/smtp", ...over };
}

// ── Fakes de red (NUNCA abren sockets) ──────────────────────────────────────────────────────────────

/** createTransport fake: captura la config recibida y usa hooks de verify/sendMail. */
function fakeCreateTransport(cfg: {
  onVerify?: () => Promise<boolean>;
  onSendMail?: (mail: unknown) => Promise<SmtpSendInfo>;
  seen: unknown[];
}): CreateTransportFn {
  return (config: unknown): NodemailerTransportLike => {
    cfg.seen.push(config);
    return {
      async verify(): Promise<boolean> {
        if (cfg.onVerify) return cfg.onVerify();
        return true;
      },
      async sendMail(mail: unknown): Promise<SmtpSendInfo> {
        if (cfg.onSendMail) return cfg.onSendMail(mail);
        return { messageId: "default" };
      }
    };
  };
}

/** Constructor ImapFlow fake para el PROBE (solo connect/logout). */
function fakeImapProbeCtor(cfg: {
  onConnect: () => Promise<void>;
  seen: unknown[];
  events: string[];
}): ImapFlowCtor {
  return class implements ImapFlowLike {
    constructor(config: unknown) {
      cfg.seen.push(config);
    }
    async connect(): Promise<void> {
      cfg.events.push("connect");
      return cfg.onConnect();
    }
    async logout(): Promise<void> {
      cfg.events.push("logout");
    }
    async list(): Promise<Array<{ path: string }>> {
      return [];
    }
    async getMailboxLock(): Promise<MailboxLockLike> {
      return { release() {} };
    }
    async search(): Promise<number[] | false> {
      return false;
    }
    async fetchAll(): Promise<ImapFetchLike[]> {
      return [];
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
      const release = () => cfg.events.push(`release:${path}`);
      return { release };
    }
    async search(): Promise<number[] | false> {
      return cfg.searchByFolder[this.current] ?? [];
    }
    async fetchAll(): Promise<ImapFetchLike[]> {
      return cfg.fetchByFolder[this.current] ?? [];
    }
  };
}

// Un error de red genérico (sin marca de auth) ⇒ el adapter DEBE propagarlo (throw).
function netError(code: string): Error & { code: string } {
  const e = new Error(`network fail ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

// ── Probe SMTP ─────────────────────────────────────────────────────────────────────────────────────

test("SMTP probe: verify OK ⇒ ok:true y pasa la credencial resuelta al transporter", async () => {
  const seen: unknown[] = [];
  const resolver = passResolver();
  const probe = createNodemailerSmtpAuthProbe(resolver, {
    createTransport: fakeCreateTransport({ seen, onVerify: async () => true })
  });

  const res = await probe.probe(smtpOpts());

  assert.equal(res.ok, true);
  assert.deepEqual(resolver.calls, ["vault://acme/smtp"]);
  // El adapter SÍ usa el secreto para autenticar (va en la config del transporter)…
  const cfg = seen[0] as { auth: { pass: string }; requireTLS: boolean; port: number };
  assert.equal(cfg.auth.pass, SECRET_PASS);
  assert.equal(cfg.requireTLS, true); // 587 ⇒ STARTTLS obligatorio.
  assert.equal(cfg.port, 587);
  // …pero NUNCA lo filtra al detail.
  assert.ok(!(res.detail ?? "").includes(SECRET_PASS));
});

test("SMTP probe: EAUTH ⇒ ok:false con detail SIN secreto (aunque el server lo eco-devuelva)", async () => {
  const seen: unknown[] = [];
  const probe = createNodemailerSmtpAuthProbe(passResolver(), {
    createTransport: fakeCreateTransport({
      seen,
      onVerify: async () => {
        // Peor caso: el server eco-devuelve el password en el mensaje de error.
        const e = new Error(`535 auth failed for user with pass=${SECRET_PASS}`) as Error & {
          code: string;
          responseCode: number;
        };
        e.code = "EAUTH";
        e.responseCode = 535;
        throw e;
      }
    })
  });

  const res = await probe.probe(smtpOpts());

  assert.equal(res.ok, false);
  assert.ok(res.detail && res.detail.length > 0);
  assert.ok(!res.detail.includes(SECRET_PASS), "el detail no debe filtrar el password");
});

test("SMTP probe: error de red ⇒ THROW (el checker lo tratará como unknown)", async () => {
  const seen: unknown[] = [];
  const probe = createNodemailerSmtpAuthProbe(passResolver(), {
    createTransport: fakeCreateTransport({
      seen,
      onVerify: async () => {
        throw netError("ECONNECTION");
      }
    })
  });

  await assert.rejects(() => probe.probe(smtpOpts()), /ECONNECTION|network fail/);
});

// ── Probe IMAP ─────────────────────────────────────────────────────────────────────────────────────

test("IMAP probe: connect OK ⇒ ok:true y hace logout", async () => {
  const events: string[] = [];
  const seen: unknown[] = [];
  const probe = createImapflowAuthProbe(passResolver(), {
    ImapFlow: fakeImapProbeCtor({ events, seen, onConnect: async () => {} })
  });

  const res = await probe.probe(smtpOpts({ port: 993, secretRef: "vault://acme/imap" }));

  assert.equal(res.ok, true);
  assert.deepEqual(events, ["connect", "logout"]);
  const cfg = seen[0] as { auth: { pass: string }; secure: boolean; port: number };
  assert.equal(cfg.auth.pass, SECRET_PASS);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.port, 993);
  assert.ok(!(res.detail ?? "").includes(SECRET_PASS));
});

test("IMAP probe: AuthenticationFailure ⇒ ok:false sin secreto, sin logout", async () => {
  const events: string[] = [];
  const probe = createImapflowAuthProbe(passResolver(), {
    ImapFlow: fakeImapProbeCtor({
      events,
      seen: [],
      onConnect: async () => {
        const e = new Error(`auth failed (pass=${SECRET_PASS})`) as Error & {
          authenticationFailed: boolean;
        };
        e.authenticationFailed = true;
        throw e;
      }
    })
  });

  const res = await probe.probe(smtpOpts({ port: 993 }));

  assert.equal(res.ok, false);
  assert.ok(res.detail && !res.detail.includes(SECRET_PASS));
  assert.deepEqual(events, ["connect"]); // no conectó ⇒ no logout.
});

test("IMAP probe: error de red ⇒ THROW", async () => {
  const probe = createImapflowAuthProbe(passResolver(), {
    ImapFlow: fakeImapProbeCtor({
      events: [],
      seen: [],
      onConnect: async () => {
        throw netError("ETIMEDOUT");
      }
    })
  });

  await assert.rejects(() => probe.probe(smtpOpts({ port: 993 })), /ETIMEDOUT|network fail/);
});

// ── ImapClient del reader ────────────────────────────────────────────────────────────────────────────

function headerBlock(testId: string, extra = ""): string {
  return `From: sender@warmup.test\r\nSubject: hi\r\nX-Delivrix-Test-Id: ${testId}\r\n${extra}`;
}

test("ImapClient (no-Gmail): recorre carpetas y mapea folder→ImapMessage con cabeceras parseadas", async () => {
  const events: string[] = [];
  const client = createImapflowClient(
    passResolver(),
    { host: "imap.acme.com", user: "seed@acme.com", secretRef: "vault://acme/imap", folders: ["INBOX", "Junk"] },
    {
      ImapFlow: fakeImapClientCtor({
        gmail: false,
        boxes: ["INBOX", "Junk"],
        searchByFolder: { INBOX: [1], Junk: [2] },
        fetchByFolder: {
          INBOX: [{ headers: headerBlock("t-123") }],
          Junk: [{ headers: headerBlock("t-123") }]
        },
        events,
        seen: []
      })
    }
  );

  const msgs = await client.search({ headerName: "X-Delivrix-Test-Id", headerValue: "t-123" });

  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].folder, "INBOX");
  assert.equal(msgs[1].folder, "Junk");
  // Cabecera oculta parseada (el reader la usa para el match exacto).
  assert.equal(msgs[0].headers["X-Delivrix-Test-Id"], "t-123");
  // No-Gmail ⇒ sin labels ni gmailRaw.
  assert.equal(msgs[0].gmailRaw, undefined);
  assert.equal(msgs[0].gmailLabels, undefined);
  // Abrió/soltó cada carpeta y cerró sesión.
  assert.ok(events.includes("open:INBOX") && events.includes("release:INBOX"));
  assert.ok(events.includes("open:Junk") && events.includes("release:Junk"));
  assert.equal(events[events.length - 1], "logout");
});

test("ImapClient (Gmail): marca gmailRaw y extrae X-GM-LABELS del Set", async () => {
  const client = createImapflowClient(
    passResolver(),
    { host: "imap.gmail.com", user: "seed@gmail.com", secretRef: "vault://acme/gmail" },
    {
      ImapFlow: fakeImapClientCtor({
        gmail: true,
        boxes: ["INBOX", "[Gmail]/All Mail", "[Gmail]/Spam"],
        searchByFolder: { "[Gmail]/All Mail": [10], "[Gmail]/Spam": [] },
        fetchByFolder: {
          "[Gmail]/All Mail": [
            { headers: headerBlock("g-9"), labels: new Set<string>(["\\Inbox", "CATEGORY_PROMOTIONS"]) }
          ]
        },
        events: [],
        seen: []
      })
    }
  );

  const msgs = await client.search({ headerName: "X-Delivrix-Test-Id", headerValue: "g-9" });

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].folder, "[Gmail]/All Mail");
  assert.equal(msgs[0].gmailRaw, true);
  assert.deepEqual(msgs[0].gmailLabels, ["\\Inbox", "CATEGORY_PROMOTIONS"]);
  assert.equal(msgs[0].headers["X-Delivrix-Test-Id"], "g-9");
});

// ── SmtpClient de envío ──────────────────────────────────────────────────────────────────────────────

test("SmtpClient: envía y devuelve messageId; no filtra el secreto y resuelve la referencia una vez", async () => {
  const seen: unknown[] = [];
  const sentMails: unknown[] = [];
  const resolver = passResolver();
  const smtp = createNodemailerSmtpClient(
    resolver,
    { host: "smtp.acme.com", port: 587, user: "seed@acme.com", secretRef: "vault://acme/smtp" },
    {
      createTransport: fakeCreateTransport({
        seen,
        onSendMail: async (mail) => {
          sentMails.push(mail);
          return { messageId: "<abc@acme>", response: "250 OK", accepted: ["to@x.com"], rejected: [] };
        }
      })
    }
  );

  const info1 = await smtp.sendMail({ from: "a@acme.com", to: "b@x.com", subject: "s", text: "body" });
  const info2 = await smtp.sendMail({ from: "a@acme.com", to: "c@x.com", subject: "s2", text: "body2" });

  assert.equal(info1.messageId, "<abc@acme>");
  assert.equal(info2.messageId, "<abc@acme>");
  assert.equal(sentMails.length, 2);
  // Transporter perezoso: se crea una sola vez ⇒ el secret se resuelve una sola vez.
  assert.equal(seen.length, 1);
  assert.equal(resolver.calls.length, 1);
  const cfg = seen[0] as { auth: { pass: string } };
  assert.equal(cfg.auth.pass, SECRET_PASS);
});

test("SmtpClient/probe: credencial por TOKEN (OAuth2) también viaja por referencia, sin filtrarse", async () => {
  const seen: unknown[] = [];
  const resolver: SecretResolver = {
    async resolve() {
      return { user: "seed@acme.com", accessToken: SECRET_TOKEN };
    }
  };
  const probe = createNodemailerSmtpAuthProbe(resolver, {
    createTransport: fakeCreateTransport({ seen, onVerify: async () => true })
  });

  const res = await probe.probe(smtpOpts());

  assert.equal(res.ok, true);
  const cfg = seen[0] as { auth: { type?: string; accessToken?: string } };
  assert.equal(cfg.auth.type, "OAuth2");
  assert.equal(cfg.auth.accessToken, SECRET_TOKEN);
  assert.ok(!(res.detail ?? "").includes(SECRET_TOKEN));
});
