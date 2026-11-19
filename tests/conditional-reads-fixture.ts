import { createHash } from "node:crypto";

export const fixtureOrigin = "https://mylms.korea.ac.kr";
export const fixtureCourse = "101";

interface FixtureOptions {
  modules?: number;
  itemsPerModule?: number;
  rttMs?: number;
  bytesPerMs?: number;
}

export interface FixtureRequest {
  path: string;
  conditional: boolean;
  status: number;
  bytes: number;
}

type Row = Record<string, unknown>;

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : undefined;

/**
 * Deterministic fake Canvas course: modules without inline items (so every
 * module costs one item read), a recording and a document per item pair, and
 * ETag/If-None-Match support. `rttMs` and `bytesPerMs` make the simulated
 * latency a pure function of request and body size.
 */
export function createCanvasFixture({
  modules = 24,
  itemsPerModule = 12,
  rttMs = 0,
  bytesPerMs = Infinity,
}: FixtureOptions = {}) {
  const itemsByModule = new Map<number, Row[]>();
  for (let module = 1; module <= modules; module++) {
    const items: Row[] = [];
    for (let index = 1; index <= itemsPerModule; index++) {
      const id = module * 1000 + index;
      const common = { id, padding: "x".repeat(160) };
      items.push(
        index % 2
          ? {
              ...common,
              type: "ExternalTool",
              title: `강의 ${module}-${index}`,
              html_url:
                "https://lti.example.invalid/launch?token=fixture-secret",
            }
          : { ...common, type: "File", title: `slides-${module}-${index}.pdf` },
      );
    }
    itemsByModule.set(module, items);
  }
  const requests: FixtureRequest[] = [];
  let denied = false;
  const stats = () => ({
    calls: requests.length,
    conditional: requests.filter((request) => request.conditional).length,
    notModified: requests.filter((request) => request.status === 304).length,
    bodyBytes: requests.reduce((sum, request) => sum + request.bytes, 0),
  });

  function route(pathname: string): unknown {
    if (pathname === "/api/v1/courses")
      return [{ id: Number(fixtureCourse), name: "Course" }];
    const base = `/api/v1/courses/${fixtureCourse}/modules`;
    if (pathname === base)
      return Array.from({ length: modules }, (_, index) => ({
        id: index + 1,
        name: `${index + 1}주차`,
        items_count: itemsPerModule,
      }));
    const items = new RegExp(`^${base}/(\\d+)/items$`).exec(pathname);
    if (items) return itemsByModule.get(Number(items[1])) ?? [];
    if (pathname === `/api/v1/courses/${fixtureCourse}/discussion_topics`)
      return [];
    throw new Error(`Unrouted fixture path ${pathname}`);
  }

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const sent = (init?.headers as Record<string, string> | undefined)?.[
      "If-None-Match"
    ];
    await sleep(rttMs);
    const record = (status: number, bytes: number) => {
      requests.push({
        path: url.pathname,
        conditional: sent !== undefined,
        status,
        bytes,
      });
    };
    if (denied) {
      record(403, 0);
      return new Response(null, { status: 403 });
    }
    const body = JSON.stringify(route(url.pathname));
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    if (sent === etag) {
      record(304, 0);
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    const bytes = Buffer.byteLength(body);
    await sleep(bytes / bytesPerMs);
    record(200, bytes);
    return new Response(body, {
      headers: { "Content-Type": "application/json", ETag: etag },
    });
  };

  return {
    fetcher,
    requests,
    stats,
    reset: () => void (requests.length = 0),
    revoke: () => void (denied = true),
    setItems: (module: number, items: Row[]) =>
      void itemsByModule.set(module, items),
    items: (module: number) => itemsByModule.get(module)!,
  };
}
