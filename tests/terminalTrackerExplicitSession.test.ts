import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Logger } from '../src/log.js';
import { RecordStore } from '../src/store/recordStore.js';
import type { ExtensionConfig } from '../src/types.js';

const vscodeMock = vi.hoisted(() => ({
  terminals: [] as vscode.Terminal[],
  tabGroups: [] as vscode.TabGroup[],
  TabInputTerminal: class TabInputTerminal {},
  onDidStartTerminalShellExecution: vi.fn(() => ({ dispose: vi.fn() })),
  onDidEndTerminalShellExecution: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeTerminalState: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeActiveTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() }))
}));

vi.mock('vscode', () => ({
  window: {
    get terminals() {
      return vscodeMock.terminals;
    },
    onDidStartTerminalShellExecution: vscodeMock.onDidStartTerminalShellExecution,
    onDidEndTerminalShellExecution: vscodeMock.onDidEndTerminalShellExecution,
    onDidChangeTerminalState: vscodeMock.onDidChangeTerminalState,
    onDidChangeActiveTerminal: vscodeMock.onDidChangeActiveTerminal,
    onDidCloseTerminal: vscodeMock.onDidCloseTerminal,
    tabGroups: {
      get all() {
        return vscodeMock.tabGroups;
      },
      onDidChangeTabs: vscodeMock.onDidChangeTabs
    }
  },
  TabInputTerminal: vscodeMock.TabInputTerminal
}));

const { TerminalTracker } = await import('../src/tracker/terminalTracker.js');

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-terminal-tracker-'));
  vscodeMock.terminals = [];
  vscodeMock.tabGroups = [];
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('TerminalTracker lifecycle', () => {
  test('test_on_terminal_close_with_reused_shell_pid_expected_new_terminal_does_not_update_old_record', async () => {
    'Закрытие terminal очищает live-привязку shellPid и не даёт новому terminal с тем же pid обновить старый record.';
    vi.useFakeTimers({ now: 20_000 });
    const sessionPath = path.join(tempDir, 'session.jsonl');
    await writeFile(sessionPath, `${JSON.stringify({ cwd: tempDir, id: 'session-a' })}\n`, 'utf8');
    const closedTerminal = makeTerminal('Closed Pi', 123);
    const store = new RecordStore(tempDir, () => 20_000);
    const tracker = new TerminalTracker(store, () => makeConfig([]), makeLogger());
    vscodeMock.terminals = [closedTerminal];

    await tracker.ingestEvents([{
      event: 'pi-session-start',
      time: 10_000,
      cwd: tempDir,
      pid: 456,
      ppid: 123,
      sessionPath
    }]);
    await trackerHarness(tracker).onTerminalClose(closedTerminal);
    const reusedTerminal = makeTerminal('Reused Pi', 123);
    vscodeMock.terminals = [reusedTerminal];

    await expect(trackerHarness(tracker).refreshTerminalName(reusedTerminal)).resolves.toBe(false);

    const recordsBeforeMarker = (await store.read()).records;
    expect(recordsBeforeMarker).toHaveLength(1);
    const recordBeforeMarker = recordsBeforeMarker[0];
    expect(recordBeforeMarker).toBeDefined();
    expect(recordBeforeMarker!).toMatchObject({
      sessionPath,
      terminalName: 'Closed Pi'
    });
    expect(recordBeforeMarker!.terminalClosedAt).toBeUndefined();

    await tracker.ingestWrapperEvents([{
      event: 'pi-wrapper-invocation',
      time: 19_000,
      cwd: tempDir,
      argv: ['pi', '--session', sessionPath],
      pid: 789,
      ppid: 123
    }]);
    await expect(trackerHarness(tracker).refreshTerminalName(reusedTerminal)).resolves.toBe(false);
    const recordsAfterWrapperLog = (await store.read()).records;
    expect(recordsAfterWrapperLog[0]!).toMatchObject({
      sessionPath,
      terminalName: 'Closed Pi'
    });
  });

  test('test_on_terminal_close_with_known_session_expected_marks_closed_record_after_delay', async () => {
    'Закрытие terminal сохраняет delayed close marker для реально закрытого record.';
    vi.spyOn(Date, 'now').mockReturnValue(30_000);
    const sessionPath = path.join(tempDir, 'session.jsonl');
    const terminal = makeTerminal('Closed Pi', 123);
    const store = new RecordStore(tempDir, () => 30_000);
    const tracker = new TerminalTracker(store, () => makeConfig([]), makeLogger());
    vscodeMock.terminals = [terminal];

    await tracker.ingestEvents([{
      event: 'pi-session-start',
      time: 10_000,
      cwd: tempDir,
      pid: 456,
      ppid: 123,
      sessionPath
    }]);
    await trackerHarness(tracker).onTerminalClose(terminal);
    await delay(1_600);

    const records = (await store.read()).records;
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toBeDefined();
    expect(record!).toMatchObject({
      sessionPath,
      terminalName: 'Closed Pi',
      terminalClosedAt: 30_000
    });
  });
});

