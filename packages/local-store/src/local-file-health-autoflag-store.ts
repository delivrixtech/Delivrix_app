import {
  emptyHealthAutoFlagState,
  type HealthAutoFlagState
} from "../../domain/src/health-autoflag.ts";
import { JsonFileStore } from "./json-file-store.ts";

/**
 * Estado persistente del health auto-flag (open flags para dedupe +
 * historial diario de reply rate para la regla de 3 días).
 *
 * Sigue el mismo patrón de persistencia local que el resto del health agent:
 * archivo JSON en runtime/ configurable por env.
 */
export class LocalFileHealthAutoFlagStore {
  private readonly store: JsonFileStore<HealthAutoFlagState>;

  constructor(filePath = process.env.LOCAL_HEALTH_AUTOFLAG_STATE_FILE ?? "runtime/health-autoflag-state.json") {
    this.store = new JsonFileStore<HealthAutoFlagState>(filePath);
  }

  async get(): Promise<HealthAutoFlagState> {
    const state = await this.store.read(emptyHealthAutoFlagState());
    return {
      version: 1,
      openFlags: Array.isArray(state?.openFlags) ? state.openFlags : [],
      replyRateHistory:
        state?.replyRateHistory && typeof state.replyRateHistory === "object"
          ? state.replyRateHistory
          : {}
    };
  }

  async set(state: HealthAutoFlagState): Promise<void> {
    await this.store.write(state);
  }
}
