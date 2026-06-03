import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

interface TransactionResult<T, R> {
  value: T;
  result: R;
}

class AsyncMutex {
  private current = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.current;
    let release: () => void = () => undefined;
    this.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const mutexes = new Map<string, AsyncMutex>();

export class JsonFileStore<T> {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async read(defaultValue: T): Promise<T> {
    return this.readUnlocked(defaultValue);
  }

  async write(value: T): Promise<void> {
    await this.withLock(async () => {
      await this.writeUnlocked(value);
    });
  }

  async update(defaultValue: T, updater: (current: T) => T | Promise<T>): Promise<T> {
    return this.transaction(defaultValue, async (current) => {
      const value = await updater(current);
      return { value, result: value };
    });
  }

  async transaction<R>(
    defaultValue: T,
    updater: (current: T) => TransactionResult<T, R> | Promise<TransactionResult<T, R>>
  ): Promise<R> {
    return this.withLock(async () => {
      const current = await this.readUnlocked(defaultValue);
      const { value, result } = await updater(current);
      await this.writeUnlocked(value);
      return result;
    });
  }

  private async readUnlocked(defaultValue: T): Promise<T> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if (isNotFound(error)) {
        return defaultValue;
      }

      throw error;
    }
  }

  private async writeUnlocked(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }

  private async withLock<R>(fn: () => Promise<R>): Promise<R> {
    return withFileLock(this.filePath, fn);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function mutexFor(filePath: string): AsyncMutex {
  let mutex = mutexes.get(filePath);
  if (!mutex) {
    mutex = new AsyncMutex();
    mutexes.set(filePath, mutex);
  }
  return mutex;
}

async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return async () => {
        await handle.close();
        await unlink(lockPath).catch((error: unknown) => {
          if (!isNotFound(error)) {
            throw error;
          }
        });
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      if (Date.now() - startedAt > 10_000) {
        throw new Error(`Timed out acquiring JSON store lock: ${lockPath}`);
      }
      await sleep(25);
    }
  }
}

export async function withFileLock<R>(filePath: string, fn: () => Promise<R>): Promise<R> {
  const resolvedPath = resolve(filePath);
  const mutex = mutexFor(resolvedPath);
  return mutex.runExclusive(async () => {
    const release = await acquireFileLock(resolvedPath);
    try {
      return await fn();
    } finally {
      await release();
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
