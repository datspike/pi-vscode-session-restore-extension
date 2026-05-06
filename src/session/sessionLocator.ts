import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { SessionCandidate } from '../types.js';

export interface LocateOptions {
  globPaths: string[];
  afterMs?: number;
  beforeMs?: number;
}

export class SessionLocator {
  public async locate(options: LocateOptions): Promise<SessionCandidate[]> {
    const files = new Set<string>();
    for (const globPath of options.globPaths) {
      for (const filePath of await expandJsonlGlob(globPath)) {
        files.add(filePath);
      }
    }

    const candidates: SessionCandidate[] = [];
    for (const filePath of files) {
      const fileStat = await stat(filePath).catch(() => undefined);
      if (!fileStat?.isFile()) {
        continue;
      }
      if (options.afterMs !== undefined && fileStat.mtimeMs < options.afterMs) {
        continue;
      }
      if (options.beforeMs !== undefined && fileStat.mtimeMs > options.beforeMs) {
        continue;
      }
      if (!(await looksLikePiSessionJsonl(filePath))) {
        continue;
      }
      candidates.push({ path: filePath, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
    }

    return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  }
}

export async function looksLikePiSessionJsonl(filePath: string): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let checked = 0;
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      checked += 1;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isObject(parsed)) {
          return true;
        }
      } catch {
        return false;
      }
      if (checked >= 3) {
        break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return false;
}

async function expandJsonlGlob(globPath: string): Promise<string[]> {
  const expanded = expandHome(globPath);
  const recursiveMarker = '/**/';
  if (expanded.includes(recursiveMarker)) {
    const [root, suffix] = expanded.split(recursiveMarker, 2) as [string, string];
    const names = await walk(root).catch(() => []);
    return names.filter((name) => matchesSuffix(name, suffix));
  }
  if (expanded.endsWith('*.jsonl')) {
    const dir = path.dirname(expanded);
    const names = await readdir(dir).catch(() => []);
    return names.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
  }
  return [expanded];
}

async function walk(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    return [];
  }
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walk(fullPath));
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
  return result;
}

function matchesSuffix(filePath: string, suffix: string): boolean {
  if (suffix === '*.jsonl') {
    return filePath.endsWith('.jsonl');
  }
  if (suffix.startsWith('*')) {
    return filePath.endsWith(suffix.slice(1));
  }
  return filePath.endsWith(suffix);
}

function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
