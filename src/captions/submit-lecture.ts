import { extractAudio } from "./audio-extract";
import { cancelJob, createJob, uploadAudio } from "./job-client";
import { captionJobKey, saveActiveJob } from "./job-record";
import { mediaRangeReader } from "./media-fetch";
import type { MediaSource } from "./media-source";
import { withCaptionMediaRule } from "./referer-rule";

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

export interface SubmitHooks {
  readonly signal: AbortSignal;
  /** False once the caller's run is superseded; submission stops quietly. */
  readonly live: () => boolean;
  readonly onJob: (jobId: string) => void;
  readonly onPhase: (phase: "extracting" | "uploading") => void;
  readonly onProgress: (bytes: number) => void;
}

/** Creates the lecture's job, uploads its audio unless the server already has
    it, and records the job so the worker follows it. Null when superseded. */
export async function submitLecture(
  media: MediaSource,
  { signal, live, onJob, onPhase, onProgress }: SubmitHooks,
): Promise<{ jobId: string; key: string } | null> {
  const key = await captionJobKey(media.contentId);
  const hint = { durationHintS: media.durationS || undefined };
  // The per-lecture key returns this user's existing job for the lecture,
  // so a repeat request skips extraction and upload entirely.
  const job = await createJob(key, hint, signal);
  let id = job.id;
  onJob(id);
  if (!live()) return null;
  if (job.state === "awaiting_upload") {
    onPhase("extracting");
    const reader = mediaRangeReader(media.mediaUrl, signal);
    const audio = await withCaptionMediaRule(media.mediaUrl, async () =>
      extractAudio(await reader.totalSize(), reader.fetchRange, {
        signal,
        fetchRanges: reader.fetchRanges,
        onProgress,
      }),
    );
    if (!live()) return null;
    onPhase("uploading");
    const upload = (target: string) => uploadAudio(target, audio, signal, onProgress);
    try {
      await upload(id);
    } catch (error) {
      const code = errorCode(error);
      // UPLOAD_CLOSED: another upload of this job already finished, so the
      // job is simply followed.
      if (code === "UPLOAD_CONFLICT") {
        // The job holds a different length (e.g. an older extraction).
        // The same key would return the same job, so cancel it to release
        // the key and upload once into a fresh job.
        await cancelJob(id, signal);
        const fresh = await createJob(key, hint, signal);
        if (!live()) return null;
        if (fresh.id === id || fresh.state !== "awaiting_upload") throw error;
        id = fresh.id;
        onJob(id);
        onPhase("uploading");
        await upload(id);
      } else if (code !== "UPLOAD_CLOSED") throw error;
    }
  }
  if (!live()) return null;
  await saveActiveJob({ jobId: id, key });
  return { jobId: id, key };
}