describe('TerminalTracker explicit wrapper session', () => {
  test('test_ingest_wrapper_event_with_explicit_session_argv_expected_stores_record_without_pi_side_event', async () => {
    'Explicit --session из wrapper argv создаёт record без Pi-side session_start события.';
    const cwd = path.join(tempDir, 'project');
    const sessionPath = path.join(tempDir, 'session.jsonl');
    await writeFile(sessionPath, `${JSON.stringify({ cwd, id: 'session-a' })}\n`, 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    const tracker = new TerminalTracker(store, () => makeConfig([]), makeLogger());

    await tracker.ingestWrapperEvents([{
      event: 'pi-wrapper-invocation',
      time: 10_000,
      cwd,
      argv: ['pi', '--session', sessionPath],
      pid: 101,
      ppid: 100
    }]);

    const records = (await store.read()).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionPath,
      cwd,
      command: 'pi',
      args: ['--session', sessionPath],
      wrapperPid: 101,
      wrapperPpid: 100,
      confidence: 'high',
      score: 100,
      reasons: ['wrapper reported explicit Pi session path']
    });
  });

  test('test_ingest_wrapper_event_with_resume_slash_expected_does_not_store_direct_record_without_pi_side_event', async () => {
    'Slash-команды внутри Pi остаются границей Pi-side reporter и не угадываются wrapper argv.';
    const store = new RecordStore(tempDir, () => 20_000);
    const tracker = new TerminalTracker(store, () => makeConfig([]), makeLogger());

    await tracker.ingestWrapperEvents([{
      event: 'pi-wrapper-invocation',
      time: 10_000,
      cwd: path.join(tempDir, 'project'),
      argv: ['pi', '/resume'],
      pid: 101,
      ppid: 100
    }]);

    expect((await store.read()).records).toEqual([]);
  });

  test('test_ingest_wrapper_event_with_foreign_explicit_session_expected_skips_direct_record', async () => {
    'Explicit --session не принимается, если cwd в session JSONL не совпадает с cwd запуска.';
    const sessionPath = path.join(tempDir, 'session.jsonl');
    await writeFile(sessionPath, `${JSON.stringify({ cwd: path.join(tempDir, 'other'), id: 'session-a' })}\n`, 'utf8');
    const store = new RecordStore(tempDir, () => 20_000);
    const tracker = new TerminalTracker(store, () => makeConfig([]), makeLogger());

    await tracker.ingestWrapperEvents([{
      event: 'pi-wrapper-invocation',
      time: 10_000,
      cwd: path.join(tempDir, 'project'),
      argv: ['pi', '--session', sessionPath],
      pid: 101,
      ppid: 100
    }]);

    expect((await store.read()).records).toEqual([]);
  });
});

type TerminalTrackerHarness = {
  onTerminalClose: (terminal: vscode.Terminal) => Promise<void>;
  refreshTerminalName: (terminal: vscode.Terminal) => Promise<boolean>;
};

function trackerHarness(tracker: InstanceType<typeof TerminalTracker>): TerminalTrackerHarness {
  return tracker as unknown as TerminalTrackerHarness;
}

function makeTerminal(name: string, processId: number): vscode.Terminal {
  return {
    name,
    processId: Promise.resolve(processId)
  } as unknown as vscode.Terminal;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeConfig(sessionGlobPaths: string[]): ExtensionConfig {
  return {
    enabled: true,
    sessionGlobPaths,
    restorePolicy: 'auto-confident',
    confidenceThreshold: 'high',
    diagnosticsLevel: 'debug',
    recordTtlDays: 30,
    installPiExtension: true
  };
}

function makeLogger(messages: string[] = []): Logger {
  return {
    debug: (message: string) => { messages.push(message); },
    info: (message: string) => { messages.push(message); }
  } as unknown as Logger;
}
