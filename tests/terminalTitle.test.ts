import { describe, expect, test, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    terminals: [],
    tabGroups: { all: [] }
  },
  TabInputTerminal: class TabInputTerminal {}
}));

const { chooseTerminalTitle } = await import('../src/tracker/terminalTitle.js');

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
});
