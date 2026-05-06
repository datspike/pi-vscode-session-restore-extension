import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-wrapper-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('resources/bin/pi wrapper', () => {
  test('test_wrapper_execs_real_pi_logs_invocation_preserves_exit_code', async () => {
    'Wrapper exec-ит настоящий pi, чтобы VS Code видел заголовок pi, и сохраняет invocation event.';
    const wrapperDir = path.resolve('resources/bin');
    const realDir = path.join(tempDir, 'real');
    await mkdir(realDir, { recursive: true });
    const realPi = path.join(realDir, 'pi');
    await writeFile(realPi, '#!/usr/bin/env bash\nprintf "real-pi:%s:%s\\n" "$1" "$2"\nexit 23\n', 'utf8');
    await chmod(realPi, 0o755);
    const eventLog = path.join(tempDir, 'events.jsonl');

    const result = await runWrapper(['--session', '/tmp/s.jsonl'], {
      PATH: `${wrapperDir}${path.delimiter}${realDir}${path.delimiter}${process.env.PATH ?? ''}`,
      PI_VSCODE_SESSION_RESTORE_EVENT_LOG: eventLog,
      PI_VSCODE_SESSION_RESTORE_WRAPPER_DIR: wrapperDir,
      PI_VSCODE_SESSION_RESTORE_MARKER: 'test-marker'
    });

    expect(result.code).toBe(23);
    expect(result.stdout).toBe('real-pi:--session:/tmp/s.jsonl\n');
    const lines = (await readFile(eventLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { event: string; argv: string[]; realPi: string });
    expect(lines.map((line) => line.event)).toEqual(['pi-wrapper-invocation']);
    expect(lines[0]?.argv).toEqual(['pi', '--session', '/tmp/s.jsonl']);
    expect(lines[0]?.realPi).toBe(path.join(realDir, 'pi'));
  });

  test('test_wrapper_allocates_session_for_plain_pi_expected_real_pi_gets_session_arg', async () => {
    'Обычный запуск pi получает заранее назначенный session JSONL.';
    const wrapperDir = path.resolve('resources/bin');
    const realDir = path.join(tempDir, 'real');
    const sessionRoot = path.join(tempDir, 'sessions');
    await mkdir(realDir, { recursive: true });
    const realPi = path.join(realDir, 'pi');
    await writeFile(realPi, '#!/usr/bin/env bash\nprintf "%s\\n" "$*"\nexit 0\n', 'utf8');
    await chmod(realPi, 0o755);
    const eventLog = path.join(tempDir, 'events.jsonl');

    const result = await runWrapper(['hello'], {
      PATH: `${wrapperDir}${path.delimiter}${realDir}${path.delimiter}${process.env.PATH ?? ''}`,
      PI_VSCODE_SESSION_RESTORE_EVENT_LOG: eventLog,
      PI_VSCODE_SESSION_RESTORE_WRAPPER_DIR: wrapperDir,
      PI_VSCODE_SESSION_RESTORE_SESSION_ROOT: sessionRoot,
      PI_VSCODE_SESSION_RESTORE_MARKER: 'test-marker'
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^--session .+\.jsonl hello\n$/);
    const lines = (await readFile(eventLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { event: string; argv: string[]; sessionPath?: string });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.argv).toEqual(['pi', 'hello']);
    expect(lines[0]?.sessionPath).toContain(sessionRoot);
    expect(lines[0]?.sessionPath).toMatch(/\.jsonl$/);
  });

  test('test_wrapper_resume_slash_command_expected_does_not_allocate_session', async () => {
    'Запуск pi /resume не получает новый --session, потому выбор старой сессии делает сам Pi.';
    const wrapperDir = path.resolve('resources/bin');
    const realDir = path.join(tempDir, 'real');
    const sessionRoot = path.join(tempDir, 'sessions');
    await mkdir(realDir, { recursive: true });
    const realPi = path.join(realDir, 'pi');
    await writeFile(realPi, '#!/usr/bin/env bash\nprintf "%s\\n" "$*"\nexit 0\n', 'utf8');
    await chmod(realPi, 0o755);
    const eventLog = path.join(tempDir, 'events.jsonl');

    const result = await runWrapper(['/resume'], {
      PATH: `${wrapperDir}${path.delimiter}${realDir}${path.delimiter}${process.env.PATH ?? ''}`,
      PI_VSCODE_SESSION_RESTORE_EVENT_LOG: eventLog,
      PI_VSCODE_SESSION_RESTORE_WRAPPER_DIR: wrapperDir,
      PI_VSCODE_SESSION_RESTORE_SESSION_ROOT: sessionRoot,
      PI_VSCODE_SESSION_RESTORE_MARKER: 'test-marker'
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('/resume\n');
    const lines = (await readFile(eventLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; sessionPath?: string });
    expect(lines[0]?.argv).toEqual(['pi', '/resume']);
    expect(lines[0]?.sessionPath).toBeUndefined();
  });

  test('test_wrapper_without_event_log_expected_does_not_allocate_session', async () => {
    'Вне VS Code wrapper не добавляет --session и не меняет обычный запуск pi.';
    const wrapperDir = path.resolve('resources/bin');
    const realDir = path.join(tempDir, 'real');
    const sessionRoot = path.join(tempDir, 'sessions');
    await mkdir(realDir, { recursive: true });
    const realPi = path.join(realDir, 'pi');
    await writeFile(realPi, '#!/usr/bin/env bash\nprintf "%s\\n" "$*"\nexit 0\n', 'utf8');
    await chmod(realPi, 0o755);

    const result = await runWrapper(['hello'], {
      PATH: `${wrapperDir}${path.delimiter}${realDir}${path.delimiter}${process.env.PATH ?? ''}`,
      PI_VSCODE_SESSION_RESTORE_WRAPPER_DIR: wrapperDir,
      PI_VSCODE_SESSION_RESTORE_SESSION_ROOT: sessionRoot
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello\n');
  });
});

function runWrapper(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    if (!Object.hasOwn(env, 'PI_VSCODE_SESSION_RESTORE_EVENT_LOG')) {
      delete childEnv.PI_VSCODE_SESSION_RESTORE_EVENT_LOG;
    }
    const child = spawn(path.resolve('resources/bin/pi'), args, {
      cwd: path.resolve('.'),
      env: childEnv
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
