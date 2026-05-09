import * as vscode from 'vscode';

export function getTerminalTitleSnapshot(terminal: vscode.Terminal): string {
  return chooseTerminalTitle(terminal.name, getTerminalEditorLabelByIndex(terminal));
}

export function chooseTerminalTitle(terminalName: string, editorTabLabel: string | undefined): string {
  const normalizedLabel = editorTabLabel?.trim();
  return normalizedLabel && normalizedLabel.length > 0 ? normalizedLabel : terminalName;
}

function getTerminalEditorLabelByIndex(terminal: vscode.Terminal): string | undefined {
  if (vscode.window.terminals.length !== 1 || vscode.window.terminals[0] !== terminal) {
    return undefined;
  }
  const labels = getTerminalEditorTabLabels();
  if (labels.length !== 1) {
    return undefined;
  }
  return labels[0];
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
