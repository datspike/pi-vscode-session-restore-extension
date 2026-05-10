import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { readConfig } from './config.js';
import { configurePathWrapper } from './env/pathWrapper.js';
import { Logger } from './log.js';
import { ensurePiSessionReporterInstalled } from './pi/piExtensionInstaller.js';
import {
  getRestoreTerminalName,
  RestoreManager,
  selectAutoRestorePairs,
  selectMissingAutoCreateRecords,
  type AutoRestoreTarget,
  type TerminalRenamer
} from './restore/restoreManager.js';
import { RecordStore } from './store/recordStore.js';
import { TerminalTracker } from './tracker/terminalTracker.js';
import { getTerminalTitleSnapshot } from './tracker/terminalTitle.js';
import { WrapperEventTail } from './tracker/wrapperEventTail.js';
import type { ExtensionConfig, RestoreRecord } from './types.js';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let config = readConfig();
  const getConfig = (): ExtensionConfig => config;
  const channel = vscode.window.createOutputChannel('Pi Session Restore');
  const logger = new Logger(channel, config.diagnosticsLevel);
  const storageDir = context.globalStorageUri.fsPath;
  await mkdir(storageDir, { recursive: true });
  const eventLogPath = path.join(storageDir, 'wrapper-events.jsonl');
  if (config.installPiExtension) {
    await ensurePiSessionReporterInstalled(context.extensionUri, logger).catch((error: unknown) => {
      logger.error(error instanceof Error ? error.message : String(error));
    });
  }

  const applyPathWrapper = (): void => configurePathWrapper(context, {
    extensionUri: context.extensionUri,
    eventLogPath,
    enabled: config.enabled,
    piExtensionEnabled: config.installPiExtension
  });
  applyPathWrapper();

  const store = new RecordStore(storageDir);
  const tracker = new TerminalTracker(store, getConfig, logger);
  tracker.register(context);
  const tail = new WrapperEventTail(eventLogPath);
  const interval = setInterval(() => {
    void tail.readNewEvents().then((events) => tracker.ingestEvents(events)).catch((error: unknown) => {
      logger.error(error instanceof Error ? error.message : String(error));
    });
  }, 2_000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
  context.subscriptions.push(channel);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('piSessionRestore')) {
      return;
    }
    config = readConfig();
    logger.setLevel(config.diagnosticsLevel);
    applyPathWrapper();
    if (config.installPiExtension) {
      void ensurePiSessionReporterInstalled(context.extensionUri, logger).catch((error: unknown) => {
        logger.error(error instanceof Error ? error.message : String(error));
      });
    }
    logger.info('Pi Session Restore configuration reloaded.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('piSessionRestore.showRecords', async () => {
    const data = await store.read();
    channel.show();
    channel.appendLine(JSON.stringify(data.records, null, 2));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('piSessionRestore.clearRecords', async () => {
    await store.clear();
    await vscode.window.showInformationMessage('Pi Session Restore records cleared.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('piSessionRestore.restoreLast', async () => {
    const manager = createRestoreManager(store, getConfig(), logger);
    const scopeCwd = getWorkspaceScopeCwd();
    const latestRecord = await store.latest(scopeCwd);
    const terminal = vscode.window.activeTerminal ?? createRestoreTerminal(latestRecord);
    const reason = await manager.restoreLast(terminal, scopeCwd, confirmRestore);
    logger.info(`Restore command result: ${reason}`);
  }));

  scheduleConservativeAutoRestore(store, getConfig, logger);
  logger.info('Pi Session Restore activated.');
}

export function deactivate(): void {
  // extension resources are disposed through VS Code subscriptions
}

export function getWorkspaceScopeCwd(): string | undefined {
  const activeCwd = vscode.window.activeTerminal?.shellIntegration?.cwd?.fsPath;
  if (activeCwd !== undefined) {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activeCwd))?.uri.fsPath ?? activeCwd;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

const AUTO_RESTORE_STARTUP_DELAY_MS = 3_000;
const AUTO_RESTORE_CWD_RETRY_DELAYS_MS = [0, 500, 1_000, 2_000] as const;
const AUTO_RESTORE_IDLE_RETRY_DELAYS_MS = [0, 1_000, 2_000, 3_000] as const;

