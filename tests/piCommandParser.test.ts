import { describe, expect, test } from 'vitest';
import { parseShellCommand, parseWrapperArgv, tokenize } from '../src/pi/piCommandParser.js';

describe('piCommandParser', () => {
  test('test_parse_pi_command_with_quoted_args_expected_args', () => {
    'Команда pi разбирается с кавычками.';
    const invocation = parseShellCommand('pi --model "sonnet:high" "hello world"', 1_000, '/tmp', 42);
    expect(invocation).toEqual({
      command: 'pi',
      args: ['--model', 'sonnet:high', 'hello world'],
      cwd: '/tmp',
      startedAt: 1_000,
      shellPid: 42,
      source: 'shellIntegration'
    });
  });

  test('test_parse_alias_command_text_p_expected_pi_invocation', () => {
    'Текст команды p распознаётся как запуск alias для pi.';
    const invocation = parseShellCommand('p --continue', 2_000);
    expect(invocation?.command).toBe('p');
    expect(invocation?.args).toEqual(['--continue']);
  });

  test('test_parse_shell_command_with_session_expected_session_path', () => {
    'Shell command parser извлекает explicit --session так же, как wrapper argv.';
    const invocation = parseShellCommand('pi --session /tmp/s.jsonl', 1_000, '/work', 42);
    expect(invocation?.sessionPath).toBe('/tmp/s.jsonl');
  });

  test('test_ignore_diagnostic_commands_expected_undefined', () => {
    'Диагностические команды оболочки не считаются запуском pi.';
    expect(parseShellCommand('which pi', 1)).toBeUndefined();
    expect(parseShellCommand('type pi', 1)).toBeUndefined();
  });

  test('test_parse_wrapper_argv_expected_wrapper_metadata', () => {
    'Аргументы wrapper дают invocation с pid и ppid.';
    const invocation = parseWrapperArgv(['pi', '--session', '/tmp/s.jsonl'], 3_000, '/work', 10, 9);
    expect(invocation).toMatchObject({
      command: 'pi',
      args: ['--session', '/tmp/s.jsonl'],
      cwd: '/work',
      wrapperPid: 10,
      wrapperPpid: 9,
      sessionPath: '/tmp/s.jsonl',
      source: 'wrapper'
    });
  });

  test('test_parse_wrapper_argv_with_session_equals_expected_session_path', () => {
    'Wrapper argv извлекает explicit --session=... без Pi-side события.';
    const invocation = parseWrapperArgv(['pi', '--session=/tmp/s.jsonl'], 3_000, '/work', 10, 9);
    expect(invocation.sessionPath).toBe('/tmp/s.jsonl');
  });

  test('test_tokenize_escaped_space_expected_single_arg', () => {
    'Экранированный пробел остаётся внутри аргумента.';
    expect(tokenize('pi hello\\ world')).toEqual(['pi', 'hello world']);
  });
});
