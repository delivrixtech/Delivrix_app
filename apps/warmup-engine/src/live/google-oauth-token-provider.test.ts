import assert from "node:assert/strict";
import test from "node:test";

import {
  createGoogleOAuthTokenProvider,
  loadGoogleOAuthConfig,
  type FetchLike,
  type GoogleOAuthConfig,
  type TokenHttpResponse
} from "./google-oauth-token-provider.ts";

// Config DUMMY (valores inventados; el archivo real NUNCA se toca). Marcados para detectar leaks.
const DUMMY_CONFIG: GoogleOAuthConfig = {
  client_id: "dummy-client-id",
  client_secret: "dummy-client-secret-DO-NOT-LEAK",
  refresh_token: "dummy-refresh-token-DO-NOT-LEAK",
  token_uri: "https://oauth2.example.test/token"
};

interface FetchState {
  calls: Array<{ url: string; body: string }>;
  tokens: string[];
  expiresIn?: number;
  failStatus?: number;
}

function fakeFetch(state: FetchState): FetchLike {
  let i = 0;
  return async (url, init) => {
    state.calls.push({ url, body: init.body });
    if (state.failStatus) {
      const res: TokenHttpResponse = {
        ok: false,
        status: state.failStatus,
        async json() {
          // Peor caso: el endpoint eco-devuelve el refresh_token en el error.
          return { error: "invalid_grant", refresh_token: DUMMY_CONFIG.refresh_token };
        },
        async text() {
          return `error refresh_token=${DUMMY_CONFIG.refresh_token}`;
        }
      };
      return res;
    }
    const token = state.tokens[Math.min(i, state.tokens.length - 1)];
    i++;
    const res: TokenHttpResponse = {
      ok: true,
      status: 200,
      async json() {
        return { access_token: token, expires_in: state.expiresIn ?? 3600 };
      },
      async text() {
        return "";
      }
    };
    return res;
  };
}

test("token provider: mintea en la primera llamada (POST con grant_type=refresh_token)", async () => {
  const state: FetchState = { calls: [], tokens: ["tok-1"] };
  const provider = createGoogleOAuthTokenProvider({
    readConfig: async () => DUMMY_CONFIG,
    fetch: fakeFetch(state),
    now: () => 1_000_000
  });

  const token = await provider.getAccessToken();

  assert.equal(token, "tok-1");
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, DUMMY_CONFIG.token_uri);
  assert.ok(state.calls[0].body.includes("grant_type=refresh_token"));
  assert.ok(state.calls[0].body.includes("client_id=dummy-client-id"));
});

test("token provider: cache hit dentro de la ventana ⇒ NO vuelve a mintear", async () => {
  const state: FetchState = { calls: [], tokens: ["tok-1", "tok-2"], expiresIn: 3600 };
  let nowMs = 1_000_000;
  const provider = createGoogleOAuthTokenProvider({
    readConfig: async () => DUMMY_CONFIG,
    fetch: fakeFetch(state),
    now: () => nowMs,
    refreshSkewMs: 60_000
  });

  const t1 = await provider.getAccessToken();
  nowMs += 60_000; // sigue dentro de la validez (expira ~t+3540s).
  const t2 = await provider.getAccessToken();

  assert.equal(t1, "tok-1");
  assert.equal(t2, "tok-1");
  assert.equal(state.calls.length, 1);
});

test("token provider: refresca tras expirar ⇒ nuevo token, segundo POST", async () => {
  const state: FetchState = { calls: [], tokens: ["tok-1", "tok-2"], expiresIn: 3600 };
  let nowMs = 1_000_000;
  const provider = createGoogleOAuthTokenProvider({
    readConfig: async () => DUMMY_CONFIG,
    fetch: fakeFetch(state),
    now: () => nowMs,
    refreshSkewMs: 60_000
  });

  const t1 = await provider.getAccessToken();
  nowMs += 3_600_000; // pasado el expiresAt (t+3600s - 60s skew).
  const t2 = await provider.getAccessToken();

  assert.equal(t1, "tok-1");
  assert.equal(t2, "tok-2");
  assert.equal(state.calls.length, 2);
});

