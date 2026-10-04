import { NavigationCatalog, type DocumentTarget } from "../navigation-catalog";
import { rows } from "../domain-items";
import {
  accessible,
  availabilitySnapshot,
  internalId,
  recordingLabel,
} from "../recordings";
import { documentCandidate, documentFilename } from "../documents";

type Row = Record<string, unknown>;
type Collect = <T>(
  initial: string,
  path: string,
  project: (raw: unknown) => T[],
  optional?: boolean,
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
        for (const item of items.flatMap((item) => rows([item]))) {
          if (!documentCandidate(item, now)) continue;
          const id = internalId(item.id);
          if (!id) continue;
          const filename = documentFilename(item)!;
          byModule[index]!.push({
            module: recordingLabel(module.name),
            title: recordingLabel(item.title).trim() || filename,
            filename,
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
  const targets = byModule.flat();
  const topicPath = `/api/v1/courses/${courseId}/discussion_topics`;
  // Boards and announcements are supplementary: a course that hides or
  // forbids them still lists its weekly module materials.
  for (const announcements of [false, true]) {
    const topics = await collect(
      `${topicPath}?per_page=100${announcements ? "&only_announcements=true" : ""}`,
      topicPath,
      rows,
      true,
    );
    for (const topic of topics) {
      if (!accessible(topic, now)) continue;
      const topicId = internalId(topic.id);
      if (!topicId) continue;
      const attachments = rows([
        ...(topic.attachments == null ? [] : rows(topic.attachments)),
        ...(topic.attachment == null ? [] : [topic.attachment]),
      ]);
      const seen = new Set<string>();
      for (const attachment of attachments) {
        if (
          !accessible(attachment, now) ||
          attachment.hidden ||
          attachment.locked
        )
          continue;
        const fileId = internalId(attachment.id);
        const title = documentFilename(attachment);
        if (!fileId || !title || seen.has(fileId)) continue;
        seen.add(fileId);
        targets.push({
          module: `${announcements ? "공지" : "게시판"} · ${recordingLabel(topic.title)}`,
          title,
          filename: title,
          courseId,
          itemId: topicId,
          topicId,
          fileId,
          moduleAccess: availabilitySnapshot(topic),
          itemAccess: availabilitySnapshot(attachment),
        });
        if (++total > 10000) throw new Error("LIMIT");
      }
    }
  }
  return catalog.replaceDocuments(origin, targets, now);
}
