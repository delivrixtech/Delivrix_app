import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGmraw,
  classifyByLabels,
  GmailImapAdapter,
  GmailImapAdapterError,
  type ImapFlowClient,
  type ImapFlowFactory,
  type ImapFlowMailboxLock
} from "./gmail-adapter.ts";

interface FakeMessage {
  uid: number;
  subject: string;
  from: string;
  messageId: string | null;
  labels: string[];
  internalDate?: Date;
}

interface FakeImapBehavior {
  searchUids?: number[];
  messagesByUid?: Map<number, FakeMessage>;
  connectError?: unknown;
  searchError?: unknown;
  fetchError?: unknown;
  onConnect?: () => void;
  onLogout?: () => void;
}

function buildFakeFactory(behavior: FakeImapBehavior): {
  factory: ImapFlowFactory;
  calls: {
    connected: number;
    loggedOut: number;
    locksAcquired: string[];
    locksReleased: number;
    searches: Array<Record<string, unknown>>;
    fetches: number[];
  };
} {
  const calls = {
    connected: 0,
    loggedOut: 0,
    locksAcquired: [] as string[],
    locksReleased: 0,
    searches: [] as Array<Record<string, unknown>>,
    fetches: [] as number[]
  };
  const factory: ImapFlowFactory = () => {
    const client: ImapFlowClient = {
      connect: async () => {
        calls.connected += 1;
        behavior.onConnect?.();
        if (behavior.connectError) throw behavior.connectError;
      },
      logout: async () => {
        calls.loggedOut += 1;
        behavior.onLogout?.();
      },
      getMailboxLock: async (mailbox) => {
        calls.locksAcquired.push(mailbox);
        const lock: ImapFlowMailboxLock = {
          release: () => {
            calls.locksReleased += 1;
          }
        };
        return lock;
      },
      search: async (criteria) => {
        calls.searches.push(criteria);
        if (behavior.searchError) throw behavior.searchError;
        return behavior.searchUids ?? [];
      },
      fetchOne: async (seq) => {
        const uid = Number(seq);
        calls.fetches.push(uid);
        if (behavior.fetchError) throw behavior.fetchError;
        const msg = behavior.messagesByUid?.get(uid);
        if (!msg) return undefined;
        return {
          uid: msg.uid,
          envelope: {
            messageId: msg.messageId ?? undefined,
            subject: msg.subject,
            from: msg.from
              ? [{ name: undefined as never, address: msg.from }]
              : []
          },
          labels: msg.labels,
          internalDate: msg.internalDate ?? new Date("2026-05-28T11:00:00.000Z")
        } as unknown as Awaited<ReturnType<ImapFlowClient["fetchOne"]>>;
      }
    };
    return client;
  };
  return { factory, calls };
}

const baseConfig = {
  host: "imap.gmail.com",
  port: 993,
  user: "jectcode@gmail.com",
  pass: "app-password-redacted",
  now: () => new Date("2026-05-28T12:00:00.000Z")
};

test("buildGmraw builds subject query with newer_than window", () => {
  const since = new Date("2026-05-28T11:30:00.000Z");
  const query = buildGmraw("subject", "[delivrix-warmup-abc123]", since, 30);
  assert.equal(query, 'subject:"[delivrix-warmup-abc123]" newer_than:30m');
});

test("buildGmraw builds from query escaping quotes", () => {
  const since = new Date("2026-05-28T11:00:00.000Z");
  const query = buildGmraw("from", 'noreply@delivrix.com', since, 60);
  assert.equal(query, 'from:"noreply@delivrix.com" newer_than:60m');
});

test("buildGmraw builds rfc822msgid query without angle brackets", () => {
  const since = new Date("2026-05-28T11:00:00.000Z");
  const query = buildGmraw("messageId", "<abc@delivrix.com>", since, 15);
  assert.equal(query, "rfc822msgid:abc@delivrix.com");
});

test("classifyByLabels picks spam over inbox", () => {
  assert.equal(classifyByLabels(["\\Inbox", "\\Junk"]), "spam");
  assert.equal(classifyByLabels(["\\Spam"]), "spam");
});

test("classifyByLabels picks promotions over inbox", () => {
  assert.equal(classifyByLabels(["\\Inbox", "CATEGORY_PROMOTIONS"]), "promotions");
});

test("classifyByLabels picks inbox when no spam/promo", () => {
  assert.equal(classifyByLabels(["\\Inbox", "\\Important"]), "inbox");
});

test("classifyByLabels falls back to other", () => {
  assert.equal(classifyByLabels(["\\Archive", "CATEGORY_FORUMS"]), "other");
  assert.equal(classifyByLabels([]), "other");
});

