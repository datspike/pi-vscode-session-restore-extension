import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export class PiCliAdapter {
  public buildResumeCommand(sessionPathOrId: string): string {
    return `pi --session ${quoteForShell(sessionPathOrId)}`;
  }

  public async findRealPi(pathValue: string, wrapperDir: string): Promise<string | undefined> {
    const entries = pathValue.split(path.delimiter).filter((entry) => entry.length > 0);
    const resolvedWrapperDir = path.resolve(wrapperDir);
    for (const entry of entries) {
      const resolvedEntry = path.resolve(entry);
      if (resolvedEntry === resolvedWrapperDir) {
        continue;
      }
      const candidate = path.join(resolvedEntry, 'pi');
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
}

export function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
