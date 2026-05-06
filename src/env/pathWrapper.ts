import path from 'node:path';
import type * as vscode from 'vscode';

export interface PathWrapperOptions {
  extensionUri: vscode.Uri;
  eventLogPath: string;
  enabled: boolean;
}

export function configurePathWrapper(context: vscode.ExtensionContext, options: PathWrapperOptions): void {
  const collection = context.environmentVariableCollection;
  collection.clear();
  if (!options.enabled) {
    return;
  }
  const wrapperDir = path.join(options.extensionUri.fsPath, 'resources', 'bin');
  collection.prepend('PATH', `${wrapperDir}${path.delimiter}`);
  collection.replace('PI_VSCODE_SESSION_RESTORE_EVENT_LOG', options.eventLogPath);
  collection.replace('PI_VSCODE_SESSION_RESTORE_WRAPPER_DIR', wrapperDir);
  collection.replace('PI_VSCODE_SESSION_RESTORE_MARKER', context.extension.id);
}