async function waitForAutoRestoreScopeCwd(logger: Logger): Promise<string | undefined> {
  if (vscode.window.activeTerminal === undefined) {
    return getWorkspaceScopeCwd();
  }
  for (const delayMs of AUTO_RESTORE_CWD_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const activeCwd = vscode.window.activeTerminal?.shellIntegration?.cwd?.fsPath;
    if (activeCwd !== undefined) {
      return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activeCwd))?.uri.fsPath ?? activeCwd;
    }
  }
  logger.info('Auto-restore skipped because active terminal cwd is not ready.');
  return undefined;
}

async function confirmRestore(record: RestoreRecord): Promise<boolean> {
  const label = record.cwd ? `${record.cwd}: ${record.sessionPath}` : record.sessionPath;
  const selected = await vscode.window.showWarningMessage(
    `Restore Pi session?\n${label}`,
    { modal: true },
    'Restore'
  );
  return selected === 'Restore';
}

function scheduleConservativeAutoRestore(
  store: RecordStore,
  getConfig: () => ExtensionConfig,
  logger: Logger
): void {
  setTimeout(() => {
    void runConservativeAutoRestore(store, getConfig, logger).catch((error: unknown) => {
      logger.error(error instanceof Error ? error.message : String(error));
    });
  }, AUTO_RESTORE_STARTUP_DELAY_MS);
}

async function runConservativeAutoRestore(
  store: RecordStore,
  getConfig: () => ExtensionConfig,
  logger: Logger
): Promise<void> {
  const config = getConfig();
  if (config.restorePolicy !== 'auto-confident') {
    return;
  }

  const scopeCwd = await waitForAutoRestoreScopeCwd(logger);
  if (scopeCwd === undefined) {
    logger.info('Auto-restore skipped because workspace scope is unknown.');
    return;
  }

  const manager = createRestoreManager(store, config, logger);
  logger.debug(`Auto-restore scan: scope=${scopeCwd}, terminals=${await describeTerminals(vscode.window.terminals)}`);
  const idleTerminals = await waitForIdleTerminals(logger);
  if (idleTerminals.length === 0) {
    logger.info('Auto-restore skipped because no idle terminals are available.');
    return;
  }

  const restoreTargets = await getStableAutoRestoreTargets(idleTerminals, logger);
  if (restoreTargets.length === 0) {
    logger.info('Auto-restore skipped because terminal cwd is not ready.');
    return;
  }
  const eligibleRecords = await manager.getAutoRestoreRecords(scopeCwd);
  const plannedPairs = selectAutoRestorePairs(eligibleRecords, restoreTargets, scopeCwd);
  const missingRecords = selectMissingAutoCreateRecords(eligibleRecords, plannedPairs);
  logger.debug(`Auto-restore candidates: idle=${idleTerminals.length}, targets=${restoreTargets.map(describeTargetForLog).join(', ')}, records=${eligibleRecords.map(describeRecordForLog).join(' | ')}, planned=${plannedPairs.map(describePairForLog).join(' | ')}, missing=${missingRecords.map(describeRecordForLog).join(' | ')}`);
  const result = await manager.autoRestoreTargets(restoreTargets, scopeCwd);
  const created = await autoRestoreMissingRecords(missingRecords, manager, logger);
  logger.info(`Auto-restore result: restored=${result.restored}, created=${created.restored}, skipped=${[...result.skipped, ...created.skipped].join('; ')}`);
}

async function autoRestoreMissingRecords(
  records: readonly RestoreRecord[],
  manager: RestoreManager,
  logger: Logger
): Promise<{ restored: number; skipped: string[] }> {
  let restored = 0;
  const skipped: string[] = [];
  for (const record of records) {
    const terminal = createRestoreTerminal(record);
    const restoreClaimed = await manager.executeRestore(terminal, record);
    if (restoreClaimed) {
      restored += 1;
      logger.debug(`Auto-created restore terminal for missing record: ${describeRecordForLog(record)}`);
    } else {
      skipped.push(`${record.sessionPath}: restore was attempted recently for this record`);
    }
  }
  return { restored, skipped };
}

function createRestoreManager(store: RecordStore, config: ExtensionConfig, logger: Logger): RestoreManager {
  return new RestoreManager(store, config, createTerminalRenamer(logger));
}

const TERMINAL_RENAME_ACTIVE_WAIT_DELAYS_MS = [0, 25, 50, 100] as const;

