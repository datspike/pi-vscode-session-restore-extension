import path from 'node:path';
import type { MatchResult, PiInvocation, SessionCandidate, WrapperEvent } from '../types.js';

export interface MatchContext {
  invocation: PiInvocation;
  candidates: SessionCandidate[];
  wrapperEvents?: WrapperEvent[];
}

export class SessionMatcher {
  public match(context: MatchContext): MatchResult | undefined {
    const matches = context.candidates.map((candidate) => scoreCandidate(candidate, context.invocation, context.wrapperEvents ?? []));
    matches.sort((left, right) => right.score - left.score);
    return matches[0];
  }
}

function scoreCandidate(candidate: SessionCandidate, invocation: PiInvocation, wrapperEvents: WrapperEvent[]): MatchResult {
  let score = 0;
  const reasons: string[] = [];
  const end = invocation.endedAt ?? Date.now();
  const startsNearInvocation = candidate.mtimeMs >= invocation.startedAt - 2_000 && candidate.mtimeMs <= end + 60_000;
  if (startsNearInvocation) {
    score += 45;
    reasons.push('session mtime is near invocation window');
  }

  if (invocation.cwd && candidate.path.startsWith(path.resolve(invocation.cwd))) {
    score += 10;
    reasons.push('session path is under invocation cwd');
  }

  const wrapperMatch = wrapperEvents.find((event) => invocation.wrapperPid !== undefined && event.pid === invocation.wrapperPid);
  if (wrapperMatch) {
    score += 35;
    reasons.push('wrapper pid matches invocation');
  }

  if (invocation.wrapperPpid !== undefined || invocation.shellPid !== undefined) {
    const processPid = invocation.wrapperPpid ?? invocation.shellPid;
    const processMatch = wrapperEvents.find((event) => event.ppid === processPid || event.pid === processPid);
    if (processMatch) {
      score += 15;
      reasons.push('wrapper event matches shell process');
    }
  }

  if (candidate.size > 0) {
    score += 5;
    reasons.push('session file is non-empty JSONL');
  }

  const confidence = score >= 75 ? 'high' : score >= 45 ? 'medium' : 'low';
  if (reasons.length === 0) {
    reasons.push('no strong correlation signals');
  }
  return { candidate, confidence, score, reasons };
}
