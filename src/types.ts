export type Confidence = 'high' | 'medium' | 'low';
export type RestorePolicyMode = 'off' | 'prompt' | 'auto-confident';
export type DiagnosticsLevel = 'off' | 'error' | 'info' | 'debug';

export interface ExtensionConfig {
  enabled: boolean;
  sessionGlobPaths: string[];
  restorePolicy: RestorePolicyMode;
  confidenceThreshold: Confidence;
  diagnosticsLevel: DiagnosticsLevel;
  recordTtlDays: number;
  installPiExtension: boolean;
}

export interface PiInvocation {
  command: 'pi' | 'p';
  args: string[];
  cwd?: string;
  startedAt: number;
  endedAt?: number;
  shellPid?: number;
  wrapperPid?: number;
  wrapperPpid?: number;
  sessionPath?: string;
  terminalName?: string;
  source: 'shellIntegration' | 'wrapper';
}

export interface WrapperEvent {
  event: 'pi-wrapper-invocation' | 'pi-wrapper-exit';
  time: number;
  cwd: string;
  argv: string[];
  pid: number;
  ppid: number;
  wrapperDir?: string;
  realPi?: string;
  exitCode?: number;
  marker?: string;
  sessionPath?: string;
}

export interface PiSessionEvent {
  event: 'pi-session-start';
  time: number;
  cwd: string;
  pid: number;
  ppid: number;
  marker?: string;
  sessionPath?: string;
  sessionId?: string;
  reason?: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
  previousSessionFile?: string;
}

export type TrackerEvent = WrapperEvent | PiSessionEvent;

export interface SessionCandidate {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface MatchResult {
  candidate: SessionCandidate;
  confidence: Confidence;
  score: number;
  reasons: string[];
}

export interface RestoreRecord {
  id: string;
  sessionPath: string;
  cwd?: string;
  command: string;
  args: string[];
  shellPid?: number;
  wrapperPid?: number;
  wrapperPpid?: number;
  startedAt: number;
  endedAt?: number;
  matchedAt: number;
  confidence: Confidence;
  score: number;
  reasons: string[];
  restoreAttempts: number;
  lastRestoreAt?: number;
  terminalName?: string;
}

export interface RecordStoreData {
  schemaVersion: 1;
  records: RestoreRecord[];
}

export interface RestoreDecision {
  action: 'skip' | 'prompt' | 'auto';
  reason: string;
}
