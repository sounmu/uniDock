import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export function textPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replaceAll(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export async function syntheticServer(
  directory: string,
  fixture: { paginatedDocuments?: boolean; selectorCourses?: boolean } = {},
) {
  const keyPath = path.join(directory, "key.pem"),
    certPath = path.join(directory, "cert.pem");
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=mylms.korea.ac.kr",
  ]);
  let coursesRequestCount = 0;
  const downloads: string[] = [];
  const requests: {
    host: string;
    method: string;
    pathname: string;
    search: string;
  }[] = [];
  const pdf = textPdf("Operating systems schedule runnable processes.");
  let nextDownloadGate: Promise<void> | undefined;
  const server = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    async (request, response) => {
      const url = new URL(request.url ?? "/", "https://mylms.korea.ac.kr");
      requests.push({
        host: request.headers.host ?? "",
        method: request.method ?? "",
        pathname: url.pathname,
        search: url.search,
      });
      const selectorRoutes: Record<string, unknown> = {
        "/api/v1/courses": [
          { id: 301, name: "Duplicate Course" },
          { id: 302, name: "Duplicate Course" },
          { id: 303, name: "token=private-value" },
          { id: 304, name: "   " },
        ],
        "/api/v1/courses/301/assignments": [
          {
            name: "First duplicate assignment",
            due_at: "2099-10-01T09:00:00+09:00",
            published: true,
            locked_for_user: false,
            submission: { workflow_state: "unsubmitted" },
          },
        ],
        "/api/v1/courses/302/assignments": [
          {
            name: "Second duplicate assignment",
            due_at: "2099-10-02T09:00:00+09:00",
            published: true,
            locked_for_user: false,
            submission: { workflow_state: "unsubmitted" },
          },
        ],
        "/api/v1/courses/303/assignments": [],
        "/api/v1/courses/304/assignments": [],
        "/api/v1/courses/301/modules": [],
        "/api/v1/courses/303/modules": [],
        "/api/v1/courses/304/modules": [],
        "/api/v1/courses/302/modules": [
          {
            id: 30,
            name: "Selector fixture module",
            published: true,
            items_count: 2,
            items: [
              {
                id: 700,
                content_id: 601,
                type: "File",
                title: "second-duplicate.pdf",
              },
              {
                id: 701,
                type: "ExternalTool",
                title: "Second duplicate recording",
                html_url:
                  "https://mylms.korea.ac.kr/courses/302/modules/items/701",
              },
            ],
          },
        ],
      };
      const routes: Record<string, unknown> = fixture.selectorCourses
        ? { "/api/v1/users/self": { id: 71 }, ...selectorRoutes }
        : {
            "/api/v1/users/self": { id: 71 },
            "/api/v1/courses": [
              { id: 101, name: "Synthetic Operating Systems" },
              { id: 202, name: "Synthetic International Law" },
            ],
            "/api/v1/courses/101/assignments": [
              {
                name: "Synthetic Final Project",
                due_at: "2099-09-20T14:00:00+09:00",
                published: true,
                locked_for_user: false,
                submission: {
                  workflow_state: "unsubmitted",
                  submitted_at: null,
                  missing: false,
                  late: false,
                },
              },
            ],
            "/api/v1/courses/202/assignments": [
              {
                name: "Synthetic Submitted Essay",
                due_at: "2026-09-10T14:00:00+09:00",
                submission: {
                  workflow_state: "submitted",
                  submitted_at: "2026-09-09T14:00:00+09:00",
                },
              },
              {
                name: "Synthetic Undated Reading",
                due_at: null,
                submission: { workflow_state: "unsubmitted" },
              },
              {
                name: "Synthetic Early Deadline",
                due_at: "2099-08-20T14:00:00+09:00",
                submission: { workflow_state: "unsubmitted" },
              },
            ],
            "/api/v1/courses/202/modules": [],
            "/api/v1/planner/items": [],
            "/api/v1/courses/101/modules": [
              {
                id: 10,
                name: "Week 1",
                published: true,
                items_count: fixture.paginatedDocuments ? 1001 : 4,
                items: fixture.paginatedDocuments
                  ? undefined
                  : [
                      {
                        id: 900,
                        content_id: 501,
                        type: "File",
                        title: "lecture.pdf",
                        content_details: { display_name: "lecture.pdf" },
                      },
                      {
                        id: 901,
                        content_id: 502,
                        type: "File",
                        title: "reading.pdf",
                      },
                      {
                        id: 902,
                        type: "ExternalTool",
                        title: "Synthetic Lecture A",
                        html_url:
                          "https://mylms.korea.ac.kr/courses/101/modules/items/902",
                      },
                      {
                        id: 903,
                        type: "ExternalTool",
                        title: "Synthetic Lecture B",
                        html_url:
                          "https://mylms.korea.ac.kr/courses/101/modules/items/903",
                      },
                    ],
              },
            ],
          };
      if (url.pathname === "/api/v1/courses") coursesRequestCount++;
      if (request.method !== "GET") {
        response.writeHead(405);
        response.end();
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname === "/em/caption-fixture") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          '<!doctype html><html><title>Iframe Caption Fixture</title><body><ul id="cs-script-list"><li class="cs-script-item"><span class="cs-script-item-time">00:00</span><span class="cs-script-item-text">Iframe caption text</span></li></ul></body></html>',
        );
        return;
      }
      if (
        fixture.paginatedDocuments &&
        url.pathname === "/api/v1/courses/101/modules/10/items"
      ) {
        const page = url.searchParams.get("page");
        const items =
          page === "2"
            ? [
                {
                  id: 11000,
                  content_id: 21000,
                  type: "File",
                  title: "1000-last.pdf",
                },
              ]
            : Array.from({ length: 1000 }, (_, index) => ({
                id: 10000 + index,
                content_id: 20000 + index,
                type: "File",
                title: `${String(index).padStart(4, "0")}.pdf`,
              }));
        response.writeHead(200, {
          "Content-Type": "application/json",
          ...(page === "2"
            ? {}
            : {
                Link: `<https://mylms.korea.ac.kr${url.pathname}?page=2>; rel="next"`,
              }),
        });
        response.end(JSON.stringify(items));
        return;
      }
      if (
        /^\/courses\/101\/files\/(501|502)\/download$/.test(url.pathname) &&
        url.search === "?download_frd=1"
      ) {
        downloads.push(url.pathname);
        const gate = nextDownloadGate;
        nextDownloadGate = undefined;
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment",
          "Content-Length": pdf.length,
        });
        if (gate) {
          response.write(pdf.subarray(0, 1));
          await gate;
          response.end(pdf.subarray(1));
        } else response.end(pdf);
        return;
      }
      if (
        url.pathname === "/" ||
        /^\/courses\/101\/modules\/items\/(900|902|903)$/.test(url.pathname) ||
        (fixture.selectorCourses &&
          url.pathname === "/courses/302/modules/items/701")
      ) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          '<!doctype html><html lang="en"><title>Synthetic LMS</title><body><main><h1>Synthetic LMS</h1><p>Browser fixture for uniDock.</p></main></body></html>',
        );
        return;
      }
      if (url.pathname in routes) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(routes[url.pathname]));
        return;
      }
      response.writeHead(404);
      response.end("not found");
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture server address");
  return {
    port: address.port,
    pdf,
    downloads,
    requests,
    holdNextDownload: () => {
      let release!: () => void;
      nextDownloadGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    coursesSeen: () => coursesRequestCount > 0,
    coursesCount: () => coursesRequestCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
