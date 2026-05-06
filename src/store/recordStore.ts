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
    const withoutDuplicate = pruned.filter((candidate) => candidate.id !== record.id && candidate.sessionPath !== record.sessionPath);
    await this.save([record, ...withoutDuplicate]);
  }

  public async update(record: RestoreRecord): Promise<void> {
    const data = await this.read();
    await this.save(data.records.map((candidate) => candidate.id === record.id ? record : candidate));
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

function emptyStore(): RecordStoreData {
  return { schemaVersion: SCHEMA_VERSION, records: [] };
}
