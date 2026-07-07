// Autenticacion como GitHub App: firma un JWT RS256 con la private key de la App
// y lo intercambia por un installation access token (valido 1h) para actuar
// sobre el repo donde esta instalada. Cero dependencias: node:crypto + fetch.

import { createSign } from "node:crypto";

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

// JWT de App: iss = App ID, ventana corta (exp <= 10 min). iat con -60s de
// holgura por drift de reloj, como recomienda GitHub.
export function createAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

export type InstallationToken = {
  token: string;
  expiresAt: string;
};

export async function getInstallationToken(opts: {
  appId: string;
  privateKeyPem: string;
  installationId: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}): Promise<InstallationToken> {
  const apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const jwt = createAppJwt(opts.appId, opts.privateKeyPem, opts.nowSeconds);

  const response = await fetchImpl(`${apiBase}/app/installations/${opts.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "delivrix-qa-auditor"
    }
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`installation_token_failed_${response.status}: ${detail.slice(0, 200)}`);
  }

  const json: any = await response.json();
  return { token: String(json.token), expiresAt: String(json.expires_at ?? "") };
}
