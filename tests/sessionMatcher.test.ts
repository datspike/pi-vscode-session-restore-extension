import { describe, expect, test } from 'vitest';
import { SessionMatcher } from '../src/session/sessionMatcher.js';
import type { PiInvocation, SessionCandidate, WrapperEvent } from '../src/types.js';

describe('SessionMatcher', () => {
  test('test_match_exact_wrapper_and_time_expected_high_confidence', () => {
    'Совпадение pid wrapper и времени даёт high confidence.';
    const invocation: PiInvocation = {
      command: 'pi',
      args: [],
      cwd: '/work/project',
      startedAt: 1_000,
      endedAt: 2_000,
      wrapperPid: 50,
      wrapperPpid: 40,
      source: 'wrapper'
    };
    const candidates: SessionCandidate[] = [{ path: '/tmp/session.jsonl', mtimeMs: 1_500, size: 10 }];
    const wrapperEvents: WrapperEvent[] = [{ event: 'pi-wrapper-invocation', time: 1_000, cwd: '/work/project', argv: ['pi'], pid: 50, ppid: 40 }];

    const match = new SessionMatcher().match({ invocation, candidates, wrapperEvents });

    expect(match?.confidence).toBe('high');
    expect(match?.score).toBe(100);
    expect(match?.reasons).toEqual([
      'session mtime is near invocation window',
      'wrapper pid matches invocation',
      'wrapper event matches shell process',
      'session file is non-empty JSONL'
    ]);
  });

  test('test_match_stale_candidate_expected_low_confidence', () => {
    'Старый кандидат без сигналов получает low confidence.';
    const invocation: PiInvocation = { command: 'pi', args: [], startedAt: 100_000, source: 'shellIntegration' };
    const candidates: SessionCandidate[] = [{ path: '/tmp/session.jsonl', mtimeMs: 1_000, size: 10 }];

    const match = new SessionMatcher().match({ invocation, candidates });

    expect(match?.confidence).toBe('low');
    expect(match?.score).toBe(5);
  });
});
