import type {
  BackupSimulation,
  IpReputationReport,
  SenderNodeProvisioningRun
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

class LocalFileAppendOnlyStore<T extends { id: string }> {
  private readonly store: JsonFileStore<T[]>;

  constructor(filePath: string) {
    this.store = new JsonFileStore<T[]>(filePath);
  }

  async list(): Promise<T[]> {
    return this.store.read([]);
  }

  async append(item: T): Promise<T> {
    const items = await this.store.read([]);
    items.push(item);
    await this.store.write(items);
    return item;
  }
}

export class LocalFileProvisioningRunStore {
  private readonly store: LocalFileAppendOnlyStore<SenderNodeProvisioningRun>;

  constructor(filePath = process.env.LOCAL_PROVISIONING_RUNS_FILE ?? "runtime/provisioning-runs.json") {
    this.store = new LocalFileAppendOnlyStore<SenderNodeProvisioningRun>(filePath);
  }

  async list(): Promise<SenderNodeProvisioningRun[]> {
    return this.store.list();
  }

  async append(run: SenderNodeProvisioningRun): Promise<SenderNodeProvisioningRun> {
    return this.store.append(run);
  }
}

export class LocalFileIpReputationReportStore {
  private readonly store: LocalFileAppendOnlyStore<IpReputationReport>;

  constructor(filePath = process.env.LOCAL_IP_REPUTATION_REPORTS_FILE ?? "runtime/ip-reputation-reports.json") {
    this.store = new LocalFileAppendOnlyStore<IpReputationReport>(filePath);
  }

  async list(): Promise<IpReputationReport[]> {
    return this.store.list();
  }

  async append(report: IpReputationReport): Promise<IpReputationReport> {
    return this.store.append(report);
  }

  async appendMany(reports: IpReputationReport[]): Promise<IpReputationReport[]> {
    for (const report of reports) {
      await this.append(report);
    }

    return reports;
  }
}

export class LocalFileBackupSimulationStore {
  private readonly store: LocalFileAppendOnlyStore<BackupSimulation>;

  constructor(filePath = process.env.LOCAL_BACKUP_SIMULATIONS_FILE ?? "runtime/backup-simulations.json") {
    this.store = new LocalFileAppendOnlyStore<BackupSimulation>(filePath);
  }

  async list(): Promise<BackupSimulation[]> {
    return this.store.list();
  }

  async append(simulation: BackupSimulation): Promise<BackupSimulation> {
    return this.store.append(simulation);
  }
}
