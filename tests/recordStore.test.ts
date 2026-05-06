import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRecordId, mergeRestoreRecord, pruneRecords, RecordStore } from '../src/store/recordStore.js';
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

  test('test_add_duplicate_session_path_expected_preserves_existing_terminal_name', async () => {
    'Pi-side resume event обновляет запись сессии, но не теряет сохранённое название вкладки.';
    const store = new RecordStore(tempDir, () => 20_000);
    const oldRecord = { ...makeRecord('/tmp/session.jsonl', 10_000), terminalName: 'Kind dune' };
    const resumeRecord = { ...makeRecord('/tmp/session.jsonl', 11_000), terminalName: 'bash' };

    await store.add(oldRecord, 30);
    await store.add(resumeRecord, 30);

    expect((await store.read()).records).toEqual([{ ...resumeRecord, terminalName: 'Kind dune' }]);
  });

  test('test_update_terminal_name_expected_updates_matching_session', async () => {
    'Поздний rename terminal tab обновляет сохранённый title snapshot.';
    const store = new RecordStore(tempDir, () => 20_000);
    const targetRecord = makeRecord('/tmp/session.jsonl', 10_000);
    const otherRecord = makeRecord('/tmp/other.jsonl', 11_000);

    await store.add(targetRecord, 30);
    await store.add(otherRecord, 30);
    await store.updateTerminalName('/tmp/session.jsonl', 'Kind dune');

    expect((await store.latest())?.sessionPath).toBe('/tmp/other.jsonl');
    expect((await store.read()).records.find((record) => record.sessionPath === '/tmp/session.jsonl')?.terminalName).toBe('Kind dune');
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

  test('test_merge_restore_record_expected_keeps_restore_attempts', () => {
    'Merge для duplicate sessionPath не сбрасывает recent restore cooldown.';
    const existing = { ...makeRecord('/tmp/session.jsonl', 10_000), restoreAttempts: 1, lastRestoreAt: 12_000 };
    const incoming = makeRecord('/tmp/session.jsonl', 11_000);

    expect(mergeRestoreRecord(incoming, existing)).toMatchObject({
      matchedAt: 11_000,
      restoreAttempts: 1,
      lastRestoreAt: 12_000
    });
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
