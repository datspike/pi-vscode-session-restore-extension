import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SessionLocator, looksLikePiSessionJsonl } from '../src/session/sessionLocator.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-session-locator-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('SessionLocator', () => {
  test('test_locate_valid_jsonl_in_window_expected_candidate', async () => {
    'Валидный JSONL в окне времени возвращается кандидатом.';
    const sessions = path.join(tempDir, 'sessions', 'nested');
    await mkdir(sessions, { recursive: true });
    const validPath = path.join(sessions, 'session.jsonl');
    const invalidPath = path.join(sessions, 'broken.jsonl');
    await writeFile(validPath, '{"type":"message","text":"hello"}\n', 'utf8');
    await writeFile(invalidPath, 'not-json\n', 'utf8');
    const mtime = new Date(10_000);
    await utimes(validPath, mtime, mtime);
    await utimes(invalidPath, mtime, mtime);

    const locator = new SessionLocator();
    const candidates = await locator.locate({
      globPaths: [path.join(tempDir, 'sessions', '**', '*.jsonl')],
      afterMs: 9_000,
      beforeMs: 11_000
    });

    expect(candidates).toEqual([{ path: validPath, mtimeMs: 10_000, size: 34 }]);
  });

  test('test_looks_like_pi_session_empty_file_expected_false', async () => {
    'Пустой файл не считается session JSONL.';
    const filePath = path.join(tempDir, 'empty.jsonl');
    await writeFile(filePath, '', 'utf8');
    expect(await looksLikePiSessionJsonl(filePath)).toBe(false);
  });
});
