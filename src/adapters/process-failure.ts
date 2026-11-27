import type { SpawnSyncReturns } from "node:child_process";

import type { CandidateProcessFailure } from "../types.ts";

// Only fatal process signals are attributed to the candidate. An outside
// kill (including an unconfirmed OOM) or a launch/I/O error is not a verdict.
export const isCrashSignal = (signal: unknown) => typeof signal === "string" &&
  /^(?:SIGABRT|SIGBUS|SIGFPE|SIGILL|SIGSEGV|SIGSYS|SIGTRAP)$/.test(signal);

export function processFailure(result: SpawnSyncReturns<string>, lastNormalExit: number): CandidateProcessFailure | undefined {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code !== "ETIMEDOUT") return undefined;
    if (result.status === null && (result.signal === "SIGTERM" || result.signal === "SIGKILL")) {
      return { kind: "deadline", errorCode: code, signal: result.signal };
    }
    // The deadline can fire just as the child exits (or after it handles TERM).
    // Keep the observed exit code; it does not turn a timed-out run into a pass.
    if (result.signal === null && result.status !== null && Number.isInteger(result.status) && result.status >= 0 && result.status <= 255) {
      return { kind: "deadline", errorCode: code, signal: null, exitCode: result.status };
    }
    return undefined;
  }
  if (result.status === null && isCrashSignal(result.signal)) return { kind: "signal", signal: result.signal! };
  // 126/127 and shell-style signal exit statuses don't prove the checker ran.
  if (result.signal === null && result.status !== null && result.status > lastNormalExit && result.status < 126) {
    return { kind: "exit", exitCode: result.status };
  }
}
