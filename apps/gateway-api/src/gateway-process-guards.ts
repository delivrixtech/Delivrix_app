import type { GatewayRuntimeLogger } from "./gateway-runtime-log.ts";
import { noopGatewayRuntimeLogger, runtimeErrorMetadata } from "./gateway-runtime-log.ts";

interface ProcessGuardTarget {
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off?(event: "uncaughtException", listener: (error: Error) => void): unknown;
  off?(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  removeListener?(event: "uncaughtException", listener: (error: Error) => void): unknown;
  removeListener?(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

export interface GatewayProcessGuardOptions {
  shutdown?: (reason: "uncaughtException" | "unhandledRejection") => void;
}

export function installGatewayProcessGuards(
  logger: Pick<GatewayRuntimeLogger, "error"> = noopGatewayRuntimeLogger,
  target: ProcessGuardTarget = process,
  options: GatewayProcessGuardOptions = {}
): () => void {
  const onUncaughtException = (error: Error) => {
    void logger.error(
      "gateway.uncaught_exception",
      "Uncaught exception captured by gateway process guard.",
      runtimeErrorMetadata(error)
    );
    shutdownProcess(options.shutdown, "uncaughtException");
  };
  const onUnhandledRejection = (reason: unknown) => {
    void logger.error(
      "gateway.unhandled_rejection",
      "Unhandled promise rejection captured by gateway process guard.",
      runtimeErrorMetadata(reason)
    );
    shutdownProcess(options.shutdown, "unhandledRejection");
  };

  target.on("uncaughtException", onUncaughtException);
  target.on("unhandledRejection", onUnhandledRejection);

  return () => {
    if (target.off) {
      target.off("uncaughtException", onUncaughtException);
      target.off("unhandledRejection", onUnhandledRejection);
      return;
    }
    target.removeListener?.("uncaughtException", onUncaughtException);
    target.removeListener?.("unhandledRejection", onUnhandledRejection);
  };
}

function shutdownProcess(
  shutdown: GatewayProcessGuardOptions["shutdown"],
  reason: "uncaughtException" | "unhandledRejection"
): void {
  if (shutdown) {
    shutdown(reason);
    return;
  }

  process.exitCode = 1;
  setImmediate(() => process.exit(1)).unref?.();
}
