import * as vscode from 'vscode';
import type { Logger } from '../log.js';
import { parseShellCommand, parseWrapperArgv } from '../pi/piCommandParser.js';
import { createRecordId, type RecordStore } from '../store/recordStore.js';
import { SessionLocator } from '../session/sessionLocator.js';
import { SessionMatcher } from '../session/sessionMatcher.js';
import type { ExtensionConfig, PiInvocation, PiSessionEvent, RestoreRecord, TrackerEvent, WrapperEvent } from '../types.js';

export class TerminalTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly activeInvocations = new Map<vscode.TerminalShellExecution, PiInvocation>();
  private readonly wrapperEvents: WrapperEvent[] = [];
  private readonly shellSessions = new Map<number, string>();
  private readonly terminalSessions = new Map<vscode.Terminal, string>();
  private readonly recentlyClosedShells = new Map<number, { terminalName: string; closedAt: number }>();
  private readonly locator = new SessionLocator();
  private readonly matcher = new SessionMatcher();

  public constructor(
    private readonly store: RecordStore,
    private readonly getConfig: () => ExtensionConfig,
    private readonly logger: Logger
  ) {}

  public register(context: vscode.ExtensionContext): void {
    this.disposables.push(vscode.window.onDidStartTerminalShellExecution((event) => {
      void this.onShellExecutionStart(event);
    }));
    this.disposables.push(vscode.window.onDidEndTerminalShellExecution((event) => {
      void this.onShellExecutionEnd(event);
    }));
    this.disposables.push(vscode.window.onDidChangeTerminalState((terminal) => {
      void this.onTerminalStateChange(terminal);
    }));
    this.disposables.push(vscode.window.onDidCloseTerminal((terminal) => {
      void this.onTerminalClose(terminal);
    }));
    context.subscriptions.push(this);
  }

  public async ingestWrapperEvents(events: TrackerEvent[]): Promise<void> {
    await this.ingestEvents(events);
  }

  public async ingestEvents(events: TrackerEvent[]): Promise<void> {
    for (const event of events) {
      if (event.event === 'pi-session-start') {
        await this.storePiSessionRecord(event);
        continue;
      }
      await this.ingestWrapperEvent(event);
    }
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async ingestWrapperEvent(event: WrapperEvent): Promise<void> {
    this.wrapperEvents.push(event);
    if (event.event !== 'pi-wrapper-invocation') {
      return;
    }
    const invocation = parseWrapperArgv(event.argv, event.time, event.cwd, event.pid, event.ppid, event.sessionPath);
    await this.applyTerminalName(invocation, event.ppid);
    const closedMarker = this.getRecentlyClosedShell(event.ppid, event.time);
    if (closedMarker !== undefined) {
      invocation.terminalName = closedMarker.terminalName;
    }
    if (event.sessionPath !== undefined) {
      await this.rememberShellSession(event.ppid, event.sessionPath);
      await this.storeDirectWrapperRecord(invocation, event.sessionPath, closedMarker);
    } else {
      await this.matchAndStore(invocation, closedMarker);
    }
  }

  private async onShellExecutionStart(event: vscode.TerminalShellExecutionStartEvent): Promise<void> {
    const shellPid = await event.terminal.processId;
    const cwd = event.execution.cwd?.fsPath;
    const invocation = parseShellCommand(event.execution.commandLine.value, Date.now(), cwd, shellPid);
    if (!invocation) {
      return;
    }
    invocation.terminalName = event.terminal.name;
    this.activeInvocations.set(event.execution, invocation);
  }

  private async onShellExecutionEnd(event: vscode.TerminalShellExecutionEndEvent): Promise<void> {
    const invocation = this.activeInvocations.get(event.execution);
    if (!invocation) {
      return;
    }
    this.activeInvocations.delete(event.execution);
    invocation.endedAt = Date.now();
    await this.matchAndStore(invocation);
  }

  private async onTerminalStateChange(terminal: vscode.Terminal): Promise<void> {
    await this.refreshTerminalName(terminal);
  }

  private async onTerminalClose(terminal: vscode.Terminal): Promise<void> {
    const shellPid = await terminal.processId;
    const sessionPath = await this.findSessionPathForTerminal(terminal, shellPid);
    const closedAt = Date.now();
    if (sessionPath === undefined) {
      if (shellPid !== undefined) {
        this.recentlyClosedShells.set(shellPid, { terminalName: terminal.name, closedAt });
      }
      this.logger.debug(`Terminal closed without tracked Pi session: name=${terminal.name}, shellPid=${shellPid ?? 'unknown'}`);
      return;
    }
    await this.store.markTerminalClosed(sessionPath, terminal.name, closedAt);
    this.terminalSessions.delete(terminal);
    this.logger.debug(`Marked Pi session terminal as closed: ${sessionPath}`);
  }

  private async storePiSessionRecord(event: PiSessionEvent): Promise<void> {
    if (event.sessionPath === undefined) {
      this.logger.debug('Pi session event skipped because session path is absent.');
      return;
    }

    const matchedAt = Date.now();
    const record: RestoreRecord = {
      id: createRecordId(event.sessionPath, matchedAt),
      sessionPath: event.sessionPath,
      cwd: event.cwd,
      command: 'pi',
      args: [],
      shellPid: event.ppid,
      startedAt: event.time,
      matchedAt,
      confidence: 'high',
      score: 100,
      reasons: [`pi extension reported session_start${event.reason ? ` (${event.reason})` : ''}`],
      restoreAttempts: 0
    };

    await this.rememberShellSession(event.ppid, event.sessionPath);
    const terminalName = await this.findTerminalNameByShellPid(event.ppid);
    if (terminalName !== undefined) {
      record.terminalName = terminalName;
    }
    this.applyClosedMarker(record, this.getRecentlyClosedShell(event.ppid, event.time));
    await this.store.add(record, this.getConfig().recordTtlDays);
    this.logger.info('Stored authoritative Pi session record from Pi extension.');
  }

  private async storeDirectWrapperRecord(
    invocation: PiInvocation,
    sessionPath: string,
    closedMarker?: { terminalName: string; closedAt: number }
  ): Promise<void> {
    const matchedAt = Date.now();
    const record: RestoreRecord = {
      id: createRecordId(sessionPath, matchedAt),
      sessionPath,
      command: invocation.command,
      args: invocation.args,
      startedAt: invocation.startedAt,
      matchedAt,
      confidence: 'high',
      score: 100,
      reasons: ['wrapper allocated explicit Pi session path'],
      restoreAttempts: 0
    };
    this.applyInvocationMetadata(record, invocation);
    this.applyClosedMarker(record, closedMarker);
    await this.store.add(record, this.getConfig().recordTtlDays);
    this.logger.info('Stored explicit Pi session record from wrapper.');
  }

  private async matchAndStore(invocation: PiInvocation, closedMarker?: { terminalName: string; closedAt: number }): Promise<void> {
    const config = this.getConfig();
    const candidates = await this.locator.locate({
      globPaths: config.sessionGlobPaths,
      afterMs: invocation.startedAt - 5_000,
      beforeMs: (invocation.endedAt ?? Date.now()) + 120_000
    });
    const match = this.matcher.match({ invocation, candidates, wrapperEvents: this.wrapperEvents });
    if (!match) {
      this.logger.debug('No Pi session candidate matched invocation.');
      return;
    }
    const matchedAt = Date.now();
    const record: RestoreRecord = {
      id: createRecordId(match.candidate.path, matchedAt),
      sessionPath: match.candidate.path,
      command: invocation.command,
      args: invocation.args,
      startedAt: invocation.startedAt,
      matchedAt,
      confidence: match.confidence,
      score: match.score,
      reasons: match.reasons,
      restoreAttempts: 0
    };
    this.applyInvocationMetadata(record, invocation);
    if (invocation.shellPid !== undefined) {
      await this.rememberShellSession(invocation.shellPid, match.candidate.path);
    }
    if (invocation.wrapperPpid !== undefined) {
      await this.rememberShellSession(invocation.wrapperPpid, match.candidate.path);
    }
    this.applyClosedMarker(record, closedMarker);
    await this.store.add(record, config.recordTtlDays);
    this.logger.info(`Stored Pi session record with ${match.confidence} confidence.`);
  }

  private applyInvocationMetadata(record: RestoreRecord, invocation: PiInvocation): void {
    if (invocation.cwd !== undefined) {
      record.cwd = invocation.cwd;
    }
    if (invocation.shellPid !== undefined) {
      record.shellPid = invocation.shellPid;
    }
    if (invocation.wrapperPid !== undefined) {
      record.wrapperPid = invocation.wrapperPid;
    }
    if (invocation.wrapperPpid !== undefined) {
      record.wrapperPpid = invocation.wrapperPpid;
    }
    if (invocation.endedAt !== undefined) {
      record.endedAt = invocation.endedAt;
    }
    if (invocation.terminalName !== undefined) {
      record.terminalName = invocation.terminalName;
    }
  }

  private async applyTerminalName(invocation: PiInvocation, shellPid: number): Promise<void> {
    const terminalName = await this.findTerminalNameByShellPid(shellPid);
    if (terminalName !== undefined) {
      invocation.terminalName = terminalName;
    }
  }

  private applyClosedMarker(record: RestoreRecord, closedMarker: { terminalName: string; closedAt: number } | undefined): void {
    if (closedMarker === undefined) {
      return;
    }
    record.terminalClosedAt = closedMarker.closedAt;
    record.terminalName = closedMarker.terminalName;
  }

  private getRecentlyClosedShell(shellPid: number, eventTime: number): { terminalName: string; closedAt: number } | undefined {
    const recentlyClosed = this.recentlyClosedShells.get(shellPid);
    if (recentlyClosed === undefined) {
      return undefined;
    }
    if (eventTime <= recentlyClosed.closedAt) {
      return recentlyClosed;
    }
    this.recentlyClosedShells.delete(shellPid);
    return undefined;
  }

  private async rememberShellSession(shellPid: number, sessionPath: string): Promise<void> {
    this.shellSessions.set(shellPid, sessionPath);
    const terminal = await this.findTerminalByShellPid(shellPid);
    if (terminal !== undefined) {
      this.terminalSessions.set(terminal, sessionPath);
    }
  }

  private async refreshTerminalName(terminal: vscode.Terminal): Promise<void> {
    const shellPid = await terminal.processId;
    if (shellPid === undefined) {
      return;
    }
    const sessionPath = this.shellSessions.get(shellPid) ?? this.terminalSessions.get(terminal);
    if (sessionPath === undefined) {
      return;
    }
    this.terminalSessions.set(terminal, sessionPath);
    await this.store.updateTerminalName(sessionPath, terminal.name);
  }

  private async findSessionPathForTerminal(terminal: vscode.Terminal, knownShellPid?: number): Promise<string | undefined> {
    const sessionPath = this.terminalSessions.get(terminal);
    if (sessionPath !== undefined) {
      return sessionPath;
    }
    const shellPid = knownShellPid ?? await terminal.processId;
    return shellPid === undefined ? undefined : this.shellSessions.get(shellPid);
  }

  private async findTerminalNameByShellPid(shellPid: number): Promise<string | undefined> {
    return (await this.findTerminalByShellPid(shellPid))?.name;
  }

  private async findTerminalByShellPid(shellPid: number): Promise<vscode.Terminal | undefined> {
    for (const terminal of vscode.window.terminals) {
      const terminalShellPid = await terminal.processId;
      if (terminalShellPid === shellPid) {
        return terminal;
      }
    }
    return undefined;
  }
}
