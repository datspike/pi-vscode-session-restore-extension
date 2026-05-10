import type * as vscode from 'vscode';
import { PiCliAdapter } from '../pi/piCliAdapter.js';
import { RECENT_RESTORE_COOLDOWN_MS, RestorePolicy } from './restorePolicy.js';
import type { ExtensionConfig, RestoreRecord } from '../types.js';
import type { RecordStore } from '../store/recordStore.js';

export type RestoreConfirmation = (record: RestoreRecord) => Promise<boolean>;
export type TerminalRenamer = (terminal: vscode.Terminal, name: string) => Promise<void>;

export interface AutoRestoreTarget {
  terminal: vscode.Terminal;
  title?: string;
  cwd?: string;
}

export interface AutoRestorePair {
  target: AutoRestoreTarget;
  record: RestoreRecord;
}

export interface AutoRestoreManyResult {
  restored: number;
  skipped: string[];
}

export function selectMissingAutoCreateRecords(
  records: readonly RestoreRecord[],
  pairs: readonly AutoRestorePair[]
): RestoreRecord[] {
  const pairedRecordIds = new Set(pairs.map((pair) => pair.record.id));
  return records.filter((record) => isAutoRestorableRecord(record)
    && record.lastRestoreAt !== undefined
    && !pairedRecordIds.has(record.id));
}

export function getRestoreTerminalName(record: RestoreRecord | undefined): string {
  const terminalName = record?.terminalName?.trim();
  return terminalName && terminalName.length > 0 ? terminalName : 'Pi Session Restore';
}

export function isAutoRestorableRecord(record: RestoreRecord): boolean {
  return record.confidence === 'high' && record.terminalClosedAt === undefined;
}

export function selectAutoRestorePairs(
  records: readonly RestoreRecord[],
  targets: readonly AutoRestoreTarget[],
  scopeCwd?: string
): AutoRestorePair[] {
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
    const record = findNewestUnusedMatchingTitle(titleMatchRecords, usedRecordIds, title, target, scopeCwd);
    if (record === undefined) {
      continue;
    }
    usedRecordIds.add(record.id);
    pairs.push({ target, record });
  }

  const unmatchedTargets = targets.filter((target) => !pairs.some((pair) => pair.target === target));
  const ambiguousFallbackTargets = getAmbiguousFallbackTargets(unmatchedTargets);
  for (let index = 0; index < unmatchedTargets.length; index += 1) {
    const target = unmatchedTargets[index];
    if (target === undefined || ambiguousFallbackTargets.has(target)) {
      continue;
    }
    const remainingTargetCount = unmatchedTargets.length - index;
    const compatibleRecords = titleMatchRecords
      .filter((record) => !usedRecordIds.has(record.id) && isRecordCompatibleWithTarget(record, target, scopeCwd) && isFallbackRestorableRecordForTarget(record, target));
    const record = compatibleRecords.slice(-remainingTargetCount)[0];
    if (record !== undefined) {
      usedRecordIds.add(record.id);
      pairs.push({ target, record });
    }
  }

  return pairs.sort((left, right) => targets.indexOf(left.target) - targets.indexOf(right.target));
}

function getAmbiguousFallbackTargets(targets: readonly AutoRestoreTarget[]): Set<AutoRestoreTarget> {
  const ambiguousTargets = new Set<AutoRestoreTarget>();
  const targetTitleCounts = countTargetTitles(targets);
  for (const target of targets) {
    const title = normalizeTitle(target.title);
    if (title !== undefined && targetTitleCounts.get(title) !== 1 && target.cwd === undefined) {
      ambiguousTargets.add(target);
    }
  }
  return ambiguousTargets;
}

function isFallbackRestorableRecordForTarget(record: RestoreRecord, target: AutoRestoreTarget): boolean {
  const recordTitle = normalizeTitle(record.terminalName);
  const targetTitle = normalizeTitle(target.title);
  if (record.confidence === 'high' && recordTitle !== undefined && recordTitle === targetTitle) {
    return true;
  }
  return target.cwd !== undefined && isAutoRestorableRecord(record);
}