export function createTerminalRenamer(logger: Logger): TerminalRenamer {
  return async (terminal, name) => {
    terminal.show(false);
    const targetIsActive = await waitForActiveTerminal(terminal);
    if (!targetIsActive) {
      logger.debug(`Terminal rename skipped because target terminal did not become active: ${name}`);
      return;
    }
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name }).then(() => {
      logger.debug(`Terminal rename command applied: ${name}`);
    }, (error: unknown) => {
      logger.debug(`Terminal rename command failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}

async function waitForActiveTerminal(terminal: vscode.Terminal): Promise<boolean> {
  for (const delayMs of TERMINAL_RENAME_ACTIVE_WAIT_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    if (vscode.window.activeTerminal === terminal) {
      return true;
    }
  }
  return false;
}

async function describeTerminals(terminals: readonly vscode.Terminal[]): Promise<string> {
  const descriptions: string[] = [];
  for (const terminal of terminals) {
    const processId = await terminal.processId;
    descriptions.push(`${terminal.name}:${processId ?? 'unknown'}`);
  }
  return descriptions.join(', ');
}

function describeRecordForLog(record: RestoreRecord): string {
  return `${record.terminalName ?? 'unnamed'}:${record.sessionPath}:closed=${record.terminalClosedAt ?? 'no'}:attempts=${record.restoreAttempts}`;
}

function describeTargetForLog(target: AutoRestoreTarget): string {
  return `${target.title ?? 'unnamed'}:${target.cwd ?? 'no-cwd'}`;
}

function describePairForLog(pair: { target: AutoRestoreTarget; record: RestoreRecord }): string {
  return `${describeTargetForLog(pair.target)}=>${describeRecordForLog(pair.record)}`;
}

async function waitForIdleTerminals(logger: Logger): Promise<vscode.Terminal[]> {
  for (const delayMs of AUTO_RESTORE_IDLE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const idleTerminals = await getIdleTerminals(vscode.window.terminals, logger);
    if (idleTerminals.length > 0) {
      return idleTerminals;
    }
  }
  return [];
}

async function getStableAutoRestoreTargets(terminals: readonly vscode.Terminal[], logger: Logger): Promise<AutoRestoreTarget[]> {
  for (const delayMs of AUTO_RESTORE_CWD_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const targets = createAutoRestoreTargets(terminals);
    if (targets.length === terminals.length) {
      return targets;
    }
  }
  const targets = createAutoRestoreTargets(terminals);
  const skippedCount = terminals.length - targets.length;
  if (skippedCount > 0) {
    logger.info(`Auto-restore skipped ${skippedCount} terminal(s) because shell integration cwd is not ready.`);
  }
  return targets;
}

function createAutoRestoreTargets(terminals: readonly vscode.Terminal[]): AutoRestoreTarget[] {
  const targets: AutoRestoreTarget[] = [];
  for (const terminal of terminals) {
    const cwd = terminal.shellIntegration?.cwd?.fsPath;
    if (cwd === undefined) {
      continue;
    }
    targets.push({ terminal, title: getTerminalTitleSnapshot(terminal), cwd });
  }
  return targets;
}

function createRestoreTerminal(record: RestoreRecord | undefined): vscode.Terminal {
  const options: vscode.TerminalOptions = { name: getRestoreTerminalName(record) };
  if (record?.cwd !== undefined) {
    options.cwd = record.cwd;
  }
  return vscode.window.createTerminal(options);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function getIdleTerminals(terminals: readonly vscode.Terminal[], logger: Logger): Promise<vscode.Terminal[]> {
  const idleTerminals: vscode.Terminal[] = [];
  for (const terminal of terminals) {
    if (await terminalLooksIdle(terminal, logger)) {
      idleTerminals.push(terminal);
    }
  }
  return idleTerminals;
}

export async function terminalLooksIdle(terminal: vscode.Terminal, logger: Logger): Promise<boolean> {
  if (process.platform !== 'linux') {
    return true;
  }
  const shellPid = await terminal.processId;
  if (shellPid === undefined) {
    logger.debug(`Terminal is not considered idle yet because shell pid is unknown: ${getTerminalTitleSnapshot(terminal)}`);
    return false;
  }
  try {
    const procEntries = await readdir('/proc', { withFileTypes: true });
    for (const entry of procEntries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        continue;
      }
      const status = await readFile(path.join('/proc', entry.name, 'status'), 'utf8').catch(() => undefined);
      if (!status) {
        continue;
      }
      const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
      if (parent === String(shellPid)) {
        return false;
      }
    }
  } catch (error: unknown) {
    logger.debug(error instanceof Error ? error.message : String(error));
    return true;
  }
  return true;
}
