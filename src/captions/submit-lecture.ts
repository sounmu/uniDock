import { extractAudio } from "./audio-extract";
import { cancelJob, createJob, uploadAudio } from "./job-client";
import { mediaRangeReader } from "./media-fetch";
import { withCaptionMediaRule, type CaptionRuleChannel } from "./referer-rule";
import { errorCode } from "./work-protocol";

/** A lecture's media with the job key the worker derived from its content id. */
export interface LectureAudio {
  readonly mediaUrl: string;
  readonly durationS: number;
  readonly key: string;
}

export interface SubmitHooks {
  readonly signal: AbortSignal;
  /** False once the caller's run is superseded; submission stops quietly. */
  readonly live: () => boolean;
  readonly onJob: (jobId: string) => void;
  readonly onPhase: (phase: "extracting" | "uploading") => void;
  readonly rule: CaptionRuleChannel;
  /** Hands the job to the worker once the server has its audio. */
  readonly accept: (jobId: string, key: string) => Promise<void>;
}

/** Creates the lecture's job, uploads its audio unless the server already has
    it, and hands the job over so the worker follows it. Null when superseded. */
export async function submitLecture(
  media: LectureAudio,
  { signal, live, onJob, onPhase, rule, accept }: SubmitHooks,
): Promise<{ jobId: string; key: string } | null> {
  const { key } = media;
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
    const audio = await withCaptionMediaRule(media.mediaUrl, rule, async () =>
      extractAudio(await reader.totalSize(), reader.fetchRange, {
        signal,
        fetchRanges: reader.fetchRanges,
      }),
    );
    if (!live()) return null;
    onPhase("uploading");
    const upload = (target: string) => uploadAudio(target, audio, signal);
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
  await accept(id, key);
  return { jobId: id, key };
}