function isRecordCompatibleWithTarget(record: RestoreRecord, target: AutoRestoreTarget, scopeCwd: string | undefined): boolean {
  if (target.cwd !== undefined) {
    return record.cwd === target.cwd;
  }
  if (scopeCwd !== undefined) {
    return record.cwd === scopeCwd;
  }
  return true;
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

function findNewestUnusedMatchingTitle(
  records: readonly RestoreRecord[],
  usedRecordIds: Set<string>,
  title: string,
  target: AutoRestoreTarget,
  scopeCwd: string | undefined
): RestoreRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || usedRecordIds.has(record.id)) {
      continue;
    }
    if (isRecordCompatibleWithTarget(record, target, scopeCwd) && normalizeTitle(record.terminalName) === title) {
      return record;
    }
  }
  return undefined;
}

function normalizeTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim().toLocaleLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function describeTarget(target: AutoRestoreTarget): string {
  const title = target.title?.trim();
  const label = title && title.length > 0 ? title : 'unnamed terminal';
  return target.cwd === undefined ? label : `${label} (${target.cwd})`;
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
    const requiresUnknownScopeConfirmation = scopeCwd === undefined && decision.action === 'auto';
    if (decision.action === 'prompt' || requiresUnknownScopeConfirmation) {
      if (!confirm) {
        return 'restore requires confirmation';
      }
      const accepted = await confirm(record);
      if (!accepted) {
        return 'restore cancelled by user';
      }
    }
    const restored = await this.executeRestore(terminal, record);
    return restored ? decision.reason : 'restore was attempted recently for this record';
  }

  public async autoRestore(terminal: vscode.Terminal, scopeCwd?: string): Promise<string> {
    const result = await this.autoRestoreTargets([{ terminal }], scopeCwd);
    if (result.restored === 1) {
      return 'high-confidence record is eligible for automatic restore';
    }
    return result.skipped.join('; ');
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

    const records = targets.some((target) => target.cwd !== undefined)
      ? await this.store.listForWorkspaceScope(scopeCwd)
      : await this.store.listForScope(scopeCwd);
    const pairs = selectAutoRestorePairs(records, targets, scopeCwd);
    const skipped: string[] = [];
    let restored = 0;
    for (const pair of pairs) {
      const decision = await this.decide(pair.record);
      if (decision.action !== 'auto') {
        skipped.push(`${pair.record.sessionPath}: ${decision.reason}`);
        continue;
      }
      const restoreClaimed = await this.executeRestore(pair.target.terminal, pair.record);
      if (!restoreClaimed) {
        skipped.push(`${pair.record.sessionPath}: restore was attempted recently for this record`);
        continue;
      }
      restored += 1;
    }
    const unmatchedTargets = targets.filter((target) => !pairs.some((pair) => pair.target === target));
    if (pairs.length === 0) {
      skipped.push('auto-restore skipped because no eligible records matched workspace scope');
    }
    for (const target of unmatchedTargets) {
      skipped.push(`auto-restore skipped for ${describeTarget(target)} because no eligible record matched terminal cwd/title within workspace scope`);
    }
    return { restored, skipped };
  }

  public async executeRestore(terminal: vscode.Terminal, record: RestoreRecord): Promise<boolean> {
    const claimedRecord = await this.store.claimRestore(record.id, Date.now(), RECENT_RESTORE_COOLDOWN_MS);
    if (claimedRecord === undefined) {
      return false;
    }
    const command = this.adapter.buildResumeCommand(claimedRecord.sessionPath);
    terminal.show();
    const terminalName = claimedRecord.terminalName?.trim();
    if (terminalName && terminalName.length > 0) {
      await this.terminalRenamer(terminal, terminalName);
    }
    if (terminal.shellIntegration) {
      terminal.shellIntegration.executeCommand(command);
    } else {
      terminal.sendText(command, true);
    }
    return true;
  }

  public async getAutoRestoreRecords(scopeCwd: string, terminalCount?: number): Promise<RestoreRecord[]> {
    const records = await this.store.listForWorkspaceScope(scopeCwd);
    const eligibleRecords = records
      .filter(isAutoRestorableRecord)
      .sort((left, right) => left.startedAt - right.startedAt);
    return terminalCount === undefined ? eligibleRecords : eligibleRecords.slice(-terminalCount);
  }

  private async decide(record: RestoreRecord | undefined) {
    const policy = new RestorePolicy(this.config.restorePolicy, this.config.confidenceThreshold);
    return policy.decide(record);
  }
}
