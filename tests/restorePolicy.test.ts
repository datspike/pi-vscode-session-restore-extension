import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PiCliAdapter, quoteForShell } from '../src/pi/piCliAdapter.js';
import { RestorePolicy } from '../src/restore/restorePolicy.js';
import type { RestoreRecord } from '../src/types.js';

let tempDir: string;
let sessionPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-restore-policy-'));
  sessionPath = path.join(tempDir, "session's file.jsonl");
  await writeFile(sessionPath, '{}\n', 'utf8');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('RestorePolicy', () => {
  test('test_high_confidence_auto_policy_expected_auto', async () => {
    'High confidence запись разрешает auto restore.';
    const decision = await new RestorePolicy('auto-confident', 'high').decide(makeRecord('high'));
    expect(decision).toEqual({ action: 'auto', reason: 'high-confidence record is eligible for automatic restore' });
  });

  test('test_medium_under_high_threshold_expected_skip', async () => {
    'Medium confidence ниже high threshold пропускается.';
    const decision = await new RestorePolicy('prompt', 'high').decide(makeRecord('medium'));
    expect(decision).toEqual({ action: 'skip', reason: 'confidence medium is below high' });
  });

  test('test_old_existing_attempt_expected_can_restore_on_next_window_open', async () => {
    'Старая restore attempt не запрещает следующее открытие окна.';
    const record = { ...makeRecord('high'), restoreAttempts: 1, lastRestoreAt: 10_000 };
    const decision = await new RestorePolicy('auto-confident', 'high', () => 30_000).decide(record);
    expect(decision).toEqual({ action: 'auto', reason: 'high-confidence record is eligible for automatic restore' });
  });

  test('test_recent_existing_attempt_expected_skip_no_loop', async () => {
    'Недавняя restore attempt не запускается повторно в том же окне.';
    const record = { ...makeRecord('high'), restoreAttempts: 1, lastRestoreAt: 20_000 };
    const decision = await new RestorePolicy('auto-confident', 'high', () => 30_000).decide(record);
    expect(decision).toEqual({ action: 'skip', reason: 'restore was attempted recently for this record' });
  });
});

describe('PiCliAdapter', () => {
  test('test_build_resume_command_expected_confirmed_session_syntax', () => {
    'Adapter использует подтверждённый pi --session <path|id> синтаксис.';
    expect(new PiCliAdapter().buildResumeCommand(sessionPath)).toBe(`pi --session ${quoteForShell(sessionPath)}`);
  });
});

function makeRecord(confidence: RestoreRecord['confidence']): RestoreRecord {
  return {
    id: confidence,
    sessionPath,
    command: 'pi',
    args: [],
    startedAt: 1,
    matchedAt: 2,
    confidence,
    score: 100,
    reasons: ['test'],
    restoreAttempts: 0
  };
}
