import { describe, expect, test } from 'vitest';
import { parseTrackerEvents, parseWrapperEvents } from '../src/tracker/wrapperEventTail.js';

describe('wrapperEventTail', () => {
  test('test_parse_tracker_events_expected_accepts_pi_session_start', () => {
    'Parser принимает Pi-side session_start события для /resume.';
    const raw = [
      JSON.stringify({
        event: 'pi-session-start',
        time: 1_000,
        cwd: '/work/a',
        pid: 11,
        ppid: 10,
        sessionPath: '/tmp/session.jsonl',
        sessionId: 'abc',
        reason: 'resume',
        previousSessionFile: '/tmp/previous.jsonl'
      }),
      '{bad',
      JSON.stringify({ event: 'unknown', time: 2_000 })
    ].join('\n');

    expect(parseTrackerEvents(raw)).toEqual([{
      event: 'pi-session-start',
      time: 1_000,
      cwd: '/work/a',
      pid: 11,
      ppid: 10,
      sessionPath: '/tmp/session.jsonl',
      sessionId: 'abc',
      reason: 'resume',
      previousSessionFile: '/tmp/previous.jsonl'
    }]);
  });

  test('test_parse_wrapper_events_expected_backward_compatible_alias', () => {
    'Старое имя parser остаётся совместимым с wrapper events.';
    const raw = JSON.stringify({ event: 'pi-wrapper-invocation', time: 1_000, cwd: '/work/a', argv: ['pi'], pid: 11, ppid: 10 });
    expect(parseWrapperEvents(raw)).toEqual([{ event: 'pi-wrapper-invocation', time: 1_000, cwd: '/work/a', argv: ['pi'], pid: 11, ppid: 10 }]);
  });
});
