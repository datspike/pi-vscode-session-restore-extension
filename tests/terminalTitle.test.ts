import type * as Vscode from 'vscode';
import { describe, expect, test, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    terminals: [],
    tabGroups: { all: [] }
  },
  TabInputTerminal: class TabInputTerminal {}
}));

const vscode = await import('vscode');
const { chooseTerminalTitle, getTerminalTitleSnapshot } = await import('../src/tracker/terminalTitle.js');

function makeTerminal(name: string): Vscode.Terminal {
  return { name } as Vscode.Terminal;
}

function setTerminalTabs(terminals: Vscode.Terminal[], labels: string[]): void {
  (vscode.window as unknown as { terminals: Vscode.Terminal[] }).terminals = terminals;
  (vscode.window.tabGroups as unknown as { all: Array<{ tabs: Array<{ label: string; input: unknown }> }> }).all = [{
    tabs: labels.map((label) => ({
      label,
      input: new vscode.TabInputTerminal()
    }))
  }];
}

describe('terminalTitle', () => {
  test('test_choose_terminal_title_expected_prefers_non_empty_editor_label', () => {
    'Title snapshot предпочитает сохранённый label terminal editor tab.';
    expect(chooseTerminalTitle('pi', 'Pi test 1')).toBe('Pi test 1');
  });

  test('test_choose_terminal_title_empty_label_expected_falls_back_to_terminal_name', () => {
    'Пустой label не перетирает имя терминала.';
    expect(chooseTerminalTitle('pi', '  ')).toBe('pi');
    expect(chooseTerminalTitle('pi', undefined)).toBe('pi');
  });

  test('test_get_terminal_title_snapshot_single_terminal_expected_uses_editor_label', () => {
    'Единственная terminal editor вкладка считается однозначным источником title snapshot.';
    const terminal = makeTerminal('pi');
    setTerminalTabs([terminal], ['Pi test 1']);

    expect(getTerminalTitleSnapshot(terminal)).toBe('Pi test 1');
  });

  test('test_get_terminal_title_snapshot_mismatched_terminal_and_tab_order_expected_uses_terminal_name', () => {
    'Расхождение порядков window.terminals и tabGroups не сохраняет label соседней вкладки.';
    const firstTerminal = makeTerminal('first-terminal-name');
    const secondTerminal = makeTerminal('second-terminal-name');
    setTerminalTabs([firstTerminal, secondTerminal], ['second-editor-label', 'first-editor-label']);

    expect(getTerminalTitleSnapshot(firstTerminal)).toBe('first-terminal-name');
    expect(getTerminalTitleSnapshot(secondTerminal)).toBe('second-terminal-name');
  });
});
