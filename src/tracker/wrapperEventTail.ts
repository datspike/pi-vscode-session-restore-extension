import { open, stat } from 'node:fs/promises';
import type { TrackerEvent } from '../types.js';

export class WrapperEventTail {
  private offset = 0;

  public constructor(private readonly filePath: string) {}

  public async readNewEvents(): Promise<TrackerEvent[]> {
    const fileStat = await stat(this.filePath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      return [];
    }
    if (fileStat.size < this.offset) {
      this.offset = 0;
    }
    if (fileStat.size === this.offset) {
      return [];
    }

    const handle = await open(this.filePath, 'r');
    try {
      const length = fileStat.size - this.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      this.offset = fileStat.size;
      return parseTrackerEvents(buffer.toString('utf8'));
    } finally {
      await handle.close();
    }
  }
}

export function parseWrapperEvents(raw: string): TrackerEvent[] {
  return parseTrackerEvents(raw);
}

export function parseTrackerEvents(raw: string): TrackerEvent[] {
  const events: TrackerEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as TrackerEvent;
      if (event.event === 'pi-wrapper-invocation' || event.event === 'pi-wrapper-exit' || event.event === 'pi-session-start') {
        events.push(event);
      }
    } catch {
      // malformed line is ignored; wrapper logging is best-effort
    }
  }
  return events;
}
