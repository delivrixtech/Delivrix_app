import {
  noopGatewayRuntimeLogger,
  runtimeErrorMetadata,
  type GatewayRuntimeLogger
} from "./gateway-runtime-log.ts";

interface IntervalHandle {
  unref?: () => unknown;
}

type SetIntervalFn = (handler: () => void, intervalMs: number) => IntervalHandle;

export interface InfrastructureAccountHealthPollerDeps {
  intervalMs: number;
  runPoll: (trigger: "startup" | "interval") => Promise<void>;
  logger?: GatewayRuntimeLogger;
  setIntervalFn?: SetIntervalFn;
}

export function startInfrastructureAccountHealthPoller(
  deps: InfrastructureAccountHealthPollerDeps
): IntervalHandle {
  const logger = deps.logger ?? noopGatewayRuntimeLogger;
  let inFlight = false;

  const trigger = (reason: "startup" | "interval") => {
    if (inFlight) {
      void logger.warn(
        "infrastructure.account_health_poll_skipped",
        "Infrastructure account health poll skipped because a previous poll is still running.",
        { trigger: reason }
      );
      return;
    }
    inFlight = true;
    void deps.runPoll(reason)
      .catch((error) => {
        void logger.warn(
          "infrastructure.account_health_poll_failed",
          "Infrastructure account health poll failed.",
          {
            trigger: reason,
            ...runtimeErrorMetadata(error)
          }
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };

  trigger("startup");
  const setIntervalImpl = deps.setIntervalFn ?? setInterval;
  const interval = setIntervalImpl(() => trigger("interval"), deps.intervalMs);
  interval.unref?.();
  void logger.info(
    "infrastructure.account_health_poll_started",
    "Infrastructure account health poller started.",
    { intervalMs: deps.intervalMs }
  );
  return interval;
}
