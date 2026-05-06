import type { PiInvocation } from '../types.js';

const IGNORED_COMMANDS = new Set(['which', 'type', 'command', 'whereis', 'alias', 'hash']);

export function parseShellCommand(commandText: string, startedAt: number, cwd?: string, shellPid?: number): PiInvocation | undefined {
  const tokens = tokenize(commandText.trim());
  if (tokens.length === 0) {
    return undefined;
  }

  const firstToken = tokens[0];
  if (!firstToken || IGNORED_COMMANDS.has(firstToken)) {
    return undefined;
  }

  const commandToken = normalizeCommandToken(firstToken);
  if (commandToken !== 'pi' && commandToken !== 'p') {
    return undefined;
  }

  const invocation: PiInvocation = {
    command: commandToken as 'pi' | 'p',
    args: tokens.slice(1),
    startedAt,
    source: 'shellIntegration'
  };
  if (cwd !== undefined) {
    invocation.cwd = cwd;
  }
  if (shellPid !== undefined) {
    invocation.shellPid = shellPid;
  }
  return invocation;
}

export function parseWrapperArgv(argv: string[], startedAt: number, cwd: string, pid: number, ppid: number, sessionPath?: string): PiInvocation {
  const commandName = argv[0] ? normalizeCommandToken(argv[0]) : 'pi';
  const invocation: PiInvocation = {
    command: commandName === 'p' ? 'p' : 'pi',
    args: argv.slice(1),
    cwd,
    startedAt,
    wrapperPid: pid,
    wrapperPpid: ppid,
    source: 'wrapper'
  };
  if (sessionPath !== undefined) {
    invocation.sessionPath = sessionPath;
  }
  return invocation;
}

export function tokenize(commandText: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaping = false;

  for (const char of commandText) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaping = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }
    if (/\s/.test(char) && quote === undefined) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += '\\';
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeCommandToken(token: string): 'pi' | 'p' | string {
  const command = token.split('/').at(-1) ?? token;
  return command === 'pi' || command === 'p' ? command : token;
}

