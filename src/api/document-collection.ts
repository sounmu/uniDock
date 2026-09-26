import { NavigationCatalog, type DocumentTarget } from "../navigation-catalog";
import { rows } from "../domain-items";
import {
  accessible,
  availabilitySnapshot,
  internalId,
  recordingLabel,
} from "../recordings";
import { documentCandidate } from "../documents";

type Row = Record<string, unknown>;
type Collect = <T>(
  initial: string,
  path: string,
  project: (raw: unknown) => T[],
) => Promise<T[]>;

export async function collectDocuments({
  origin,
  courseId,
  path,
  modules,
  collect,
  catalog,
  now,
  controller,
}: {
  origin: string;
  courseId: string;
  path: string;
  modules: readonly Row[];
  collect: Collect;
  catalog: NavigationCatalog;
  now: number;
  controller: AbortController;
}) {
  const byModule: DocumentTarget[][] = Array.from(
    { length: modules.length },
    () => [],
  );
  let next = 0,
    total = 0;
  let failure: { error: unknown } | undefined;
  async function worker() {
    while (next < modules.length && !controller.signal.aborted) {
      const index = next++;
      const module = modules[index]!;
      try {
        if (!accessible(module, now)) continue;
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
          const id = internalId(module.id);
          if (!id) throw new Error("INVALID_RESPONSE");
          const itemPath = `${path}/${id}/items`;
          items = await collect(
            `${itemPath}?per_page=100&include[]=content_details`,
            itemPath,
            rows,
          );
        }
        if (items.length > 10000) throw new Error("LIMIT");
        for (const item of rows(items)) {
          if (!documentCandidate(item, now)) continue;
          const id = internalId(item.id);
          if (!id) continue;
          const details = item.content_details as Row | undefined;
          byModule[index]!.push({
            module: recordingLabel(module.name),
            title: recordingLabel(item.title ?? details?.display_name),
            courseId,
            itemId: id,
            fileId: internalId(item.content_id),
            moduleAccess: availabilitySnapshot(module),
            itemAccess: availabilitySnapshot(item),
          });
          if (++total > 10000) throw new Error("LIMIT");
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
  return catalog.replaceDocuments(origin, byModule.flat(), now);
}
