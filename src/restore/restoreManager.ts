import type * as vscode from 'vscode';
import { PiCliAdapter } from '../pi/piCliAdapter.js';
import { RestorePolicy } from './restorePolicy.js';
import type { ExtensionConfig, RestoreRecord } from '../types.js';
import type { RecordStore } from '../store/recordStore.js';

export type RestoreConfirmation = (record: RestoreRecord) => Promise<boolean>;
export type TerminalRenamer = (terminal: vscode.Terminal, name: string) => Promise<void>;

export interface AutoRestoreTarget {
  terminal: vscode.Terminal;
  title?: string;
}

export interface AutoRestorePair {
  target: AutoRestoreTarget;
  record: RestoreRecord;
}

export interface AutoRestoreManyResult {
  restored: number;
  skipped: string[];
}

export function getRestoreTerminalName(record: RestoreRecord | undefined): string {
  const terminalName = record?.terminalName?.trim();
  return terminalName && terminalName.length > 0 ? terminalName : 'Pi Session Restore';
}

export function isAutoRestorableRecord(record: RestoreRecord): boolean {
  return record.confidence === 'high' && record.terminalClosedAt === undefined;
}

export function selectAutoRestorePairs(records: readonly RestoreRecord[], targets: readonly AutoRestoreTarget[]): AutoRestorePair[] {
  const titleMatchRecords = records
    .filter((record) => record.confidence === 'high')
    .sort((left, right) => left.startedAt - right.startedAt);
  const usedRecordIds = new Set<string>();
  const pairs: AutoRestorePair[] = [];
  const targetTitleCounts = countTargetTitles(targets);

  for (const target of targets) {
    const title = normalizeTitle(target.title);
    if (title === undefined || targetTitleCounts.get(title) !== 1) {
      continue;
    }
    const record = findNewestUnusedMatchingTitle(titleMatchRecords, usedRecordIds, title);
    if (record === undefined) {
      continue;
    }
    usedRecordIds.add(record.id);
    pairs.push({ target, record });
  }

  const unmatchedTargets = targets.filter((target) => !pairs.some((pair) => pair.target === target));
  for (let index = 0; index < unmatchedTargets.length; index += 1) {
    const target = unmatchedTargets[index];
    if (target === undefined) {
      continue;
    }
    const remainingTargetCount = unmatchedTargets.length - index;
    const compatibleRecords = titleMatchRecords
      .filter((record) => !usedRecordIds.has(record.id) && isFallbackRestorableRecordForTarget(record, target));
    const record = compatibleRecords.slice(-remainingTargetCount)[0];
    if (record !== undefined) {
      usedRecordIds.add(record.id);
      pairs.push({ target, record });
    }
  }

  return pairs.sort((left, right) => targets.indexOf(left.target) - targets.indexOf(right.target));
}

function isFallbackRestorableRecordForTarget(record: RestoreRecord, target: AutoRestoreTarget): boolean {
  if (isAutoRestorableRecord(record)) {
    return true;
  }
  const recordTitle = normalizeTitle(record.terminalName);
  const targetTitle = normalizeTitle(target.title);
  return record.confidence === 'high' && recordTitle !== undefined && recordTitle === targetTitle;
}

function countTargetTitles(targets: readonly AutoRestoreTarget[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const title = normalizeTitle(target.title);
    if (title !== undefined) {
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
  }
  return counts;
}

function findNewestUnusedMatchingTitle(records: readonly RestoreRecord[], usedRecordIds: Set<string>, title: string): RestoreRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || usedRecordIds.has(record.id)) {
      continue;
    }
    if (normalizeTitle(record.terminalName) === title) {
      return record;
    }
  }
  return undefined;
}

function normalizeTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim().toLocaleLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export class RestoreManager {
  private readonly adapter = new PiCliAdapter();

  public constructor(
    private readonly store: RecordStore,
    private readonly config: ExtensionConfig,
    private readonly terminalRenamer: TerminalRenamer = async () => undefined
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
    const record = (await this.getAutoRestoreRecords(scopeCwd, 1))[0];
    const decision = await this.decide(record);
    if (!record || decision.action !== 'auto') {
      return decision.reason;
    }
    await this.executeRestore(terminal, record);
    return decision.reason;
  }

  public async autoRestoreMany(terminals: readonly vscode.Terminal[], scopeCwd?: string): Promise<AutoRestoreManyResult> {
    return this.autoRestoreTargets(terminals.map((terminal) => ({ terminal })), scopeCwd);
  }

  public async autoRestoreTargets(targets: readonly AutoRestoreTarget[], scopeCwd?: string): Promise<AutoRestoreManyResult> {
    if (scopeCwd === undefined) {
      return { restored: 0, skipped: ['auto-restore skipped because workspace scope is unknown'] };
    }
    if (targets.length === 0) {
      return { restored: 0, skipped: ['auto-restore skipped because no terminals exist'] };
    }

    const records = await this.store.listForScope(scopeCwd);
    const pairs = selectAutoRestorePairs(records, targets);
    const skipped: string[] = [];
    let restored = 0;
    for (const pair of pairs) {
      const decision = await this.decide(pair.record);
      if (decision.action !== 'auto') {
        skipped.push(`${pair.record.sessionPath}: ${decision.reason}`);
        continue;
      }
      await this.executeRestore(pair.target.terminal, pair.record);
      restored += 1;
    }
    if (pairs.length === 0) {
      skipped.push('auto-restore skipped because no eligible records matched workspace scope');
    }
    return { restored, skipped };
  }

  public async executeRestore(terminal: vscode.Terminal, record: RestoreRecord): Promise<void> {
    const command = this.adapter.buildResumeCommand(record.sessionPath);
    terminal.show();
    const terminalName = record.terminalName?.trim();
    if (terminalName && terminalName.length > 0) {
      await this.terminalRenamer(terminal, terminalName);
    }
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
      .filter(isAutoRestorableRecord)
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-terminalCount);
  }

  private async decide(record: RestoreRecord | undefined) {
    const policy = new RestorePolicy(this.config.restorePolicy, this.config.confidenceThreshold);
    return policy.decide(record);
  }
}
