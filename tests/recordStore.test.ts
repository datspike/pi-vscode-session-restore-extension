import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRecordId, pruneRecords, RecordStore } from '../src/store/recordStore.js';
import type { RestoreRecord } from '../src/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-record-store-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('RecordStore', () => {
  test('test_add_and_latest_expected_record_roundtrip', async () => {
    'Запись сохраняется и читается как latest.';
    const store = new RecordStore(tempDir, () => 20_000);
    const record = makeRecord('/tmp/session.jsonl', 10_000);

    await store.add(record, 30);

    expect(await store.latest()).toEqual(record);
    expect((await store.read()).schemaVersion).toBe(1);
  });

  test('test_add_duplicate_session_path_expected_replaces_old_record', async () => {
    'Повторная запись того же sessionPath заменяет старую запись от другого окна VS Code.';
    const store = new RecordStore(tempDir, () => 20_000);
    const oldRecord = makeRecord('/tmp/session.jsonl', 10_000);
    const newRecord = makeRecord('/tmp/session.jsonl', 11_000);

    await store.add(oldRecord, 30);
    await store.add(newRecord, 30);

    expect((await store.read()).records).toEqual([newRecord]);
  });

  test('test_latest_with_scope_expected_ignores_other_workspaces', async () => {
    'Scoped latest не берёт запись из другого проекта.';
    const store = new RecordStore(tempDir, () => 20_000);
    const oldRecord = { ...makeRecord('/tmp/old.jsonl', 10_000), cwd: '/work/a' };
    const newRecord = { ...makeRecord('/tmp/new.jsonl', 11_000), cwd: '/work/b' };

    await store.add(oldRecord, 30);
    await store.add(newRecord, 30);

    expect(await store.latest('/work/a')).toEqual(oldRecord);
    expect(await store.latest('/work/missing')).toBeUndefined();
  });

  test('test_corrupt_store_expected_empty_store', async () => {
    'Повреждённый JSON восстанавливается как пустое хранилище.';
    await writeFile(path.join(tempDir, 'records.json'), '{bad', 'utf8');
    const store = new RecordStore(tempDir);
    expect(await store.read()).toEqual({ schemaVersion: 1, records: [] });
  });

  test('test_prune_records_expected_keeps_fresh_records', () => {
    'TTL удаляет только устаревшие записи.';
    const fresh = makeRecord('/tmp/fresh.jsonl', 90_000_000);
    const stale = makeRecord('/tmp/stale.jsonl', 1_000);
    expect(pruneRecords([fresh, stale], 1, 90_000_001)).toEqual([fresh]);
  });

  test('test_create_record_id_expected_stable_path_payload', () => {
    'Идентификатор включает время и путь в base64url.';
    expect(createRecordId('/tmp/session.jsonl', 123)).toBe('123:L3RtcC9zZXNzaW9uLmpzb25s');
  });
});

function makeRecord(sessionPath: string, matchedAt: number): RestoreRecord {
  return {
    id: createRecordId(sessionPath, matchedAt),
    sessionPath,
    command: 'pi',
    args: [],
    startedAt: matchedAt - 1_000,
    matchedAt,
    confidence: 'high',
    score: 100,
    reasons: ['test'],
    restoreAttempts: 0
  };
}