test("GmailImapAdapter.classify counts inbox / spam / promotions / other", async () => {
  const messagesByUid = new Map<number, FakeMessage>([
    [1, { uid: 1, subject: "Inbox email", from: "a@x.com", messageId: "<m1@x>", labels: ["\\Inbox"] }],
    [2, { uid: 2, subject: "Spam email", from: "b@x.com", messageId: "<m2@x>", labels: ["\\Junk"] }],
    [3, { uid: 3, subject: "Promo email", from: "c@x.com", messageId: "<m3@x>", labels: ["\\Inbox", "CATEGORY_PROMOTIONS"] }]
  ]);
  const { factory, calls } = buildFakeFactory({
    searchUids: [1, 2, 3],
    messagesByUid
  });

  const adapter = new GmailImapAdapter({ ...baseConfig, imapFactory: factory });
  const result = await adapter.classify("[delivrix-test]", 30, "subject");

  assert.equal(result.matched, 3);
  assert.equal(result.inbox, 1);
  assert.equal(result.spam, 1);
  assert.equal(result.promotions, 1);
  assert.equal(result.other, 0);
  assert.equal(result.placementRate, round4(1 / 3));
  assert.equal(result.samples.length, 3);
  // Fetched in descending uid order (most recent first)
  assert.deepEqual(calls.fetches, [3, 2, 1]);
  assert.equal(calls.connected, 1);
  assert.equal(calls.loggedOut, 1);
  assert.deepEqual(calls.locksAcquired, ["[Gmail]/All Mail"]);
  assert.equal(calls.locksReleased, 1);
  assert.equal(calls.searches.length, 1);
  assert.equal((calls.searches[0].gmraw as string).startsWith("subject:"), true);
  // Password no aparece en samples ni en query
  for (const sample of result.samples) {
    assert.equal(JSON.stringify(sample).includes("app-password-redacted"), false);
  }
});

test("GmailImapAdapter.classify caps samples to 50", async () => {
  const messagesByUid = new Map<number, FakeMessage>();
  const uids: number[] = [];
  for (let i = 1; i <= 80; i += 1) {
    uids.push(i);
    messagesByUid.set(i, {
      uid: i,
      subject: `Email ${i}`,
      from: `a${i}@x.com`,
      messageId: `<m${i}@x>`,
      labels: ["\\Inbox"]
    });
  }
  const { factory, calls } = buildFakeFactory({
    searchUids: uids,
    messagesByUid
  });

  const adapter = new GmailImapAdapter({ ...baseConfig, imapFactory: factory });
  const result = await adapter.classify("[delivrix-cap]", 30, "subject");

  assert.equal(result.matched, 50);
  assert.equal(result.samples.length, 50);
  assert.equal(calls.fetches.length, 50);
  // Most recent 50 uids = 80..31
  assert.equal(calls.fetches[0], 80);
  assert.equal(calls.fetches.at(-1), 31);
});

test("GmailImapAdapter.classify returns zero counts when search empty", async () => {
  const { factory, calls } = buildFakeFactory({ searchUids: [] });
  const adapter = new GmailImapAdapter({ ...baseConfig, imapFactory: factory });
  const result = await adapter.classify("[delivrix-empty]", 30, "subject");

  assert.equal(result.matched, 0);
  assert.equal(result.inbox, 0);
  assert.equal(result.placementRate, 0);
  assert.equal(calls.fetches.length, 0);
  assert.equal(calls.loggedOut, 1);
});

test("GmailImapAdapter.classify throws imap_connect_failed on connection error", async () => {
  const { factory, calls } = buildFakeFactory({
    connectError: new Error("ECONNREFUSED")
  });
  const adapter = new GmailImapAdapter({ ...baseConfig, imapFactory: factory });

  await assert.rejects(
    () => adapter.classify("[delivrix-fail]", 30, "subject"),
    (error: unknown) => {
      assert.equal(error instanceof GmailImapAdapterError, true);
      const adapterErr = error as GmailImapAdapterError;
      assert.equal(adapterErr.code, "imap_connect_failed");
      return true;
    }
  );
  // No locks taken, no fetches
  assert.equal(calls.locksAcquired.length, 0);
  assert.equal(calls.fetches.length, 0);
  // Logout should NOT be called since connect failed before lock acquired,
  // but our adapter only enters finally after connect ok.
  assert.equal(calls.loggedOut, 0);
});

test("GmailImapAdapter.classify throws imap_auth_failed on auth error", async () => {
  const authError = Object.assign(new Error("authentication failed"), {
    authenticationFailed: true
  });
  const { factory } = buildFakeFactory({ connectError: authError });
  const adapter = new GmailImapAdapter({ ...baseConfig, imapFactory: factory });

  await assert.rejects(
    () => adapter.classify("[delivrix-auth]", 30, "subject"),
    (error: unknown) => {
      assert.equal(error instanceof GmailImapAdapterError, true);
      assert.equal((error as GmailImapAdapterError).code, "imap_auth_failed");
      return true;
    }
  );
});

test("GmailImapAdapter.classify throws imap_disabled when credentials missing", async () => {
  const adapter = new GmailImapAdapter({
    host: "imap.gmail.com",
    port: 993,
    user: "",
    pass: ""
  });
  await assert.rejects(
    () => adapter.classify("[delivrix-disabled]", 30, "subject"),
    (error: unknown) => {
      assert.equal(error instanceof GmailImapAdapterError, true);
      assert.equal((error as GmailImapAdapterError).code, "imap_disabled");
      return true;
    }
  );
});

test("GmailImapAdapter.classify releases lock and logs out on search error", async () => {
  const { factory, calls } = buildFakeFactory({
    searchError: new Error("IMAP BAD SEARCH")
  });
  const adapter = new GmailImapAdapter({ ...baseConfig, imapFactory: factory });

  await assert.rejects(() => adapter.classify("[delivrix-search]", 30, "subject"));
  assert.equal(calls.locksReleased, 1);
  assert.equal(calls.loggedOut, 1);
});

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
