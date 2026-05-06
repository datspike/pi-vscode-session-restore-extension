import { access } from 'node:fs/promises';
import type { Confidence, RestoreDecision, RestorePolicyMode, RestoreRecord } from '../types.js';

const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 1,
  medium: 2,
  high: 3
};

const RECENT_RESTORE_COOLDOWN_MS = 15_000;

export class RestorePolicy {
  public constructor(
    private readonly mode: RestorePolicyMode,
    private readonly threshold: Confidence,
    private readonly now: () => number = Date.now
  ) {}

  public async decide(record: RestoreRecord | undefined): Promise<RestoreDecision> {
    if (!record) {
      return { action: 'skip', reason: 'no restore record exists' };
    }
    if (this.mode === 'off') {
      return { action: 'skip', reason: 'restore policy is off' };
    }
    if (record.lastRestoreAt !== undefined && this.now() - record.lastRestoreAt < RECENT_RESTORE_COOLDOWN_MS) {
      return { action: 'skip', reason: 'restore was attempted recently for this record' };
    }
    if (CONFIDENCE_RANK[record.confidence] < CONFIDENCE_RANK[this.threshold]) {
      return { action: 'skip', reason: `confidence ${record.confidence} is below ${this.threshold}` };
    }
    if (!(await exists(record.sessionPath))) {
      return { action: 'skip', reason: 'session file no longer exists' };
    }
    if (this.mode === 'auto-confident' && record.confidence === 'high') {
      return { action: 'auto', reason: 'high-confidence record is eligible for automatic restore' };
    }
    return { action: 'prompt', reason: 'record is eligible for manual confirmation' };
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
