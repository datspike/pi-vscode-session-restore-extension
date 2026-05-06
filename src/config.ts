import * as vscode from 'vscode';
import type { ExtensionConfig } from './types.js';

export function readConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('piSessionRestore');
  return {
    enabled: config.get<boolean>('enabled', true),
    sessionGlobPaths: config.get<string[]>('sessionGlobPaths', ['~/.pi/agent/sessions/**/*.jsonl']),
    restorePolicy: config.get<ExtensionConfig['restorePolicy']>('restorePolicy', 'auto-confident'),
    confidenceThreshold: config.get<ExtensionConfig['confidenceThreshold']>('confidenceThreshold', 'high'),
    diagnosticsLevel: config.get<ExtensionConfig['diagnosticsLevel']>('diagnosticsLevel', 'info'),
    recordTtlDays: config.get<number>('recordTtlDays', 30)
  };
}
