import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { readConfig } from './config.js';
import { configurePathWrapper } from './env/pathWrapper.js';
import { Logger } from './log.js';
import { RestoreManager } from './restore/restoreManager.js';
import { RecordStore } from './store/recordStore.js';
import { TerminalTracker } from './tracker/terminalTracker.js';
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

  const applyPathWrapper = (): void => configurePathWrapper(context, {
    extensionUri: context.extensionUri,
    eventLogPath,
    enabled: config.enabled
  });
  applyPathWrapper();

  const store = new RecordStore(storageDir);
  const tracker = new TerminalTracker(store, getConfig, logger);
  tracker.register(context);
  const tail = new WrapperEventTail(eventLogPath);
  const interval = setInterval(() => {
    void tail.readNewEvents().then((events) => tracker.ingestWrapperEvents(events)).catch((error: unknown) => {
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
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Pi Session Restore');
    const manager = new RestoreManager(store, getConfig());
    const reason = await manager.restoreLast(terminal, getWorkspaceScopeCwd(), confirmRestore);
    logger.info(`Restore command result: ${reason}`);
  }));

  scheduleConservativeAutoRestore(store, getConfig, logger);
  logger.info('Pi Session Restore activated.');
}

export function deactivate(): void {
  // extension resources are disposed through VS Code subscriptions
}

function getWorkspaceScopeCwd(): string | undefined {
  return vscode.window.activeTerminal?.shellIntegration?.cwd?.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
  }, 3_000);
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

  const scopeCwd = getWorkspaceScopeCwd();
  if (scopeCwd === undefined) {
    logger.info('Auto-restore skipped because workspace scope is unknown.');
    return;
  }

  const idleTerminals = await getIdleTerminals(vscode.window.terminals, logger);
  if (idleTerminals.length === 0) {
    logger.info('Auto-restore skipped because no idle terminals are available.');
    return;
  }

  const manager = new RestoreManager(store, config);
  const result = await manager.autoRestoreMany(idleTerminals, scopeCwd);
  logger.info(`Auto-restore result: restored=${result.restored}, skipped=${result.skipped.join('; ')}`);
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

async function terminalLooksIdle(terminal: vscode.Terminal, logger: Logger): Promise<boolean> {
  if (process.platform !== 'linux') {
    return true;
  }
  const shellPid = await terminal.processId;
  if (shellPid === undefined) {
    return true;
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
