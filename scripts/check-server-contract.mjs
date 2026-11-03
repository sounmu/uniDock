import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const copies = {
  "captions-public.openapi.yaml": "documentation/api/public.openapi.yaml",
  "stats-report.schema.json": "documentation/api/stats-report.schema.json",
  "analytics-report-contract.json":
    "tests/fixtures/analytics-report-contract.json",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Verify the offline pin; optionally compare it with the canonical server checkout. */
export function checkServerContract(extensionRoot = root, serverRoot) {
  const lock = JSON.parse(
    readFileSync(
      path.join(extensionRoot, "documentation/api/server-contract.lock.json"),
      "utf8",
    ),
  );
  if (
    !object(lock) ||
    lock.formatVersion !== 1 ||
    lock.repository !== "sounmu/unidock-server" ||
    typeof lock.contractVersion !== "string" ||
    !/^[1-9]\d*\.\d+\.\d+$/.test(lock.contractVersion) ||
    lock.manifestPath !==
      `contracts/releases/${lock.contractVersion}/manifest.json` ||
    typeof lock.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(lock.manifestSha256)
  ) {
    throw new Error("Invalid server contract lock");
  }
  const manifestBytes = readFileSync(
    path.join(extensionRoot, "documentation/api/server-contract.manifest.json"),
  );
  if (digest(manifestBytes) !== lock.manifestSha256) {
    throw new Error("Server contract manifest differs from its pin");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    !object(manifest) ||
    manifest.formatVersion !== 1 ||
    manifest.contractVersion !== lock.contractVersion ||
    !object(manifest.artifacts) ||
    JSON.stringify(Object.keys(manifest.artifacts).sort()) !==
      JSON.stringify(Object.keys(copies).sort())
  ) {
    throw new Error("Invalid server contract manifest");
  }
  for (const [name, destination] of Object.entries(copies)) {
    const expected = manifest.artifacts[name];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`Invalid contract digest: ${name}`);
    }
    if (
      digest(readFileSync(path.join(extensionRoot, destination))) !== expected
    ) {
      throw new Error(`Vendored server contract differs: ${name}`);
    }
    if (
      serverRoot &&
      digest(
        readFileSync(
          path.join(serverRoot, path.dirname(lock.manifestPath), name),
        ),
      ) !== expected
    ) {
      throw new Error(`Canonical server contract differs: ${name}`);
    }
  }
  if (
    serverRoot &&
    digest(readFileSync(path.join(serverRoot, lock.manifestPath))) !==
      lock.manifestSha256
  ) {
    throw new Error("Canonical server manifest differs from its pin");
  }
  return lock.contractVersion;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--server")) {
    throw new Error(
      "usage: node scripts/check-server-contract.mjs [--server SERVER_CHECKOUT]",
    );
  }
  process.stdout.write(
    `Server contract ${checkServerContract(root, args[1])}: verified\n`,
  );
}
