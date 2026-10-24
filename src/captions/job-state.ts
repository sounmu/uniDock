export type JobPhase =
  | "idle"
  | "identifying"
  | "extracting"
  | "uploading"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

const NEXT: Record<JobPhase, readonly JobPhase[]> = {
  idle: ["identifying", "cancelled"],
  identifying: ["extracting", "failed", "cancelled"],
  extracting: ["uploading", "failed", "cancelled"],
  uploading: ["queued", "failed", "cancelled"],
  queued: ["running", "succeeded", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(phase: JobPhase): boolean {
  return NEXT[phase].length === 0;
}

export function canTransition(from: JobPhase, to: JobPhase): boolean {
  return NEXT[from].includes(to);
}

const SERVER_PHASE: Record<string, JobPhase> = {
  awaiting_upload: "uploading",
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

export function serverPhase(state: string): JobPhase | null {
  return SERVER_PHASE[state] ?? null;
}
