import { stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../log.js';
import { parseShellCommand, parseWrapperArgv } from '../pi/piCommandParser.js';
import { createRecordId, type RecordStore } from '../store/recordStore.js';
import { readPiSessionMetadata, SessionLocator } from '../session/sessionLocator.js';
import { SessionMatcher } from '../session/sessionMatcher.js';
import { getTerminalTitleSnapshot } from './terminalTitle.js';
import type { ExtensionConfig, PiInvocation, PiSessionEvent, RestoreRecord, TrackerEvent, WrapperEvent } from '../types.js';

const TERMINAL_CLOSE_MARK_DELAY_MS = 1_500;

export class TerminalTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly activeInvocations = new Map<vscode.TerminalShellExecution, PiInvocation>();
  private readonly wrapperEvents: WrapperEvent[] = [];
  private readonly shellSessions = new Map<number, string>();
  private readonly terminalSessions = new Map<vscode.Terminal, string>();
  private readonly recentlyClosedShells = new Map<number, { terminalName: string; closedAt: number }>();
  private readonly pendingClosedShells = new Map<number, NodeJS.Timeout>();
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
    this.disposables.push(vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal !== undefined) {
        void this.onTerminalStateChange(terminal);
      }
    }));
    this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(() => {
      void this.refreshTerminalTitles();
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
    for (const timer of this.pendingClosedShells.values()) {
      clearTimeout(timer);
    }
    this.pendingClosedShells.clear();
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
    if (invocation.sessionPath !== undefined) {
      const explicitSessionPath = await this.validateExplicitWrapperSession(invocation.sessionPath, invocation.cwd);
      if (explicitSessionPath !== undefined) {
        if (closedMarker === undefined) {
          await this.rememberShellSession(event.ppid, explicitSessionPath);
        }
        await this.storeDirectWrapperRecord(invocation, explicitSessionPath, closedMarker);
        return;
      }
    }
    await this.matchAndStore(invocation, closedMarker);
  }

  private async onShellExecutionStart(event: vscode.TerminalShellExecutionStartEvent): Promise<void> {
    const shellPid = await event.terminal.processId;
    const cwd = event.execution.cwd?.fsPath;
    const invocation = parseShellCommand(event.execution.commandLine.value, Date.now(), cwd, shellPid);
    if (!invocation) {
      return;
    }
    invocation.terminalName = getTerminalTitleSnapshot(event.terminal);
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
    const closedAt = Date.now();
    if (shellPid === undefined) {
      this.logger.debug(`Terminal close ignored because shell pid is unknown: name=${getTerminalTitleSnapshot(terminal)}`);
      return;
    }
    const terminalName = getTerminalTitleSnapshot(terminal);
    const sessionPath = await this.findSessionPathForTerminal(terminal, shellPid);
    this.recentlyClosedShells.set(shellPid, { terminalName, closedAt });
    const timer = setTimeout(() => {
      this.pendingClosedShells.delete(shellPid);
      void this.confirmTerminalClosed(shellPid, terminalName, closedAt, sessionPath).catch((error: unknown) => {
        this.logger.debug(error instanceof Error ? error.message : String(error));
      });
    }, TERMINAL_CLOSE_MARK_DELAY_MS);
    this.pendingClosedShells.set(shellPid, timer);
    this.terminalSessions.delete(terminal);
    if (sessionPath !== undefined && this.shellSessions.get(shellPid) === sessionPath) {
      this.shellSessions.delete(shellPid);
    }
    this.logger.debug(`Scheduled Pi terminal close marker: name=${terminalName}, shellPid=${shellPid}`);
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

    const closedMarker = this.getRecentlyClosedShell(event.ppid, event.time);
    if (closedMarker === undefined) {
      await this.rememberShellSession(event.ppid, event.sessionPath);
    }
    const terminalName = await this.findTerminalTitleByShellPid(event.ppid);
    if (terminalName !== undefined) {
      record.terminalName = terminalName;
    }
    if (event.previousSessionFile !== undefined && event.previousSessionFile !== event.sessionPath) {
      await this.store.markTerminalClosed(event.previousSessionFile, terminalName, event.time);
      this.logger.debug(`Marked previous Pi session as inactive after ${event.reason ?? 'session switch'}: ${event.previousSessionFile}`);
    }
    this.applyClosedMarker(record, closedMarker);
    await this.store.add(record, this.getConfig().recordTtlDays);
    this.logger.info('Stored authoritative Pi session record from Pi extension.');
  }

  private async validateExplicitWrapperSession(sessionPath: string, cwd: string | undefined): Promise<string | undefined> {
    if (path.extname(sessionPath) !== '.jsonl') {
      this.logger.debug('Explicit Pi session path from wrapper argv skipped because it is not a JSONL file.');
      return undefined;
    }
    const fileStat = await stat(sessionPath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      this.logger.debug('Explicit Pi session path from wrapper argv skipped because file is absent.');
      return undefined;
    }
    const metadata = await readPiSessionMetadata(sessionPath).catch(() => undefined);
    if (metadata === undefined) {
      this.logger.debug('Explicit Pi session path from wrapper argv skipped because file is not a Pi session JSONL.');
      return undefined;
    }
    if (cwd !== undefined && metadata.cwd !== undefined && path.resolve(metadata.cwd) !== path.resolve(cwd)) {
      this.logger.debug('Explicit Pi session path from wrapper argv skipped because session cwd does not match invocation cwd.');
      return undefined;
    }
    return sessionPath;
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
      reasons: ['wrapper reported explicit Pi session path'],
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
    if (closedMarker === undefined) {
      if (invocation.shellPid !== undefined) {
        await this.rememberShellSession(invocation.shellPid, match.candidate.path);
      }
      if (invocation.wrapperPpid !== undefined) {
        await this.rememberShellSession(invocation.wrapperPpid, match.candidate.path);
      }
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
    const terminalName = await this.findTerminalTitleByShellPid(shellPid);
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

  private async confirmTerminalClosed(
    shellPid: number,
    terminalName: string,
    closedAt: number,
    closedSessionPath?: string
  ): Promise<void> {
    this.recentlyClosedShells.set(shellPid, { terminalName, closedAt });
    const sessionPath = closedSessionPath ?? this.shellSessions.get(shellPid);
    if (sessionPath === undefined) {
      this.logger.debug(`Delayed Pi terminal close marker is waiting for session path: shellPid=${shellPid}`);
      return;
    }
    await this.store.markTerminalClosed(sessionPath, terminalName, closedAt);
    this.logger.debug(`Marked Pi session terminal as closed: ${sessionPath}`);
  }

  private async refreshTerminalName(terminal: vscode.Terminal): Promise<boolean> {
    const shellPid = await terminal.processId;
    if (shellPid === undefined) {
      return false;
    }
    const sessionPath = this.shellSessions.get(shellPid) ?? this.terminalSessions.get(terminal);
    if (sessionPath === undefined) {
      return false;
    }
    this.terminalSessions.set(terminal, sessionPath);
    return this.store.updateTerminalName(sessionPath, getTerminalTitleSnapshot(terminal));
  }

  private async findSessionPathForTerminal(terminal: vscode.Terminal, knownShellPid?: number): Promise<string | undefined> {
    const sessionPath = this.terminalSessions.get(terminal);
    if (sessionPath !== undefined) {
      return sessionPath;
    }
    const shellPid = knownShellPid ?? await terminal.processId;
    return shellPid === undefined ? undefined : this.shellSessions.get(shellPid);
  }

  private async refreshTerminalTitles(): Promise<void> {
    let refreshed = 0;
    for (const terminal of vscode.window.terminals) {
      if (await this.refreshTerminalName(terminal)) {
        refreshed += 1;
      }
    }
    if (refreshed > 0) {
      this.logger.debug(`Refreshed Pi terminal titles from tab labels: ${refreshed}`);
    }
  }

  private async findTerminalTitleByShellPid(shellPid: number): Promise<string | undefined> {
    const terminal = await this.findTerminalByShellPid(shellPid);
    return terminal === undefined ? undefined : getTerminalTitleSnapshot(terminal);
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
