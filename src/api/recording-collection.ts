import { NavigationCatalog } from "../navigation-catalog";
import type { RecordingTarget } from "../navigation-catalog";
import {
  accessible,
  availabilitySnapshot,
  internalId,
  recordingCandidate,
  recordingLabel,
} from "../recordings";
import { rows } from "../domain-items";

type Row = Record<string, unknown>;

type Collect = <T>(
  initial: string,
  path: string,
  project: (raw: unknown) => T[],
) => Promise<T[]>;

interface RecordingCollectionInput {
  readonly origin: string;
  readonly courseId: string;
  readonly path: string;
  readonly modules: readonly Row[];
  readonly collect: Collect;
  readonly catalog: NavigationCatalog;
  readonly now: number;
  readonly controller: AbortController;
  /**
   * KU player videos embedded in LearningX board posts, listed after modules.
   * `null` means the board source failed; module rows are still listed.
   */
  readonly boards?: () => Promise<RecordingTarget[] | null>;
}

export async function collectRecordings({
  origin,
  courseId,
  path,
  modules,
  collect,
  catalog,
  now,
  controller,
  boards,
}: RecordingCollectionInput) {
  const targetsByModule: RecordingTarget[][] = Array.from(
    { length: modules.length },
    () => [],
  );
  let nextModule = 0,
    totalTargets = 0;
  let failure: { error: unknown } | undefined;
  async function worker() {
    while (nextModule < modules.length && !controller.signal.aborted) {
      const index = nextModule++;
      const module = modules[index]!;
      try {
        if (!accessible(module, now)) continue;
        const targets = targetsByModule[index]!;
        let items = Array.isArray(module.items) ? module.items : [];
        if (
          module.items_count != null &&
          (!Number.isSafeInteger(module.items_count) ||
            Number(module.items_count) < 0)
        )
          throw new Error("INVALID_RESPONSE");
        if (
          Number(module.items_count) > items.length ||
          (module.items == null && module.items_count !== 0)
        ) {
          const moduleId = internalId(module.id);
          if (!moduleId) throw new Error("INVALID_RESPONSE");
          const itemPath = `${path}/${moduleId}/items`;
          items = await collect(
            `${itemPath}?per_page=100&include[]=content_details`,
            itemPath,
            rows,
          );
        }
        if (items.length > 10000) throw new Error("LIMIT");
        for (const item of items.flatMap((item) => rows([item]))) {
          if (!recordingCandidate(item, now)) continue;
          const itemId = internalId(item.id);
          targets.push({
            module: recordingLabel(module.name),
            title: recordingLabel(item.title),
            courseId,
            itemId,
            moduleAccess: availabilitySnapshot(module),
            itemAccess: availabilitySnapshot(item),
          });
          if (++totalTargets > 10000) throw new Error("LIMIT");
        }
      } catch (error) {
        failure ??= { error };
        controller.abort();
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, modules.length) }, () => worker()),
  );
  if (failure) throw failure.error;
  if (controller.signal.aborted) throw new Error("TIMEOUT");
  const targets = targetsByModule.flat();
  // Board videos are all-or-nothing on their own: a board failure drops every
  // board row and is reported, never a partial board list or a failed module list.
  let boardsUnavailable = false;
  if (boards) {
    const boardTargets = await boards();
    if (controller.signal.aborted) throw new Error("TIMEOUT");
    if (!boardTargets || targets.length + boardTargets.length > 10000)
      boardsUnavailable = true;
    else targets.push(...boardTargets);
  }
  return {
    recordings: catalog.replace(origin, targets),
    boardsUnavailable,
  };
}
