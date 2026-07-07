// Logger estructurado (JSON line) con redaccion de secretos. En CI todo lo que
// va a stdout queda en el log publico del run, asi que nunca debemos imprimir
// el token de GitHub ni la API key de Anthropic ni el contenido del diff.

export type LogLevel = "info" | "warn" | "error";

const secrets = new Set<string>();

// Registra valores que deben ser tachados de cualquier salida de log.
export function registerSecret(value: string): void {
  if (typeof value === "string" && value.length >= 8) {
    secrets.add(value);
  }
}

function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    component: "qa-auditor",
    message
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = value;
    }
  }
  const line = redact(JSON.stringify(entry));
  if (level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const log = {
  info(message: string, fields?: Record<string, unknown>): void {
    emit("info", message, fields);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    emit("warn", message, fields);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    emit("error", message, fields);
  }
};
