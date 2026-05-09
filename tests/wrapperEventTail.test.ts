import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseTrackerEvents, parseWrapperEvents, WrapperEventTail } from '../src/tracker/wrapperEventTail.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-wrapper-tail-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

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

  test('test_read_new_events_on_fresh_activation_expected_skips_stale_log_entries', async () => {
    'Старый wrapper-events.jsonl не переигрывается как свежие события после новой активации.';
    const eventLogPath = path.join(tempDir, 'wrapper-events.jsonl');
    const staleEvent = { event: 'pi-wrapper-invocation', time: 10_000, cwd: '/work/a', argv: ['pi'], pid: 11, ppid: 10, sessionPath: '/tmp/old.jsonl' };
    await writeFile(eventLogPath, `${JSON.stringify(staleEvent)}\n`, 'utf8');

    const events = await new WrapperEventTail(eventLogPath, 20_000).readNewEvents();

    expect(events).toEqual([]);
  });

  test('test_read_new_events_after_activation_expected_keeps_new_log_entries', async () => {
    'Новые wrapper events после активации не теряются при первом чтении.';
    const eventLogPath = path.join(tempDir, 'wrapper-events.jsonl');
    const staleEvent = { event: 'pi-wrapper-invocation', time: 10_000, cwd: '/work/a', argv: ['pi'], pid: 11, ppid: 10, sessionPath: '/tmp/old.jsonl' };
    const newEvent = { event: 'pi-wrapper-invocation', time: 21_000, cwd: '/work/a', argv: ['pi'], pid: 12, ppid: 10, sessionPath: '/tmp/new.jsonl' };
    await writeFile(eventLogPath, `${JSON.stringify(staleEvent)}\n`, 'utf8');
    const tail = new WrapperEventTail(eventLogPath, 20_000);
    await appendFile(eventLogPath, `${JSON.stringify(newEvent)}\n`, 'utf8');

    expect(await tail.readNewEvents()).toEqual([newEvent]);
  });

  test('test_read_new_events_after_initial_read_expected_reads_appended_events_without_timestamp_filter', async () => {
    'Последующие чтения продолжают читать добавленные события по offset.';
    const eventLogPath = path.join(tempDir, 'wrapper-events.jsonl');
    const firstEvent = { event: 'pi-wrapper-invocation', time: 21_000, cwd: '/work/a', argv: ['pi'], pid: 12, ppid: 10, sessionPath: '/tmp/new.jsonl' };
    const secondEvent = { event: 'pi-wrapper-exit', time: 21_500, cwd: '/work/a', argv: ['pi'], pid: 12, ppid: 10, exitCode: 0 };
    await writeFile(eventLogPath, `${JSON.stringify(firstEvent)}\n`, 'utf8');
    const tail = new WrapperEventTail(eventLogPath, 20_000);

    expect(await tail.readNewEvents()).toEqual([firstEvent]);
    await appendFile(eventLogPath, `${JSON.stringify(secondEvent)}\n`, 'utf8');

    expect(await tail.readNewEvents()).toEqual([secondEvent]);
  });

  test('test_read_new_events_with_partial_tail_expected_keeps_line_until_newline', async () => {
    'Неполная последняя JSONL-строка не теряется и читается после завершения newline.';
    const eventLogPath = path.join(tempDir, 'wrapper-events.jsonl');
    const event = { event: 'pi-session-start', time: 21_000, cwd: '/work/a', pid: 12, ppid: 10, sessionPath: '/tmp/new.jsonl', sessionId: 'abc', reason: 'startup' };
    const line = JSON.stringify(event);
    const splitAt = Math.floor(line.length / 2);
    const tail = new WrapperEventTail(eventLogPath, 20_000);
    await writeFile(eventLogPath, line.slice(0, splitAt), 'utf8');

    expect(await tail.readNewEvents()).toEqual([]);
    await appendFile(eventLogPath, `${line.slice(splitAt)}\n`, 'utf8');

    expect(await tail.readNewEvents()).toEqual([event]);
  });

  test('test_read_new_events_after_truncate_expected_reads_from_file_start', async () => {
    'После усечения event log offset сбрасывается и новый файл читается с начала.';
    const eventLogPath = path.join(tempDir, 'wrapper-events.jsonl');
    const firstEvent = { event: 'pi-wrapper-invocation', time: 21_000, cwd: '/work/a', argv: ['pi'], pid: 12, ppid: 10, sessionPath: '/tmp/very-long-session-path-for-offset.jsonl' };
    const secondEvent = { event: 'pi-wrapper-exit', time: 22_000, cwd: '/w', argv: ['pi'], pid: 13, ppid: 10, exitCode: 0 };
    const tail = new WrapperEventTail(eventLogPath, 20_000);
    await writeFile(eventLogPath, `${JSON.stringify(firstEvent)}\n`, 'utf8');

    expect(await tail.readNewEvents()).toEqual([firstEvent]);
    await writeFile(eventLogPath, `${JSON.stringify(secondEvent)}\n`, 'utf8');

    expect(await tail.readNewEvents()).toEqual([secondEvent]);
  });

  test('test_read_new_events_with_complete_malformed_line_expected_ignores_and_continues', async () => {
    'Завершённая битая строка игнорируется и не блокирует следующие валидные события.';
    const eventLogPath = path.join(tempDir, 'wrapper-events.jsonl');
    const event = { event: 'pi-wrapper-invocation', time: 21_000, cwd: '/work/a', argv: ['pi'], pid: 12, ppid: 10, sessionPath: '/tmp/new.jsonl' };
    const tail = new WrapperEventTail(eventLogPath, 20_000);
    await writeFile(eventLogPath, '{bad\n', 'utf8');

    expect(await tail.readNewEvents()).toEqual([]);
    await appendFile(eventLogPath, `${JSON.stringify(event)}\n`, 'utf8');

    expect(await tail.readNewEvents()).toEqual([event]);
  });
});
