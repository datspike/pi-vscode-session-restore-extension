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
      onDidChangeTabs: vscodeMock.onDidChangeTabs
    }
  }
}));

const { TerminalTracker } = await import('../src/tracker/terminalTracker.js');

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-terminal-tracker-'));
  vscodeMock.terminals = [];
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
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
