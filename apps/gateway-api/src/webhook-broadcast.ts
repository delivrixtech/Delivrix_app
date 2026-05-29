/**
 * EquipoWebhookBroadcaster
 * -----------------------
 * Phase 0 — 2nd leg of "1 firma + audit chain + broadcast + auto-rollback".
 *
 * Threat model:
 *  - If the webhook URL leaks, attacker can saturate the Slack channel BUT
 *    cannot read secrets: every payload is filtered through redactSecrets()
 *    BEFORE serialization (both to remote webhook and to local buffer file).
 *  - If kill switch is armed we MUST NOT broadcast: prevents auto-loop where
 *    a broadcast itself triggers another audit event that triggers another
 *    broadcast.
 *  - Buffer file lives under runtime/ which is gitignored — only operators
 *    with shell access can read it. Even so, no raw secrets are written.
 *  - Async, fire-and-forget from the caller's POV: must NEVER throw upstream
 *    and block the audit append path.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AuditEventInput } from "../../../packages/domain/src/index.ts";

export interface WebhookBroadcastConfig {
  webhookUrl?: string;
  bufferPath?: string;
  fetchImpl?: typeof fetch;
  killSwitchProvider?: () => Promise<boolean>; // si true, NO broadcast
  maxRetries?: number;
  baseDelayMs?: number;
  panelBaseUrl?: string;
  now?: () => Date;
}

export interface BroadcastPayload {
  text: string;
  blocks: Array<Record<string, unknown>>;
  meta: {
    auditId: string;
    actorAgent: string;
    actorHuman?: string;
    category: string;
    domain?: string;
    serverSlug?: string;
    panelUrl?: string;
  };
}

const REDACT_KEYWORDS = [
  "token",
  "password",
  "secret",
  "api_key",
  "apikey",
  "bearer",
  "private_key",
  "privatekey"
];
const REDACT_PLACEHOLDER = "[REDACTED]";
const CRITICAL_CATEGORIES = new Set([
  "supervised_local_state",
  "future_live_requires_new_phase",
  "prohibited"
]);

export class EquipoWebhookBroadcaster {
  private readonly webhookUrl?: string;
  private readonly bufferPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly killSwitchProvider?: () => Promise<boolean>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly panelBaseUrl: string;
  private readonly now: () => Date;

  constructor(config: WebhookBroadcastConfig = {}) {
    this.webhookUrl = config.webhookUrl ?? process.env.EQUIPO_WEBHOOK_URL;
    this.bufferPath = resolve(
      config.bufferPath ?? process.env.EQUIPO_WEBHOOK_BUFFER ?? "runtime/webhook-buffer.jsonl"
    );
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.killSwitchProvider = config.killSwitchProvider;
    this.maxRetries = config.maxRetries ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 500;
    this.panelBaseUrl =
      config.panelBaseUrl ?? process.env.PANEL_BASE_URL ?? "http://localhost:5173";
    this.now = config.now ?? (() => new Date());
  }

  /**
   * Determina si el evento merece broadcast. Solo categorías críticas o
   * acciones supervisadas (oc.route53|ionos|webdock|smtp|warmup|domain).
   */
  shouldBroadcast(event: AuditEventInput): boolean {
    const md = (event.metadata ?? {}) as Record<string, unknown>;
    const cat = typeof md.category === "string" ? md.category : "";
    if (CRITICAL_CATEGORIES.has(cat)) return true;
    const action = typeof event.action === "string" ? event.action : "";
    if (/^oc\.(dns|route53|ionos|webdock|smtp|warmup|domain)\./.test(action)) return true;
    return false;
  }

  /**
   * Construye el payload Slack-compatible. SIEMPRE pasa por redactSecrets
   * antes de armar los blocks: garantiza que ni audit_id ni metadata
   * filtren secretos al canal.
   */
  buildPayload(event: AuditEventInput): BroadcastPayload {
    const safeMeta = this.redactSecrets((event.metadata ?? {}) as Record<string, unknown>);
    const auditId = typeof safeMeta.auditId === "string" ? safeMeta.auditId : event.action;
    const category =
      typeof safeMeta.category === "string" ? safeMeta.category : "supervised_local_state";
    const domain = typeof safeMeta.domain === "string" ? safeMeta.domain : undefined;
    const serverSlug =
      typeof safeMeta.serverSlug === "string" ? safeMeta.serverSlug : undefined;
    const panelUrl = `${this.panelBaseUrl}/audit/${encodeURIComponent(auditId)}`;
    const text = `:warning: Delivrix · ${event.action} · ${event.actorId}`;
    const fields: Array<Record<string, unknown>> = [
      { type: "mrkdwn", text: `*audit_id*\n\`${auditId}\`` },
      { type: "mrkdwn", text: `*actor*\n${event.actorId}` }
    ];
    if (domain) fields.push({ type: "mrkdwn", text: `*domain*\n${domain}` });
    if (serverSlug) fields.push({ type: "mrkdwn", text: `*server*\n${serverSlug}` });
    const blocks: Array<Record<string, unknown>> = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${event.action}*\n_${category}_` }
      },
      { type: "section", fields },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in panel" },
            url: panelUrl
          }
        ]
      }
    ];
    return {
      text,
      blocks,
      meta: {
        auditId,
        actorAgent: event.actorType,
        actorHuman: event.actorId,
        category,
        domain,
        serverSlug,
        panelUrl
      }
    };
  }

  /**
   * Sustituye valores de keys sensibles con [REDACTED] recursivamente.
   * Trata objetos y arrays, deja primitivos intactos salvo en keys sensibles.
   */
  redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (REDACT_KEYWORDS.some((kw) => lowerKey.includes(kw))) {
        result[key] = REDACT_PLACEHOLDER;
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        result[key] = this.redactSecrets(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = value.map((v) =>
          v && typeof v === "object" && !Array.isArray(v)
            ? this.redactSecrets(v as Record<string, unknown>)
            : v
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Entry point principal. Llamado por el gateway tras cada audit append.
   * Decide broadcast o buffer, intenta con retries.
   */
  async broadcast(
    event: AuditEventInput
  ): Promise<{ delivered: boolean; buffered: boolean; skipped?: string }> {
    if (!this.shouldBroadcast(event)) {
      return { delivered: false, buffered: false, skipped: "not_critical" };
    }
    if (this.killSwitchProvider) {
      const armed = await this.killSwitchProvider().catch(() => true);
      if (armed) {
        return { delivered: false, buffered: false, skipped: "kill_switch_armed" };
      }
    }
    const payload = this.buildPayload(event);
    if (!this.webhookUrl) {
      await this.bufferLocally(payload);
      return { delivered: false, buffered: true };
    }
    const ok = await this.deliverWithRetries(payload);
    if (!ok) {
      await this.bufferLocally(payload);
      return { delivered: false, buffered: true };
    }
    return { delivered: true, buffered: false };
  }

  private async deliverWithRetries(payload: BroadcastPayload): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(this.webhookUrl as string, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (res.ok) return true;
      } catch {
        // swallow, retry
      }
      const delay = this.baseDelayMs * Math.pow(2, attempt);
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return false;
  }

  private async bufferLocally(payload: BroadcastPayload): Promise<void> {
    await mkdir(dirname(this.bufferPath), { recursive: true });
    const line = JSON.stringify({ bufferedAt: this.now().toISOString(), payload }) + "\n";
    await appendFile(this.bufferPath, line, "utf-8");
  }
}

export function createEquipoWebhookBroadcasterFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EquipoWebhookBroadcaster {
  return new EquipoWebhookBroadcaster({
    webhookUrl: env.EQUIPO_WEBHOOK_URL,
    bufferPath: env.EQUIPO_WEBHOOK_BUFFER
  });
}
