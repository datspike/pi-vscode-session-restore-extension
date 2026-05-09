import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Logger } from '../src/log.js';

const vscodeMock = vi.hoisted(() => ({
  activeTerminal: undefined as unknown,
  executeCommand: vi.fn()
}));

vi.mock('vscode', () => ({
  commands: {
    executeCommand: vscodeMock.executeCommand
  },
  window: {
    get activeTerminal() {
      return vscodeMock.activeTerminal;
    }
  },
  workspace: {},
  Uri: {
    file: (fsPath: string) => ({ fsPath })
  }
}));

const { createTerminalRenamer } = await import('../src/extension.js');

describe('createTerminalRenamer', () => {
  beforeEach(() => {
    vscodeMock.activeTerminal = undefined;
    vscodeMock.executeCommand.mockReset();
  });

  test('test_terminal_renamer_expected_renames_only_after_target_becomes_active', async () => {
    'Rename выполняется после show, когда целевая вкладка стала активной.';
    const events: string[] = [];
    const terminal = {
      show: (preserveFocus?: boolean) => {
        events.push(`show:${String(preserveFocus)}`);
        vscodeMock.activeTerminal = terminal;
      }
    } as unknown as vscode.Terminal;
    vscodeMock.executeCommand.mockImplementation(() => {
      events.push('rename');
      return Promise.resolve();
    });

    await createTerminalRenamer(makeLogger())(terminal, 'Pi test 1');

    expect(events).toEqual(['show:false', 'rename']);
    expect(vscodeMock.executeCommand).toHaveBeenCalledWith('workbench.action.terminal.renameWithArg', { name: 'Pi test 1' });
  });

  test('test_terminal_renamer_when_target_is_not_active_expected_skips_rename', async () => {
    'Rename пропускается, если после show активной осталась соседняя вкладка.';
    const messages: string[] = [];
    const neighbor = { show: () => undefined } as unknown as vscode.Terminal;
    const terminal = { show: () => undefined } as unknown as vscode.Terminal;
    vscodeMock.activeTerminal = neighbor;

    await createTerminalRenamer(makeLogger(messages))(terminal, 'Pi test 2');

    expect(vscodeMock.activeTerminal).toBe(neighbor);
    expect(vscodeMock.executeCommand).not.toHaveBeenCalled();
    expect(messages).toEqual(['Terminal rename skipped because target terminal did not become active: Pi test 2']);
  });
});

function makeLogger(messages: string[] = []): Logger {
  return {
    debug: (message: string) => { messages.push(message); }
  } as unknown as Logger;
}
