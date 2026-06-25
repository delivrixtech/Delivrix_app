import { Client } from "pg";
import { createClient } from "redis";

export type DependencyStatus = "ok" | "down";

export type DependencyCheck = {
  status: DependencyStatus;
  checkedAt: string;
  message?: string;
};

export type GatewayDependencyHealth = {
  postgres: DependencyCheck;
  redis: DependencyCheck;
};

export type EpisodicScratchHealthStatus = "ok" | "missing_table" | "schema_drift" | "down";

export type EpisodicScratchHealth = {
  status: EpisodicScratchHealthStatus;
  checkedAt: string;
  reason?: string;
  postgresCode?: string;
  missingColumns?: string[];
};

export interface QueryablePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export const defaultPostgresUrl = "postgres://delivrix:delivrix_dev_password@localhost:5432/delivrix_mailops";
export const defaultRedisUrl = "redis://localhost:6379";

const defaultTimeoutMs = 1_500;

export async function checkGatewayDependencies(input: {
  postgresUrl?: string;
  redisUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
} = {}): Promise<GatewayDependencyHealth> {
  const now = input.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  const [postgres, redis] = await Promise.all([
    checkPostgres(input.postgresUrl ?? process.env.POSTGRES_URL ?? defaultPostgresUrl, timeoutMs, now),
    checkRedis(input.redisUrl ?? process.env.REDIS_URL ?? defaultRedisUrl, timeoutMs, now)
  ]);

  return { postgres, redis };
}

export function dependencyStatus(check: DependencyCheck): DependencyStatus {
  return check.status;
}

export async function checkEpisodicScratchHealth(input: {
  pool: QueryablePool;
  now?: () => Date;
}): Promise<EpisodicScratchHealth> {
  const now = input.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const requiredColumns = [
    "id",
    "intent_id",
    "tool",
    "input_hash",
    "outcome",
    "outcome_data",
    "ttl_expires_at",
    "plane",
    "provenance",
    "reliability",
    "valid_at",
    "invalid_at"
  ];

  try {
    const table = await input.pool.query("SELECT to_regclass('openclaw_episodic_scratch') AS table_name");
    if (!table.rows[0]?.table_name) {
      return { status: "missing_table", checkedAt, reason: "openclaw_episodic_scratch_missing" };
    }
    const columns = await input.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'openclaw_episodic_scratch'"
    );
    const present = new Set(columns.rows.map((row) => String(row.column_name)));
    const missingColumns = requiredColumns.filter((column) => !present.has(column));
    if (missingColumns.length > 0) {
      return { status: "schema_drift", checkedAt, reason: "missing_columns", missingColumns };
    }
    await input.pool.query(
      "SELECT 1 FROM openclaw_episodic_scratch WHERE false AND ttl_expires_at > NOW() AND invalid_at IS NULL AND plane = 'verified_fact' LIMIT 0"
    );
    return { status: "ok", checkedAt };
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "42P01") {
      return { status: "missing_table", checkedAt, reason: "openclaw_episodic_scratch_missing", postgresCode: code };
    }
    if (code === "42703") {
      return { status: "schema_drift", checkedAt, reason: "scratch_schema_column_missing", postgresCode: code };
    }
    return {
      status: "down",
      checkedAt,
      reason: sanitizedDependencyFailureReason(error),
      ...(code ? { postgresCode: code } : {})
    };
  }
}

function sanitizedDependencyFailureReason(error: unknown): string {
  void error;
  return "episodic_scratch_health_failed";
}

async function checkPostgres(url: string, timeoutMs: number, now: () => Date): Promise<DependencyCheck> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: "delivrix-gateway-health"
  });

  try {
    await withTimeout(client.connect(), timeoutMs);
    await withTimeout(client.query("SELECT 1"), timeoutMs);
    return ok(now);
  } catch (error) {
    return down(now, error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkRedis(url: string, timeoutMs: number, now: () => Date): Promise<DependencyCheck> {
  const client = createClient({
    url,
    socket: {
      connectTimeout: timeoutMs,
      reconnectStrategy: false
    }
  });

  client.on("error", () => undefined);

  try {
    await withTimeout(client.connect(), timeoutMs);
    const pong = await withTimeout(client.ping(), timeoutMs);
    if (pong !== "PONG") {
      return {
        status: "down",
        checkedAt: now().toISOString(),
        message: `Unexpected Redis ping response: ${pong}`
      };
    }
    return ok(now);
  } catch (error) {
    return down(now, error);
  } finally {
    if (client.isReady) {
      await withTimeout(client.quit(), timeoutMs).catch(() => client.destroy());
    } else if (client.isOpen) {
      client.destroy();
    }
  }
}

function ok(now: () => Date): DependencyCheck {
  return {
    status: "ok",
    checkedAt: now().toISOString()
  };
}

function down(now: () => Date, error: unknown): DependencyCheck {
  return {
    status: "down",
    checkedAt: now().toISOString(),
    message: error instanceof Error ? error.message : "Dependency health check failed."
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let index = 0; index < 4; index += 1) {
    if (!current || typeof current !== "object") return undefined;
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
