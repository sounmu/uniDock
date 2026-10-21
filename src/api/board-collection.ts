import type { DocumentTarget, RecordingTarget } from "../navigation-catalog";
import { rows } from "../domain-items";
import { internalId, playerEmbeds, recordingLabel } from "../recordings";
import { documentFilename } from "../documents";
import { readUrl } from "../security/policy";
import { readJsonBounded } from "./body";

type Row = Record<string, unknown>;

// Own budget so a large board cannot starve the shared Canvas page budget.
const MAX_REQUESTS = 300;

interface BoardSource {
  origin: string;
  courseId: string;
  token: string | null;
  fetcher: typeof fetch;
  signal: AbortSignal;
  now: number;
}

type Reader = {
  root: string;
  get(initial: string, path: string, optional?: boolean): Promise<unknown>;
};

/**
 * Bounded reader for the fixed LearningX board GET paths. The bearer token is
 * attached here only and never leaves this module.
 */
function boardReader({
  origin,
  courseId,
  token,
  fetcher,
  signal,
}: BoardSource): Reader {
  const root = `/learningx/api/v1/learningx_board/courses/${courseId}/boards`;
  let requests = 0;
  return {
    root,
    async get(initial, path, optional = false) {
      if (signal.aborted) throw new Error("TIMEOUT");
      if (requests++ >= MAX_REQUESTS) throw new Error("LIMIT");
      const response = await fetcher(readUrl(initial, origin, path).href, {
        method: "GET",
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal,
      });
      if (optional && [401, 403, 404].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      // A LearningX refusal says nothing about the Canvas session, so it must
      // not surface as LOGIN_REQUIRED/FORBIDDEN, which reset the account scope.
      if (response.type === "opaqueredirect" || !response.ok)
        throw new Error("NETWORK");
      const type = response.headers.get("content-type") ?? "";
      if (!/^application\/json\b/i.test(type))
        throw new Error("INVALID_RESPONSE");
      const raw = await readJsonBounded(response);
      if (signal.aborted) throw new Error("TIMEOUT");
      return raw;
    },
  };
}

/** Every post page of one board, in board order. */
async function boardPosts(reader: Reader, boardId: string): Promise<Row[]> {
  const postsPath = `${reader.root}/${boardId}/posts`;
  const posts: Row[] = [];
  for (let page = 1, last = 1; page <= last; page++) {
    const raw = await reader.get(`${postsPath}?page=${page}`, postsPath);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("INVALID_RESPONSE");
    const body = raw as Row;
    posts.push(...rows(body.items));
    if (posts.length > 10000) throw new Error("LIMIT");
    const pagination = body.pagination as Row | undefined;
    const lastPage = pagination?.last_page ?? 1;
    if (
      !Number.isSafeInteger(lastPage) ||
      Number(lastPage) < 1 ||
      Number(lastPage) > 100
    )
      throw new Error("INVALID_RESPONSE");
    last = Number(lastPage);
  }
  return posts;
}

async function boardPost(
  reader: Reader,
  boardId: string,
  postId: string,
): Promise<Row> {
  const path = `${reader.root}/${boardId}/posts/${postId}`;
  const raw = await reader.get(path, path);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("INVALID_RESPONSE");
  return raw as Row;
}

/**
 * Lists PDF/PPT(X) attachments of LearningX board posts. Attachments are
 * Canvas files, so downloads reuse the canonical Canvas file route.
 * Boards are a supplementary source: a missing or expired token, or a first
 * board request the LMS refuses, yields no rows instead of failing the list.
 */
export async function collectBoardDocuments({
  seenFiles,
  ...source
}: BoardSource & { seenFiles: Set<string> }): Promise<DocumentTarget[]> {
  if (!source.token) return [];
  const { courseId, origin, now } = source;
  const reader = boardReader(source);
  const boardList = await reader.get(reader.root, reader.root, true);
  if (boardList === null) return [];
  const targets: DocumentTarget[] = [];
  for (const board of rows(boardList)) {
    const boardId = internalId(board.id);
    if (!boardId) continue;
    const posts = await boardPosts(reader, boardId);
    const postsBoard = boardId;
    const withFiles = posts.filter(
      (post) =>
        typeof post.attachment_count === "number" &&
        post.attachment_count > 0 &&
        !scheduled(post.reserved_at, now),
    );
    const details: (Row | null)[] = Array.from(
      { length: withFiles.length },
      () => null,
    );
    let next = 0;
    async function worker() {
      while (next < withFiles.length) {
        const index = next++;
        const postId = internalId(withFiles[index]!.id);
        if (!postId) continue;
        details[index] = await boardPost(reader, postsBoard, postId);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(3, withFiles.length) }, () => worker()),
    );
    for (const post of details) {
      if (!post) continue;
      const postId = internalId(post.id);
      if (!postId) continue;
      const toolId = boardToolId(post.post_url, origin, courseId);
      const attachments =
        post.attachments == null ? [] : rows(post.attachments);
      for (const attachment of attachments) {
        const fileId = internalId(attachment.canvas_file_id);
        const title = documentFilename({ filename: attachment.filename });
        if (!fileId || !title || seenFiles.has(fileId)) continue;
        seenFiles.add(fileId);
        targets.push({
          module: `게시판 · ${recordingLabel(post.title)}`,
          title,
          filename: title,
          courseId,
          itemId: postId,
          boardToolId: toolId,
          fileId,
          moduleAccess: {},
          itemAccess: {},
        });
        if (targets.length > 10000) throw new Error("LIMIT");
      }
    }
  }
  return targets;
}

