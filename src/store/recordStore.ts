import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RecordStoreData, RestoreRecord } from '../types.js';

const SCHEMA_VERSION = 1 as const;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

export class RecordStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  public constructor(storageDir: string, private readonly now: () => number = Date.now) {
    this.filePath = path.join(storageDir, 'records.json');
    this.lockPath = `${this.filePath}.lock`;
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
    await this.withStoreLock(async () => {
      await this.writeRecords(records);
    });
  }

  public async add(record: RestoreRecord, ttlDays: number): Promise<void> {
    await this.withStoreLock(async () => {
      const data = await this.read();
      const pruned = pruneRecords(data.records, ttlDays, this.now());
      const duplicate = pruned.find((candidate) => candidate.id === record.id || candidate.sessionPath === record.sessionPath);
      const mergedRecord = duplicate ? mergeRestoreRecord(record, duplicate) : record;
      const withoutDuplicate = pruned.filter((candidate) => candidate.id !== record.id && candidate.sessionPath !== record.sessionPath);
      await this.writeRecords([mergedRecord, ...withoutDuplicate]);
    });
  }

  public async update(record: RestoreRecord): Promise<void> {
    await this.withStoreLock(async () => {
      const data = await this.read();
      await this.writeRecords(data.records.map((candidate) => candidate.id === record.id ? mergeRestoreRecord(record, candidate) : candidate));
    });
  }

  public async updateTerminalName(sessionPath: string, terminalName: string): Promise<boolean> {
    const normalizedName = terminalName.trim();
    if (normalizedName.length === 0) {
      return false;
    }
    return this.withStoreLock(async () => {
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
      await this.writeRecords(records);
      return true;
    });
  }

  public async markTerminalClosed(sessionPath: string, terminalName: string | undefined, closedAt: number): Promise<void> {
    const normalizedName = terminalName?.trim();
    await this.withStoreLock(async () => {
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
      await this.writeRecords(records);
    });
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

  private async writeRecords(records: RestoreRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }, null, 2);
    await writeFile(temporaryPath, `${payload}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async acquireLock(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    while (true) {
      try {
        await mkdir(this.lockPath);
        return;
      } catch (error: unknown) {
        if (!isFileExistsError(error)) {
          throw error;
        }
        await this.removeStaleLock();
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const lockStat = await stat(this.lockPath);
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isFileExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
