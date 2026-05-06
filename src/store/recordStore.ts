import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RecordStoreData, RestoreRecord } from '../types.js';

const SCHEMA_VERSION = 1 as const;

export class RecordStore {
  private readonly filePath: string;

  public constructor(storageDir: string, private readonly now: () => number = Date.now) {
    this.filePath = path.join(storageDir, 'records.json');
  }

  public async read(): Promise<RecordStoreData> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RecordStoreData>;
      if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.records)) {
        return emptyStore();
      }
      return { schemaVersion: SCHEMA_VERSION, records: parsed.records as RestoreRecord[] };
    } catch {
      return emptyStore();
    }
  }

  public async save(records: RestoreRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }, null, 2);
    await writeFile(temporaryPath, `${payload}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  public async add(record: RestoreRecord, ttlDays: number): Promise<void> {
    const data = await this.read();
    const pruned = pruneRecords(data.records, ttlDays, this.now());
    const duplicate = pruned.find((candidate) => candidate.id === record.id || candidate.sessionPath === record.sessionPath);
    const mergedRecord = duplicate ? mergeRestoreRecord(record, duplicate) : record;
    const withoutDuplicate = pruned.filter((candidate) => candidate.id !== record.id && candidate.sessionPath !== record.sessionPath);
    await this.save([mergedRecord, ...withoutDuplicate]);
  }

  public async update(record: RestoreRecord): Promise<void> {
    const data = await this.read();
    await this.save(data.records.map((candidate) => candidate.id === record.id ? record : candidate));
  }

  public async updateTerminalName(sessionPath: string, terminalName: string): Promise<boolean> {
    const normalizedName = terminalName.trim();
    if (normalizedName.length === 0) {
      return false;
    }
    const data = await this.read();
    let changed = false;
    const records = data.records.map((record) => {
      if (record.sessionPath !== sessionPath || record.terminalName === normalizedName) {
        return record;
      }
      changed = true;
      return { ...record, terminalName: normalizedName };
    });
    if (!changed) {
      return false;
    }
    await this.save(records);
    return true;
  }

  public async markTerminalClosed(sessionPath: string, terminalName: string | undefined, closedAt: number): Promise<void> {
    const normalizedName = terminalName?.trim();
    const data = await this.read();
    const records = data.records.map((record) => {
      if (record.sessionPath !== sessionPath) {
        return record;
      }
      const updated: RestoreRecord = { ...record, terminalClosedAt: closedAt };
      if (normalizedName && normalizedName.length > 0) {
        updated.terminalName = normalizedName;
      }
      return updated;
    });
    await this.save(records);
  }

  public async clear(): Promise<void> {
    await this.save([]);
  }

  public async latest(scopeCwd?: string): Promise<RestoreRecord | undefined> {
    return (await this.listForScope(scopeCwd))[0];
  }

  public async listForScope(scopeCwd?: string): Promise<RestoreRecord[]> {
    const data = await this.read();
    const scopedRecords = scopeCwd === undefined
      ? data.records
      : data.records.filter((record) => record.cwd === scopeCwd);
    return [...scopedRecords].sort((left: RestoreRecord, right: RestoreRecord) => right.matchedAt - left.matchedAt);
  }
}

export function createRecordId(sessionPath: string, matchedAt: number): string {
  return `${matchedAt}:${Buffer.from(sessionPath).toString('base64url')}`;
}

export function pruneRecords(records: RestoreRecord[], ttlDays: number, now: number): RestoreRecord[] {
  const ttlMs = ttlDays * 24 * 60 * 60 * 1_000;
  return records.filter((record) => now - record.matchedAt <= ttlMs);
}

export function mergeRestoreRecord(incoming: RestoreRecord, existing: RestoreRecord): RestoreRecord {
  const merged: RestoreRecord = {
    ...existing,
    ...incoming,
    restoreAttempts: Math.max(existing.restoreAttempts, incoming.restoreAttempts)
  };
  if (incoming.args.length === 0 && existing.args.length > 0) {
    merged.command = existing.command;
    merged.args = existing.args;
  }
  if ((incoming.terminalName === undefined || incoming.args.length === 0) && existing.terminalName !== undefined) {
    merged.terminalName = existing.terminalName;
  }
  if (incoming.lastRestoreAt === undefined && existing.lastRestoreAt !== undefined) {
    merged.lastRestoreAt = existing.lastRestoreAt;
  }
  if (existing.terminalClosedAt !== undefined && incoming.startedAt <= existing.terminalClosedAt) {
    merged.terminalClosedAt = existing.terminalClosedAt;
  } else {
    delete merged.terminalClosedAt;
  }
  return merged;
}

function emptyStore(): RecordStoreData {
  return { schemaVersion: SCHEMA_VERSION, records: [] };
}
