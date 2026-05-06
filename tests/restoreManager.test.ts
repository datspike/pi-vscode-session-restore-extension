import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type * as vscode from 'vscode';
import { getRestoreTerminalName, RestoreManager } from '../src/restore/restoreManager.js';
import { createRecordId, RecordStore } from '../src/store/recordStore.js';
import type { ExtensionConfig, RestoreRecord } from '../src/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-restore-manager-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('RestoreManager', () => {
  test('test_restore_last_prompt_without_confirmation_expected_no_terminal_command', async () => {
    'Prompt-режим не выполняет restore без подтверждения.';
    const sessionPath = path.join(tempDir, 'session.jsonl');
    await writeFile(sessionPath, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPath, 10_000, '/work/a'), 30);
    const terminal = makeTerminal();

    const reason = await new RestoreManager(store, makeConfig('prompt')).restoreLast(terminal, '/work/a');

    expect(reason).toBe('restore requires confirmation');
    expect(terminal.commands).toEqual([]);
  });

  test('test_auto_restore_without_scope_expected_skips_global_latest', async () => {
    'Auto-restore не берёт global latest при неизвестном workspace scope.';
    const sessionPath = path.join(tempDir, 'session.jsonl');
    await writeFile(sessionPath, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPath, 10_000, '/work/a'), 30);
    const terminal = makeTerminal();

    const reason = await new RestoreManager(store, makeConfig('auto-confident')).autoRestore(terminal);

    expect(reason).toBe('auto-restore skipped because workspace scope is unknown');
    expect(terminal.commands).toEqual([]);
  });

  test('test_auto_restore_many_scope_expected_restores_two_sessions_in_two_terminals', async () => {
    'Auto-restore восстанавливает две Pi-сессии в две восстановленные вкладки терминала.';
    const sessionPathA = path.join(tempDir, 'a.jsonl');
    const sessionPathB = path.join(tempDir, 'b.jsonl');
    await writeFile(sessionPathA, '{}\n', 'utf8');
    await writeFile(sessionPathB, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPathA, 10_000, '/work/a'), 30);
    await store.add(makeRecord(sessionPathB, 11_000, '/work/a'), 30);
    const firstTerminal = makeTerminal();
    const secondTerminal = makeTerminal();

    const result = await new RestoreManager(store, makeConfig('auto-confident')).autoRestoreMany([firstTerminal, secondTerminal], '/work/a');

    expect(result).toEqual({ restored: 2, skipped: [] });
    expect(firstTerminal.commands).toEqual([`pi --session '${sessionPathA}'`]);
    expect(secondTerminal.commands).toEqual([`pi --session '${sessionPathB}'`]);
  });

  test('test_get_restore_terminal_name_expected_uses_saved_title', () => {
    'Имя терминала для restore берётся из сохранённого title snapshot.';
    expect(getRestoreTerminalName({ ...makeRecord('/tmp/session.jsonl', 10_000, '/work/a'), terminalName: 'Kind dune' })).toBe('Kind dune');
    expect(getRestoreTerminalName(makeRecord('/tmp/session.jsonl', 10_000, '/work/a'))).toBe('Pi Session Restore');
  });

  test('test_auto_restore_records_expected_order_matches_terminal_order', async () => {
    'Записи для multi-restore идут от старой к новой, чтобы порядок вкладок был стабильным.';
    const sessionPathA = path.join(tempDir, 'a.jsonl');
    const sessionPathB = path.join(tempDir, 'b.jsonl');
    await writeFile(sessionPathA, '{}\n', 'utf8');
    await writeFile(sessionPathB, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPathA, 10_000, '/work/a'), 30);
    await store.add(makeRecord(sessionPathB, 11_000, '/work/a'), 30);

    const records = await new RestoreManager(store, makeConfig('auto-confident')).getAutoRestoreRecords('/work/a', 2);

    expect(records.map((record) => record.sessionPath)).toEqual([sessionPathA, sessionPathB]);
  });

  test('test_auto_restore_scope_expected_uses_matching_workspace_record', async () => {
    'Auto-restore выбирает запись только из совпавшего workspace scope.';
    const sessionPathA = path.join(tempDir, 'a.jsonl');
    const sessionPathB = path.join(tempDir, 'b.jsonl');
    await writeFile(sessionPathA, '{}\n', 'utf8');
    await writeFile(sessionPathB, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPathA, 10_000, '/work/a'), 30);
    await store.add(makeRecord(sessionPathB, 11_000, '/work/b'), 30);
    const terminal = makeTerminal();

    const reason = await new RestoreManager(store, makeConfig('auto-confident')).autoRestore(terminal, '/work/a');

    expect(reason).toBe('high-confidence record is eligible for automatic restore');
    expect(terminal.commands).toEqual([`pi --session '${sessionPathA}'`]);
  });
});

interface FakeTerminal extends vscode.Terminal {
  commands: string[];
}

function makeTerminal(): FakeTerminal {
  const commands: string[] = [];
  return {
    commands,
    show: () => undefined,
    sendText: (text: string) => { commands.push(text); }
  } as unknown as FakeTerminal;
}

function makeRecord(sessionPath: string, matchedAt: number, cwd: string): RestoreRecord {
  return {
    id: createRecordId(sessionPath, matchedAt),
    sessionPath,
    cwd,
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

function makeConfig(restorePolicy: ExtensionConfig['restorePolicy']): ExtensionConfig {
  return {
    enabled: true,
    sessionGlobPaths: [],
    restorePolicy,
    confidenceThreshold: 'high',
    diagnosticsLevel: 'off',
    recordTtlDays: 30,
    installPiExtension: true
  };
}
