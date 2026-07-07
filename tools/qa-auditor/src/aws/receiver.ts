// Lambda "receiver" detras de una Function URL publica. Es el endpoint del
// webhook de la GitHub App. Verifica la firma HMAC, responde 202 de inmediato
// (GitHub espera < 10s) e invoca de forma asincrona al worker que hace la
// auditoria pesada. SDK provisto por el runtime de Lambda; no lo importan tests.

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { verifyGithubSignature } from "../github/webhook-hmac.ts";
import { loadSecrets } from "./secrets.ts";
import { log } from "../logging.ts";

type FunctionUrlEvent = {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
};

const WANTED_PR_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];

function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

function rawBodyOf(event: FunctionUrlEvent): string {
  const body = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
}

export const handler = async (event: FunctionUrlEvent) => {
  const headers = event.headers ?? {};
  const eventName = header(headers, "x-github-event") ?? "";
  const delivery = header(headers, "x-github-delivery") ?? "";
  const signature = header(headers, "x-hub-signature-256");
  const rawBody = rawBodyOf(event);

  const secrets = await loadSecrets();
  if (!verifyGithubSignature(rawBody, signature, secrets.webhookSecret)) {
    log.warn("webhook_firma_invalida", { eventName, delivery });
    return { statusCode: 401, body: "invalid signature" };
  }

  if (eventName === "ping") {
    return { statusCode: 200, body: "pong" };
  }
  if (eventName !== "pull_request" && eventName !== "push") {
    return { statusCode: 202, body: "ignored event" };
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "invalid json" };
  }

  if (eventName === "pull_request" && !WANTED_PR_ACTIONS.includes(String(payload.action ?? ""))) {
    return { statusCode: 202, body: "ignored action" };
  }

  const functionName = process.env.QA_WORKER_FUNCTION ?? "";
  if (functionName.length === 0) {
    log.error("worker_function_no_configurada");
    return { statusCode: 500, body: "worker not configured" };
  }

  const lambda = new LambdaClient({});
  await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ eventName, delivery, payload }))
    })
  );
  log.info("webhook_aceptado", { eventName, delivery });
  return { statusCode: 202, body: "accepted" };
};