test("token provider: mints concurrentes se deduplican (un solo POST)", async () => {
  const state: FetchState = { calls: [], tokens: ["tok-1", "tok-2"] };
  const provider = createGoogleOAuthTokenProvider({
    readConfig: async () => DUMMY_CONFIG,
    fetch: fakeFetch(state),
    now: () => 1_000_000
  });

  const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);

  assert.equal(a, "tok-1");
  assert.equal(b, "tok-1");
  assert.equal(state.calls.length, 1);
});

test("token provider: fail-closed si el config falta (readConfig lanza)", async () => {
  const provider = createGoogleOAuthTokenProvider({
    readConfig: async () => {
      throw new Error("warmup_oauth_config_missing: no such file");
    },
    fetch: fakeFetch({ calls: [], tokens: ["x"] }),
    now: () => 1
  });

  await assert.rejects(() => provider.getAccessToken(), /warmup_oauth_config_missing/);
});

test("token provider: HTTP no-OK ⇒ error por status SIN filtrar el refresh_token", async () => {
  const state: FetchState = { calls: [], tokens: [], failStatus: 400 };
  const provider = createGoogleOAuthTokenProvider({
    readConfig: async () => DUMMY_CONFIG,
    fetch: fakeFetch(state),
    now: () => 1
  });

  await assert.rejects(
    () => provider.getAccessToken(),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /warmup_oauth_token_http_400/);
      assert.ok(!msg.includes(DUMMY_CONFIG.refresh_token), "el error no debe filtrar el refresh_token");
      assert.ok(!msg.includes(DUMMY_CONFIG.client_secret), "el error no debe filtrar el client_secret");
      return true;
    }
  );
});

test("token provider: respuesta sin access_token ⇒ fail-closed", async () => {
  const provider = createGoogleOAuthTokenProvider({
    readConfig: async () => DUMMY_CONFIG,
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { expires_in: 3600 };
      },
      async text() {
        return "";
      }
    }),
    now: () => 1
  });

  await assert.rejects(() => provider.getAccessToken(), /warmup_oauth_token_missing_access_token/);
});

// ── loadGoogleOAuthConfig (readFile inyectado ⇒ nunca toca el archivo real) ─────────────────────────

test("loadGoogleOAuthConfig: archivo ausente ⇒ warmup_oauth_config_missing", async () => {
  await assert.rejects(
    () =>
      loadGoogleOAuthConfig("/nope/warmup-oauth.local.json", async () => {
        throw new Error("ENOENT: no such file");
      }),
    /warmup_oauth_config_missing/
  );
});

test("loadGoogleOAuthConfig: JSON inválido ⇒ warmup_oauth_config_invalid (sin filtrar contenido)", async () => {
  await assert.rejects(
    () => loadGoogleOAuthConfig("/x", async () => "{ not json"),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /warmup_oauth_config_invalid/);
      assert.ok(!msg.includes("not json"), "no debe eco-devolver el contenido crudo");
      return true;
    }
  );
});

test("loadGoogleOAuthConfig: campo faltante ⇒ invalid nombrando la clave, no el valor", async () => {
  await assert.rejects(
    () =>
      loadGoogleOAuthConfig("/x", async () =>
        JSON.stringify({ client_id: "a", client_secret: "b", token_uri: "https://t" })
      ),
    /warmup_oauth_config_invalid: campo "refresh_token"/
  );
});

test("loadGoogleOAuthConfig: config completa ⇒ devuelve los 4 campos", async () => {
  const cfg = await loadGoogleOAuthConfig("/x", async () => JSON.stringify(DUMMY_CONFIG));
  assert.deepEqual(cfg, DUMMY_CONFIG);
});
