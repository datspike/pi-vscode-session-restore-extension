import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

interface SessionStartEvent {
  reason?: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
  previousSessionFile?: string;
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (event: SessionStartEvent, ctx) => {
    if (process.env.PI_VSCODE_SESSION_RESTORE_PI_EXTENSION_ENABLED !== '1') {
      return;
    }

    const eventLogPath = process.env.PI_VSCODE_SESSION_RESTORE_EVENT_LOG;
    if (!eventLogPath) {
      return;
    }

    const sessionPath = ctx.sessionManager.getSessionFile();
    if (!sessionPath) {
      return;
    }

    const payload: Record<string, unknown> = {
      event: 'pi-session-start',
      time: Date.now(),
      cwd: ctx.sessionManager.getCwd(),
      pid: process.pid,
      ppid: process.ppid,
      marker: process.env.PI_VSCODE_SESSION_RESTORE_MARKER,
      sessionPath,
      sessionId: ctx.sessionManager.getSessionId(),
      reason: event.reason
    };

    if (event.previousSessionFile !== undefined) {
      payload.previousSessionFile = event.previousSessionFile;
    }

    await appendJsonLine(eventLogPath, payload);
  });
}

async function appendJsonLine(filePath: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // best-effort side-channel; Pi UX must not depend on VS Code bookkeeping
  }
}
