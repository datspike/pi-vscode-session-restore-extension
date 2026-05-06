import * as vscode from 'vscode';

export function getTerminalTitleSnapshot(terminal: vscode.Terminal): string {
  return chooseTerminalTitle(terminal.name, getTerminalEditorLabelByIndex(terminal));
}

export function chooseTerminalTitle(terminalName: string, editorTabLabel: string | undefined): string {
  const normalizedLabel = editorTabLabel?.trim();
  return normalizedLabel && normalizedLabel.length > 0 ? normalizedLabel : terminalName;
}

function getTerminalEditorLabelByIndex(terminal: vscode.Terminal): string | undefined {
  const terminalIndex = vscode.window.terminals.indexOf(terminal);
  if (terminalIndex < 0) {
    return undefined;
  }
  const labels = getTerminalEditorTabLabels();
  if (labels.length !== vscode.window.terminals.length) {
    return undefined;
  }
  return labels[terminalIndex];
}

function getTerminalEditorTabLabels(): string[] {
  const labels: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTerminal) {
        labels.push(tab.label);
      }
    }
  }
  return labels;
}
