import type * as vscode from 'vscode';
import type { DiagnosticsLevel } from './types.js';

const LEVELS: Record<DiagnosticsLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3
};

export class Logger {
  public constructor(
    private readonly channel: vscode.OutputChannel,
    private level: DiagnosticsLevel
  ) {}

  public setLevel(level: DiagnosticsLevel): void {
    this.level = level;
  }

  public error(message: string): void {
    this.write('error', message);
  }

  public info(message: string): void {
    this.write('info', message);
  }

  public debug(message: string): void {
    this.write('debug', message);
  }

  private write(level: Exclude<DiagnosticsLevel, 'off'>, message: string): void {
    if (LEVELS[this.level] < LEVELS[level]) {
      return;
    }
    this.channel.appendLine(`[${new Date().toISOString()}] ${level}: ${message}`);
  }
}
