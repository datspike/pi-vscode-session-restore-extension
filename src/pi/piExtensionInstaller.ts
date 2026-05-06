import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';
import type { Logger } from '../log.js';

const EXTENSION_LINK_NAME = 'pi-vscode-session-restore';

export async function ensurePiSessionReporterInstalled(extensionUri: vscode.Uri, logger: Logger): Promise<void> {
  const sourceDir = path.join(extensionUri.fsPath, 'resources', 'pi-extension');
  const extensionsDir = path.join(os.homedir(), '.pi', 'agent', 'extensions');
  const linkPath = path.join(extensionsDir, EXTENSION_LINK_NAME);
  await mkdir(extensionsDir, { recursive: true });

  const existing = await lstat(linkPath).catch(() => undefined);
  if (!existing) {
    await symlink(sourceDir, linkPath, 'dir');
    logger.info(`Installed Pi session reporter extension: ${linkPath}`);
    return;
  }

  if (!existing.isSymbolicLink()) {
    logger.info(`Pi session reporter was not installed because ${linkPath} already exists.`);
    return;
  }

  const currentTarget = await readlink(linkPath);
  const resolvedCurrentTarget = path.resolve(path.dirname(linkPath), currentTarget);
  if (resolvedCurrentTarget === sourceDir) {
    return;
  }

  await unlink(linkPath);
  await symlink(sourceDir, linkPath, 'dir');
  logger.info(`Updated Pi session reporter extension: ${linkPath}`);
}
