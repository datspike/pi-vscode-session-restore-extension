import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type * as vscode from 'vscode';
import {
  getRestoreTerminalName,
  isAutoRestorableRecord,
  RestoreManager,
  selectAutoRestorePairs,
  selectMissingAutoCreateRecords
} from '../src/restore/restoreManager.js';
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

  test('test_restore_last_without_scope_expected_prompts_before_global_latest_restore', async () => {
    'Restore Last при неизвестном scope не восстанавливает global latest без подтверждения.';
    const workspaceSessionPath = path.join(tempDir, 'workspace.jsonl');
    const otherSessionPath = path.join(tempDir, 'other.jsonl');
    await writeFile(workspaceSessionPath, '{}\n', 'utf8');
    await writeFile(otherSessionPath, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(workspaceSessionPath, 10_000, '/work/a'), 30);
    await store.add(makeRecord(otherSessionPath, 11_000, '/other/project'), 30);
    const terminal = makeTerminal();
    const promptedRecords: RestoreRecord[] = [];

    const reason = await new RestoreManager(store, makeConfig('auto-confident')).restoreLast(terminal, undefined, async (record) => {
      promptedRecords.push(record);
      return false;
    });

    expect(reason).toBe('restore cancelled by user');
    expect(promptedRecords.map((record) => ({ cwd: record.cwd, sessionPath: record.sessionPath }))).toEqual([
      { cwd: '/other/project', sessionPath: otherSessionPath }
    ]);
    expect(terminal.commands).toEqual([]);
  });

  test('test_restore_last_workspace_scope_expected_ignores_newer_record_from_other_project', async () => {
    'Restore Last с workspace scope выбирает последнюю запись текущего проекта.';
    const workspaceSessionPath = path.join(tempDir, 'workspace.jsonl');
    const otherSessionPath = path.join(tempDir, 'other.jsonl');
    await writeFile(workspaceSessionPath, '{}\n', 'utf8');
    await writeFile(otherSessionPath, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(workspaceSessionPath, 10_000, '/work/a'), 30);
    await store.add(makeRecord(otherSessionPath, 11_000, '/other/project'), 30);
    const terminal = makeTerminal();

    const reason = await new RestoreManager(store, makeConfig('auto-confident')).restoreLast(terminal, '/work/a');

    expect(reason).toBe('high-confidence record is eligible for automatic restore');
    expect(terminal.commands).toEqual([`pi --session '${workspaceSessionPath}'`]);
  });

  test('test_auto_restore_targets_explicit_cwd_expected_restores_two_sessions_in_two_terminals', async () => {
    'Auto-restore восстанавливает Pi-сессии во вкладки с явным cwd-сигналом.';
    const sessionPathA = path.join(tempDir, 'a.jsonl');
    const sessionPathB = path.join(tempDir, 'b.jsonl');
    await writeFile(sessionPathA, '{}\n', 'utf8');
    await writeFile(sessionPathB, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPathA, 10_000, '/work/a'), 30);
    await store.add(makeRecord(sessionPathB, 11_000, '/work/a'), 30);
    const firstTerminal = makeTerminal();
    const secondTerminal = makeTerminal();

    const result = await new RestoreManager(store, makeConfig('auto-confident')).autoRestoreTargets([
      { terminal: firstTerminal, cwd: '/work/a' },
      { terminal: secondTerminal, cwd: '/work/a' }
    ], '/work/a');

    expect(result).toEqual({ restored: 2, skipped: [] });
    expect(firstTerminal.commands).toEqual([`pi --session '${sessionPathA}'`]);
    expect(secondTerminal.commands).toEqual([`pi --session '${sessionPathB}'`]);
  });

  test('test_auto_restore_many_without_terminal_evidence_expected_skips_ordinary_idle_terminal', async () => {
    'Обычная неактивная вкладка без названия и cwd не получает запасную запись.';
    const sessionPath = path.join(tempDir, 'session.jsonl');
    await writeFile(sessionPath, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPath, 10_000, '/work/a'), 30);
    const terminal = makeTerminal();

    const result = await new RestoreManager(store, makeConfig('auto-confident')).autoRestoreMany([terminal], '/work/a');

    expect(result).toEqual({
      restored: 0,
      skipped: [
        'auto-restore skipped because no eligible records matched workspace scope',
        'auto-restore skipped for unnamed terminal because no eligible record matched terminal cwd/title within workspace scope'
      ]
    });
    expect(terminal.commands).toEqual([]);
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

  test('test_auto_restore_records_expected_skips_closed_terminal_record', async () => {
    'Auto-restore не восстанавливает запись, если пользователь закрыл её terminal tab.';
    const sessionPathA = path.join(tempDir, 'a.jsonl');
    const sessionPathB = path.join(tempDir, 'b.jsonl');
    await writeFile(sessionPathA, '{}\n', 'utf8');
    await writeFile(sessionPathB, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add({ ...makeRecord(sessionPathA, 10_000, '/work/a'), terminalClosedAt: 12_000 }, 30);
    await store.add(makeRecord(sessionPathB, 11_000, '/work/a'), 30);

    const records = await new RestoreManager(store, makeConfig('auto-confident')).getAutoRestoreRecords('/work/a', 2);

    expect(records.map((record) => record.sessionPath)).toEqual([sessionPathB]);
  });

  test('test_is_auto_restorable_record_expected_false_for_closed_terminal', () => {
    'Закрытая пользователем вкладка не подходит для auto-restore.';
    expect(isAutoRestorableRecord(makeRecord('/tmp/open.jsonl', 10_000, '/work/a'))).toBe(true);
    expect(isAutoRestorableRecord({ ...makeRecord('/tmp/closed.jsonl', 10_000, '/work/a'), terminalClosedAt: 12_000 })).toBe(false);
  });

  test('test_execute_restore_with_terminal_name_expected_invokes_renamer_before_command', async () => {
    'Restore применяет сохранённое имя вкладки перед запуском pi.';
    const sessionPath = path.join(tempDir, 'session.jsonl');
    await writeFile(sessionPath, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    const record = { ...makeRecord(sessionPath, 10_000, '/work/a'), terminalName: 'Pi-test-1' };
    await store.add(record, 30);
    const terminal = makeTerminal();
    const renamed: string[] = [];

    await new RestoreManager(store, makeConfig('auto-confident'), async (_terminal, name) => {
      renamed.push(name);
    }).executeRestore(terminal, record);

    expect(renamed).toEqual(['Pi-test-1']);
    expect(terminal.commands).toEqual([`pi --session '${sessionPath}'`]);
  });

  test('test_auto_restore_targets_expected_matches_records_by_terminal_title', async () => {
    'Auto-restore сопоставляет восстановленные terminal tabs с records по названию вкладки.';
    const sessionPathA = path.join(tempDir, 'a.jsonl');
    const sessionPathB = path.join(tempDir, 'b.jsonl');
    await writeFile(sessionPathA, '{}\n', 'utf8');
    await writeFile(sessionPathB, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add({ ...makeRecord(sessionPathA, 10_000, '/work/a'), terminalName: 'Pi test 1' }, 30);
    await store.add({ ...makeRecord(sessionPathB, 11_000, '/work/a'), terminalName: 'Pi test 2' }, 30);
    const firstTerminal = makeTerminal();
    const secondTerminal = makeTerminal();

    const result = await new RestoreManager(store, makeConfig('auto-confident')).autoRestoreTargets([
      { terminal: firstTerminal, title: 'Pi test 1' },
      { terminal: secondTerminal, title: 'Pi test 2' }
    ], '/work/a');

    expect(result).toEqual({ restored: 2, skipped: [] });
    expect(firstTerminal.commands).toEqual([`pi --session '${sessionPathA}'`]);
    expect(secondTerminal.commands).toEqual([`pi --session '${sessionPathB}'`]);
  });

  test('test_select_auto_restore_pairs_expected_title_match_beats_newer_fallback', () => {
    'Title match выбирает старую подходящую запись вместо более новой записи другой вкладки.';
    const oldMatchingRecord = { ...makeRecord('/tmp/a.jsonl', 10_000, '/work/a'), terminalName: 'Pi test 1' };
    const newOtherRecord = { ...makeRecord('/tmp/b.jsonl', 12_000, '/work/a'), terminalName: 'Pi test 2' };
    const target = { terminal: makeTerminal(), title: 'Pi test 1' };

    expect(selectAutoRestorePairs([oldMatchingRecord, newOtherRecord], [target])).toEqual([{ target, record: oldMatchingRecord }]);
  });

  test('test_select_auto_restore_pairs_ambiguous_ordinary_terminal_expected_does_not_receive_fallback_record', () => {
    'Обычная неактивная вкладка без совпадающего названия и cwd не получает запасную запись при неоднозначности.';
    const matchingRecord = { ...makeRecord('/tmp/a.jsonl', 10_000, '/work/a'), terminalName: 'Pi test 1' };
    const fallbackRecord = { ...makeRecord('/tmp/b.jsonl', 12_000, '/work/a'), terminalName: 'Pi test 2' };
    const piTarget = { terminal: makeTerminal(), title: 'Pi test 1' };
    const ordinaryTarget = { terminal: makeTerminal(), title: 'bash' };

    expect(selectAutoRestorePairs([matchingRecord, fallbackRecord], [piTarget, ordinaryTarget], '/work/a')).toEqual([
      { target: piTarget, record: matchingRecord }
    ]);
  });

  test('test_select_auto_restore_pairs_expected_restored_terminal_title_overrides_closed_marker', () => {
    'Если VS Code восстановил вкладку с тем же title, closed marker считается shutdown-шумом.';
    const closedButVisibleRecord = { ...makeRecord('/tmp/a.jsonl', 10_000, '/work/a'), terminalName: 'Pi test 1', terminalClosedAt: 12_000 };
    const target = { terminal: makeTerminal(), title: 'Pi test 1' };

    expect(selectAutoRestorePairs([closedButVisibleRecord], [target])).toEqual([{ target, record: closedButVisibleRecord }]);
  });

  test('test_select_auto_restore_pairs_expected_latest_resume_wins_same_title', () => {
    'При нескольких resume в одной вкладке выигрывает последняя сессия с тем же title.';
    const firstResume = { ...makeRecord('/tmp/first.jsonl', 10_000, '/work/a'), terminalName: 'Pi test 2', terminalClosedAt: 12_000 };
    const secondResume = { ...makeRecord('/tmp/second.jsonl', 13_000, '/work/a'), terminalName: 'Pi test 2' };
    const target = { terminal: makeTerminal(), title: 'Pi test 2' };

    expect(selectAutoRestorePairs([firstResume, secondResume], [target])).toEqual([{ target, record: secondResume }]);
  });

  test('test_select_auto_restore_pairs_duplicate_titles_ambiguous_order_expected_skips_fallback', () => {
    'Одинаковые titles без cwd-сигнала не раскладываются по порядку вкладок.';
    const oldRecord = { ...makeRecord('/tmp/old.jsonl', 10_000, '/work/a'), terminalName: 'pi' };
    const newRecord = { ...makeRecord('/tmp/new.jsonl', 12_000, '/work/a'), terminalName: 'pi' };
    const firstTarget = { terminal: makeTerminal(), title: 'pi' };
    const secondTarget = { terminal: makeTerminal(), title: 'pi' };

    expect(selectAutoRestorePairs([oldRecord, newRecord], [firstTarget, secondTarget])).toEqual([]);
  });

  test('test_select_auto_restore_pairs_duplicate_titles_with_cwd_expected_uses_cwd_fallback_order', () => {
    'Одинаковые shell titles с cwd-сигналом восстанавливаются по порядку вкладок внутри проекта.';
    const oldRecord = { ...makeRecord('/tmp/old.jsonl', 10_000, '/work/a'), terminalName: 'Pi work' };
    const newRecord = { ...makeRecord('/tmp/new.jsonl', 12_000, '/work/a'), terminalName: 'Pi test 2' };
    const firstTarget = { terminal: makeTerminal(), title: 'bash', cwd: '/work/a' };
    const secondTarget = { terminal: makeTerminal(), title: 'bash', cwd: '/work/a' };

    expect(selectAutoRestorePairs([oldRecord, newRecord], [firstTarget, secondTarget], '/work/a')).toEqual([
      { target: firstTarget, record: oldRecord },
      { target: secondTarget, record: newRecord }
    ]);
  });

  test('test_select_missing_auto_create_records_expected_only_previously_restored_unpaired_records', () => {
    'Недостающие auto-created вкладки выбираются только из ранее восстановленных records.';
    const pairedRecord = { ...makeRecord('/tmp/paired.jsonl', 12_000, '/work/a'), lastRestoreAt: 15_000 };
    const missingRecord = { ...makeRecord('/tmp/missing.jsonl', 10_000, '/work/a'), lastRestoreAt: 15_000 };
    const staleManualRecord = makeRecord('/tmp/manual.jsonl', 11_000, '/work/a');
    const target = { terminal: makeTerminal(), cwd: '/work/a' };

    expect(selectMissingAutoCreateRecords([missingRecord, staleManualRecord, pairedRecord], [{ target, record: pairedRecord }])).toEqual([missingRecord]);
  });

  test('test_select_auto_restore_pairs_duplicate_titles_closed_markers_expected_skip_ambiguous_fallback', () => {
    'Одинаковые visible titles с closed markers не восстанавливаются по неоднозначному порядку вкладок.';
    const oldRecord = { ...makeRecord('/tmp/old.jsonl', 10_000, '/work/a'), terminalName: 'pi', terminalClosedAt: 12_500 };
    const newRecord = { ...makeRecord('/tmp/new.jsonl', 12_000, '/work/a'), terminalName: 'pi', terminalClosedAt: 12_500 };
    const firstTarget = { terminal: makeTerminal(), title: 'pi' };
    const secondTarget = { terminal: makeTerminal(), title: 'pi' };

    expect(selectAutoRestorePairs([oldRecord, newRecord], [firstTarget, secondTarget])).toEqual([]);
  });

  test('test_select_auto_restore_pairs_closed_title_expected_not_used_for_unrelated_target', () => {
    'Closed marker не попадает fallback-ом во вкладку с другим title.';
    const openAlpha = { ...makeRecord('/tmp/alpha-open.jsonl', 14_000, '/work/a'), terminalName: 'Alpha' };
    const closedAlpha = { ...makeRecord('/tmp/alpha-closed.jsonl', 12_000, '/work/a'), terminalName: 'Alpha', terminalClosedAt: 13_000 };
    const betaTarget = { terminal: makeTerminal(), title: 'Beta' };
    const alphaTarget = { terminal: makeTerminal(), title: 'Alpha' };

    expect(selectAutoRestorePairs([closedAlpha, openAlpha], [alphaTarget, betaTarget])).toEqual([
      { target: alphaTarget, record: openAlpha }
    ]);
  });

  test('test_auto_restore_concurrent_managers_same_scope_expected_claims_record_once', async () => {
    'Два менеджера на одном global storage не восстанавливают одну запись дважды.';
    const scopeCwd = '/work/a';
    const sessionPath = path.join(tempDir, 'session.jsonl');
    await writeFile(sessionPath, '{}\n', 'utf8');
    const writerStore = new RecordStore(tempDir, () => 20_000);
    await writerStore.add(makeRecord(sessionPath, 10_000, scopeCwd), 30);
    const firstStore = new RecordStore(tempDir, () => 20_000);
    const secondStore = new RecordStore(tempDir, () => 20_000);
    synchronizeListForScope([firstStore, secondStore], 2);
    const firstTerminal = makeTerminal();
    const secondTerminal = makeTerminal();

    const results = await Promise.all([
      new RestoreManager(firstStore, makeConfig('auto-confident')).autoRestoreTargets([{ terminal: firstTerminal, cwd: scopeCwd }], scopeCwd),
      new RestoreManager(secondStore, makeConfig('auto-confident')).autoRestoreTargets([{ terminal: secondTerminal, cwd: scopeCwd }], scopeCwd)
    ]);

    expect(results.map((result) => result.restored).sort()).toEqual([0, 1]);
    expect([...firstTerminal.commands, ...secondTerminal.commands]).toEqual([`pi --session '${sessionPath}'`]);
    expect((await writerStore.latest(scopeCwd))?.restoreAttempts).toBe(1);
  });

  test('test_auto_restore_scope_without_terminal_evidence_expected_skips_matching_workspace_record', async () => {
    'Auto-restore не использует workspace scope как единственный сигнал для обычной неактивной вкладки.';
    const sessionPathA = path.join(tempDir, 'a.jsonl');
    const sessionPathB = path.join(tempDir, 'b.jsonl');
    await writeFile(sessionPathA, '{}\n', 'utf8');
    await writeFile(sessionPathB, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPathA, 10_000, '/work/a'), 30);
    await store.add(makeRecord(sessionPathB, 11_000, '/work/b'), 30);
    const terminal = makeTerminal();

    const reason = await new RestoreManager(store, makeConfig('auto-confident')).autoRestore(terminal, '/work/a');

    expect(reason).toBe('auto-restore skipped because no eligible records matched workspace scope; auto-restore skipped for unnamed terminal because no eligible record matched terminal cwd/title within workspace scope');
    expect(terminal.commands).toEqual([]);
  });

  test('test_auto_restore_targets_workspace_scope_expected_matches_each_terminal_cwd', async () => {
    'Auto-restore в одном workspace сопоставляет записи из подпапок с точным cwd каждой вкладки.';
    const sessionPathApi = path.join(tempDir, 'api.jsonl');
    const sessionPathWeb = path.join(tempDir, 'web.jsonl');
    const otherSessionPath = path.join(tempDir, 'other.jsonl');
    await writeFile(sessionPathApi, '{}\n', 'utf8');
    await writeFile(sessionPathWeb, '{}\n', 'utf8');
    await writeFile(otherSessionPath, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPathApi, 10_000, '/repo/api'), 30);
    await store.add(makeRecord(sessionPathWeb, 11_000, '/repo/web'), 30);
    await store.add(makeRecord(otherSessionPath, 12_000, '/other/project'), 30);
    const apiTerminal = makeTerminal();
    const webTerminal = makeTerminal();

    const result = await new RestoreManager(store, makeConfig('auto-confident')).autoRestoreTargets([
      { terminal: apiTerminal, cwd: '/repo/api' },
      { terminal: webTerminal, cwd: '/repo/web' }
    ], '/repo');

    expect(result).toEqual({ restored: 2, skipped: [] });
    expect(apiTerminal.commands).toEqual([`pi --session '${sessionPathApi}'`]);
    expect(webTerminal.commands).toEqual([`pi --session '${sessionPathWeb}'`]);
  });

  test('test_auto_restore_targets_narrow_scope_expected_skips_terminal_outside_scope', async () => {
    'Auto-restore не берёт запись из соседней подпапки, если global scope сужен до другой подпапки.';
    const sessionPathApi = path.join(tempDir, 'api.jsonl');
    const sessionPathWeb = path.join(tempDir, 'web.jsonl');
    await writeFile(sessionPathApi, '{}\n', 'utf8');
    await writeFile(sessionPathWeb, '{}\n', 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    await store.add(makeRecord(sessionPathApi, 10_000, '/repo/api'), 30);
    await store.add(makeRecord(sessionPathWeb, 11_000, '/repo/web'), 30);
    const apiTerminal = makeTerminal();
    const webTerminal = makeTerminal();

    const result = await new RestoreManager(store, makeConfig('auto-confident')).autoRestoreTargets([
      { terminal: apiTerminal, cwd: '/repo/api' },
      { terminal: webTerminal, cwd: '/repo/web' }
    ], '/repo/api');

    expect(result.restored).toBe(1);
    expect(result.skipped).toEqual([
      'auto-restore skipped for unnamed terminal (/repo/web) because no eligible record matched terminal cwd/title within workspace scope'
    ]);
    expect(apiTerminal.commands).toEqual([`pi --session '${sessionPathApi}'`]);
    expect(webTerminal.commands).toEqual([]);
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

function synchronizeListForScope(stores: RecordStore[], expectedCalls: number): void {
  let calls = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const store of stores) {
    const originalListForScope = store.listForScope.bind(store);
    store.listForScope = async (scopeCwd?: string) => {
      const records = await originalListForScope(scopeCwd);
      calls += 1;
      if (calls >= expectedCalls) {
        release?.();
      }
      await barrier;
      return records;
    };
  }
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
