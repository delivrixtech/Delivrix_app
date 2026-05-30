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
