// Carga de secretos en AWS. El SDK de Secrets Manager lo provee el runtime de
// Lambda (no se empaqueta). Fallback a variables de entorno para local/test.
// Se cachea por contenedor caliente para no pegarle a Secrets Manager en cada
// invocacion. Este modulo SOLO corre en Lambda; no lo importan los tests.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// Bedrock se usa via IAM del Lambda: no hay API key de Anthropic.
export type QaSecrets = {
  githubAppPrivateKey: string;
  webhookSecret: string;
  appId: string;
};

let cached: QaSecrets | null = null;

// Las private keys PEM en variables de entorno suelen venir con \n escapados.
function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export async function loadSecrets(env: NodeJS.ProcessEnv = process.env): Promise<QaSecrets> {
  if (cached) {
    return cached;
  }

  const fromEnv: QaSecrets = {
    githubAppPrivateKey: normalizePem(env.GITHUB_APP_PRIVATE_KEY ?? ""),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    appId: env.GITHUB_APP_ID ?? ""
  };

  const secretsId = env.QA_SECRETS_ID ?? "";
  if (secretsId.length === 0) {
    cached = fromEnv;
    return cached;
  }

  const client = new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretsId }));
  const parsed: any = JSON.parse(result.SecretString ?? "{}");

  cached = {
    githubAppPrivateKey: normalizePem(parsed.GITHUB_APP_PRIVATE_KEY ?? fromEnv.githubAppPrivateKey),
    webhookSecret: parsed.GITHUB_WEBHOOK_SECRET ?? fromEnv.webhookSecret,
    appId: String(parsed.GITHUB_APP_ID ?? fromEnv.appId)
  };
  return cached;
}
