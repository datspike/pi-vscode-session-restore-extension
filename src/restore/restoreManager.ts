import type * as vscode from 'vscode';
import { PiCliAdapter } from '../pi/piCliAdapter.js';
import { RestorePolicy } from './restorePolicy.js';
import type { ExtensionConfig, RestoreRecord } from '../types.js';
import type { RecordStore } from '../store/recordStore.js';

export type RestoreConfirmation = (record: RestoreRecord) => Promise<boolean>;

export interface AutoRestoreManyResult {
  restored: number;
  skipped: string[];
}

export function getRestoreTerminalName(record: RestoreRecord | undefined): string {
  const terminalName = record?.terminalName?.trim();
  return terminalName && terminalName.length > 0 ? terminalName : 'Pi Session Restore';
}

export class RestoreManager {
  private readonly adapter = new PiCliAdapter();

  public constructor(
    private readonly store: RecordStore,
    private readonly config: ExtensionConfig
  ) {}

  public async restoreLast(terminal: vscode.Terminal, scopeCwd?: string, confirm?: RestoreConfirmation): Promise<string> {
    const record = await this.store.latest(scopeCwd);
    const decision = await this.decide(record);
    if (!record || decision.action === 'skip') {
      return decision.reason;
    }
    if (decision.action === 'prompt') {
      if (!confirm) {
        return 'restore requires confirmation';
      }
      const accepted = await confirm(record);
      if (!accepted) {
        return 'restore cancelled by user';
      }
    }
    await this.executeRestore(terminal, record);
    return decision.reason;
  }

  public async autoRestore(terminal: vscode.Terminal, scopeCwd?: string): Promise<string> {
    if (scopeCwd === undefined) {
      return 'auto-restore skipped because workspace scope is unknown';
    }
    const record = await this.store.latest(scopeCwd);
    const decision = await this.decide(record);
    if (!record || decision.action !== 'auto') {
      return decision.reason;
    }
    await this.executeRestore(terminal, record);
    return decision.reason;
  }

  public async autoRestoreMany(terminals: readonly vscode.Terminal[], scopeCwd?: string): Promise<AutoRestoreManyResult> {
    if (scopeCwd === undefined) {
      return { restored: 0, skipped: ['auto-restore skipped because workspace scope is unknown'] };
    }
    if (terminals.length === 0) {
      return { restored: 0, skipped: ['auto-restore skipped because no terminals exist'] };
    }

    const records = await this.getAutoRestoreRecords(scopeCwd, terminals.length);
    const skipped: string[] = [];
    let restored = 0;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const terminal = terminals[index];
      if (!record || !terminal) {
        continue;
      }
      const decision = await this.decide(record);
      if (decision.action !== 'auto') {
        skipped.push(`${record.sessionPath}: ${decision.reason}`);
        continue;
      }
      await this.executeRestore(terminal, record);
      restored += 1;
    }
    if (records.length === 0) {
      skipped.push('auto-restore skipped because no eligible records matched workspace scope');
    }
    return { restored, skipped };
  }

  public async executeRestore(terminal: vscode.Terminal, record: RestoreRecord): Promise<void> {
    const command = this.adapter.buildResumeCommand(record.sessionPath);
    terminal.show();
    if (terminal.shellIntegration) {
      terminal.shellIntegration.executeCommand(command);
    } else {
      terminal.sendText(command, true);
    }
    const updated: RestoreRecord = {
      ...record,
      restoreAttempts: record.restoreAttempts + 1,
      lastRestoreAt: Date.now()
    };
    await this.store.update(updated);
  }

  public async getAutoRestoreRecords(scopeCwd: string, terminalCount: number): Promise<RestoreRecord[]> {
    const records = await this.store.listForScope(scopeCwd);
    return records
      .filter((record) => record.confidence === 'high')
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-terminalCount);
  }

  private async decide(record: RestoreRecord | undefined) {
    const policy = new RestorePolicy(this.config.restorePolicy, this.config.confidenceThreshold);
    return policy.decide(record);
  }
}
