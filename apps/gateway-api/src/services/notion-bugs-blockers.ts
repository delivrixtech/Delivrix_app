/**
 * Cliente mínimo para la base Notion "🐛 Bugs & Blockers" (agent-managed).
 *
 * Contrato tomado 1:1 del Flow 3 del "🤖 Agent Integration Guide" del
 * workspace Delivrix SMTP Operations (Health Monitor Agent → Bugs & Blockers):
 *
 *   POST https://api.notion.com/v1/pages
 *   Headers: Authorization Bearer NOTION_API_KEY, Notion-Version: 2022-06-28
 *   parent.database_id = 75c53a45c1d94376910904ca03e5268e
 *   properties: Issue (title), Status=Open, Severity, Category,
 *               Affected Server, Reported Date, Reported By=Agent,
 *               Description, Agent Flagged=true
 *
 * Mecanismo de credenciales: mismo patrón que las skills OpenClaw
 * (services/openclaw-skills — NOTION_API_KEY por env; si falta, se omite el
 * side-effect y se audita el motivo, ver
 * .audit/decision-skip-notion-side-effect.md).
 */

export const DEFAULT_BUGS_BLOCKERS_DATABASE_ID = "75c53a45c1d94376910904ca03e5268e";
const NOTION_API_URL = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2022-06-28";

export interface BugsBlockersEntry {
  issueTitle: string;
  /** Debe coincidir exacto con las opciones del select en Notion. */
  category: "Flagged Server" | "Agent Error" | "DNS / Config" | "Warmup Stalled" | "Website Issue" | "Other";
  severity: "Critical" | "High" | "Medium" | "Low";
  affectedServer: string;
  description: string;
  /** YYYY-MM-DD */
  reportedDate: string;
}

export interface NotionBugsBlockersDeps {
  apiKey?: string;
  databaseId?: string;
  fetchImpl?: typeof fetch;
}

export type CreateBugsBlockersResult =
  | { ok: true; pageId: string; url?: string }
  | { ok: false; skipped: true; reason: "notion_api_key_missing" }
  | { ok: false; skipped: false; status: number; error: string };

export function createNotionBugsBlockersDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): NotionBugsBlockersDeps {
  return {
    apiKey: env.NOTION_API_KEY?.trim() || undefined,
    databaseId: env.NOTION_BUGS_BLOCKERS_DB_ID?.trim() || DEFAULT_BUGS_BLOCKERS_DATABASE_ID
  };
}

export async function createBugsBlockersEntry(
  entry: BugsBlockersEntry,
  deps: NotionBugsBlockersDeps
): Promise<CreateBugsBlockersResult> {
  const apiKey = deps.apiKey?.trim();
  if (!apiKey) {
    return { ok: false, skipped: true, reason: "notion_api_key_missing" };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const payload = {
    parent: { database_id: deps.databaseId ?? DEFAULT_BUGS_BLOCKERS_DATABASE_ID },
    properties: {
      "Issue": { title: [{ text: { content: truncate(entry.issueTitle, 200) } }] },
      "Status": { select: { name: "Open" } },
      "Severity": { select: { name: entry.severity } },
      "Category": { select: { name: entry.category } },
      "Affected Server": { rich_text: [{ text: { content: truncate(entry.affectedServer, 200) } }] },
      "Reported Date": { date: { start: entry.reportedDate } },
      "Reported By": { select: { name: "Agent" } },
      "Description": { rich_text: [{ text: { content: truncate(entry.description, 1900) } }] },
      "Agent Flagged": { checkbox: true }
    }
  };

  let response: Response;
  try {
    response = await fetchImpl(NOTION_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      status: 0,
      error: error instanceof Error ? error.message : "notion_fetch_failed"
    };
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    return {
      ok: false,
      skipped: false,
      status: response.status,
      error: truncate(errorBody || `notion_http_${response.status}`, 500)
    };
  }

  const body = (await response.json().catch(() => ({}))) as { id?: string; url?: string };
  return { ok: true, pageId: body.id ?? "", url: body.url };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
