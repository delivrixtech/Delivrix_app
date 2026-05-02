import {
  buildKillSwitchState,
  defaultKillSwitchState,
  type KillSwitchState,
  type UpdateKillSwitchInput
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

export class LocalFileKillSwitchStore {
  private readonly store: JsonFileStore<KillSwitchState>;

  constructor(filePath = process.env.LOCAL_KILL_SWITCH_FILE ?? "runtime/kill-switch.json") {
    this.store = new JsonFileStore<KillSwitchState>(filePath);
  }

  async get(): Promise<KillSwitchState> {
    return this.store.read(defaultKillSwitchState());
  }

  async update(input: UpdateKillSwitchInput): Promise<KillSwitchState> {
    const state = buildKillSwitchState(input);
    await this.store.write(state);
    return state;
  }
}
