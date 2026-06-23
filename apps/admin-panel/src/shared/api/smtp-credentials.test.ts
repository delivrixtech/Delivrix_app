import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { downloadSmtpCredential } from "./smtp-credentials.ts";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalUrl = globalThis.URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
  globalThis.URL = originalUrl;
});

test("downloadSmtpCredential uses the audited sender-pool download endpoint", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  let clicked = 0;
  mockDownloadDom(() => {
    clicked += 1;
  });
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(new Blob(["credential"]), {
      status: 200,
      headers: { "content-disposition": 'attachment; filename="smtp-credentials-example-mail.com.md"' }
    });
  }) as typeof fetch;

  await downloadSmtpCredential("example-mail.com");

  assert.deepEqual(calls, [{
    input: "/v1/sender-pool/credentials/example-mail.com/download",
    init: { method: "GET" }
  }]);
  assert.equal(clicked, 1);
});

test("downloadSmtpCredential surfaces JSON error messages", async () => {
  mockDownloadDom(() => undefined);
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: "credencial no configurada" }), {
    status: 409,
    statusText: "Conflict"
  })) as typeof fetch;

  await assert.rejects(
    () => downloadSmtpCredential("example-mail.com"),
    /credencial no configurada/
  );
});

function mockDownloadDom(onClick: () => void): void {
  const urlCtor = class extends URL {
    static createObjectURL(): string {
      return "blob:credential";
    }

    static revokeObjectURL(): void {
      return undefined;
    }
  };
  globalThis.URL = urlCtor as typeof URL;
  globalThis.document = {
    body: {
      appendChild(): void {
        return undefined;
      }
    },
    createElement(tagName: string): HTMLAnchorElement {
      assert.equal(tagName, "a");
      return {
        href: "",
        download: "",
        click: onClick,
        remove(): void {
          return undefined;
        }
      } as unknown as HTMLAnchorElement;
    }
  } as unknown as Document;
}
