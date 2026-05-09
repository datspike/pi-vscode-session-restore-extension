import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Logger } from '../src/log.js';

const vscodeMock = vi.hoisted(() => ({
  activeTerminal: undefined as vscode.Terminal | undefined,
  terminals: [] as vscode.Terminal[],
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  getWorkspaceFolder: vi.fn()
}));

vi.mock('vscode', () => ({
  commands: {
    executeCommand: vi.fn()
  },
  window: {
    get activeTerminal() {
      return vscodeMock.activeTerminal;
    },
    get terminals() {
      return vscodeMock.terminals;
    },
    tabGroups: {
      all: []
    }
  },
  workspace: {
    get workspaceFolders() {
      return vscodeMock.workspaceFolders;
    },
    getWorkspaceFolder: vscodeMock.getWorkspaceFolder
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  },
  TabInputTerminal: class TabInputTerminal {}
}));

const { getWorkspaceScopeCwd, terminalLooksIdle } = await import('../src/extension.js');

describe('startup race guards', () => {
  beforeEach(() => {
    vscodeMock.activeTerminal = undefined;
    vscodeMock.terminals = [];
    vscodeMock.workspaceFolders = undefined;
    vscodeMock.getWorkspaceFolder.mockReset();
    vscodeMock.getWorkspaceFolder.mockReturnValue(undefined);
  });

  test('test_get_workspace_scope_cwd_without_active_terminal_expected_uses_first_workspace_folder', () => {
    'Scope fallback использует первую workspace-папку, когда активного терминала нет.';
    vscodeMock.workspaceFolders = [{ uri: { fsPath: '/repo' } }];

    expect(getWorkspaceScopeCwd()).toBe('/repo');
  });

  test('test_get_workspace_scope_cwd_with_active_terminal_without_cwd_expected_falls_back_to_first_workspace_folder', () => {
    'Синхронный fallback scope остаётся workspace-папкой, когда shell integration cwd ещё нет.';
    const terminal = makeTerminal();
    vscodeMock.activeTerminal = terminal;
    vscodeMock.terminals = [terminal];
    vscodeMock.workspaceFolders = [{ uri: { fsPath: '/repo' } }];

    expect(getWorkspaceScopeCwd()).toBe('/repo');
    expect(vscodeMock.getWorkspaceFolder).not.toHaveBeenCalled();
  });

  test('test_get_workspace_scope_cwd_with_active_terminal_cwd_expected_uses_containing_workspace_folder', () => {
    'Scope по активному терминалу расширяется до содержащей workspace-папки.';
    const terminal = makeTerminal({ cwd: '/repo/packages/api' });
    vscodeMock.activeTerminal = terminal;
    vscodeMock.terminals = [terminal];
    vscodeMock.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    vscodeMock.getWorkspaceFolder.mockReturnValue({ uri: { fsPath: '/repo' } });

    expect(getWorkspaceScopeCwd()).toBe('/repo');
    expect(vscodeMock.getWorkspaceFolder).toHaveBeenCalledWith({ fsPath: '/repo/packages/api' });
  });

  test('test_terminal_looks_idle_with_unknown_process_id_expected_waits_for_shell_pid', async () => {
    'Linux terminal без processId не считается idle, чтобы startup restore дождался shell pid.';
    const messages: string[] = [];
    const terminal = makeTerminal({ processId: undefined, name: 'bash' });
    vscodeMock.terminals = [terminal];

    await expect(terminalLooksIdle(terminal, makeLogger(messages))).resolves.toBe(false);
    expect(messages).toEqual(['Terminal is not considered idle yet because shell pid is unknown: bash']);
  });
});

function makeTerminal(options: { cwd?: string; processId?: number | undefined; name?: string } = {}): vscode.Terminal {
  return {
    name: options.name ?? 'terminal',
    processId: Promise.resolve(options.processId),
    shellIntegration: options.cwd === undefined ? undefined : { cwd: { fsPath: options.cwd } }
  } as unknown as vscode.Terminal;
}

function makeLogger(messages: string[] = []): Logger {
  return {
    debug: (message: string) => { messages.push(message); },
    info: (message: string) => { messages.push(message); }
  } as unknown as Logger;
}