/**
 * Lists KU player videos that LearningX board posts embed as iframes (for
 * example lecture backups posted to the course board). The post list already
 * carries each post's HTML, so only one post detail per board is read, to
 * learn which course tool the board opens under. Same supplementary-source
 * rules as attachments: no token or a refused board list yields no rows.
 */
export async function collectBoardRecordings(
  source: BoardSource,
): Promise<RecordingTarget[]> {
  if (!source.token) return [];
  const { courseId, origin, now } = source;
  const reader = boardReader(source);
  const boardList = await reader.get(reader.root, reader.root, true);
  if (boardList === null) return [];
  const targets: RecordingTarget[] = [];
  for (const board of rows(boardList)) {
    const boardId = internalId(board.id);
    if (!boardId) continue;
    const posts = await boardPosts(reader, boardId);
    const videos = posts.flatMap((post) => {
      const postId = internalId(post.id);
      if (!postId || scheduled(post.reserved_at, now)) return [];
      const embeds = playerEmbeds(post.content);
      return embeds.map((playerUrl, index) => ({
        postId,
        title:
          embeds.length > 1
            ? `${recordingLabel(post.title)} (${index + 1})`
            : recordingLabel(post.title),
        playerUrl,
      }));
    });
    if (!videos.length) continue;
    const detail = await boardPost(reader, boardId, videos[0]!.postId);
    const toolId = boardToolId(detail.post_url, origin, courseId);
    if (!toolId) continue;
    const module = `게시판 · ${recordingLabel(board.title)}`;
    for (const video of videos) {
      targets.push({
        module,
        title: video.title,
        courseId,
        boardToolId: toolId,
        playerUrl: video.playerUrl,
        moduleAccess: {},
        itemAccess: {},
      });
      if (targets.length > 10000) throw new Error("LIMIT");
    }
  }
  return targets;
}

function scheduled(value: unknown, now: number): boolean {
  if (value == null) return false;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return !Number.isFinite(time) || time > now;
}

// `post_url` is a LearningX redirect carrying the course board tool; only the
// tool ID is kept so the LMS link can open the plain course tool route.
function boardToolId(
  value: unknown,
  origin: string,
  courseId: string,
): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return;
    const match =
      /^\/learningx\/redirect\/courses\/([1-9]\d{0,19})\/external_tools\/([1-9]\d{0,19})$/.exec(
        url.pathname,
      );
    return match?.[1] === courseId ? match[2] : undefined;
  } catch {
    return;
  }
}
