/**
 * Webdock inventory — contrato GET-only que expone el snapshot de servidores
 * de la cuenta del operador en Webdock. Alimenta el lane Hardware del Canvas
 * y la sección Clústeres del admin panel con datos vivos cuando hay API key
 * configurada, o con mocks canónicos cuando no.
 *
 * Hito 5.11.A. La lógica de detección de drift entre este inventario y los
 * sender_node locales vive en `openclaw-rules.ts`.
 */

export type WebdockServerStatus =
  | "running"
  | "stopped"
  | "suspended"
  | "provisioning"
  | "reinstalling"
  | "rebooting"
  | "deleting"
  | "error"
  | "unknown"
  | string;

export interface WebdockInventoryServer {
  slug: string;
  name: string;
  ipv4: string;
  ipv6?: string;
  status: WebdockServerStatus;
  profileSlug?: string;
  location?: string;
  creationDate?: string;
  lastDataReceived?: string;
  imageSlug?: string;
  description?: string;
  snapshotRunTime?: number;
}

export interface WebdockInventorySummary {
  total: number;
  running: number;
  stopped: number;
  suspended: number;
  other: number;
}

export interface WebdockInventorySourceInfo {
  kind: "live" | "mock";
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  errorMessage?: string;
}

export interface WebdockInventoryContract {
  schemaVersion: "2026-05-17.v1";
  generatedAt: string;
  mode: "read_only";
  source: WebdockInventorySourceInfo;
  summary: WebdockInventorySummary;
  servers: WebdockInventoryServer[];
}

export interface BuildWebdockInventoryInput {
  servers: WebdockInventoryServer[];
  source: WebdockInventorySourceInfo;
  now?: Date;
}

export function buildWebdockInventoryContract(
  input: BuildWebdockInventoryInput
): WebdockInventoryContract {
  const now = input.now ?? new Date();
  return {
    schemaVersion: "2026-05-17.v1",
    generatedAt: now.toISOString(),
    mode: "read_only",
    source: input.source,
    summary: summarize(input.servers),
    servers: input.servers
  };
}

function summarize(servers: WebdockInventoryServer[]): WebdockInventorySummary {
  let running = 0;
  let stopped = 0;
  let suspended = 0;
  let other = 0;
  for (const server of servers) {
    if (server.status === "running") {
      running += 1;
    } else if (server.status === "stopped") {
      stopped += 1;
    } else if (server.status === "suspended") {
      suspended += 1;
    } else {
      other += 1;
    }
  }
  return { total: servers.length, running, stopped, suspended, other };
}
