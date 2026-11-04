import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkServerContract } from "../scripts/check-server-contract.mjs";

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("verifies the shipped server artifacts without access to the private server repository", () => {
  expect(checkServerContract()).toBe("1.0.0");
});

it.each([
  [
    "documentation/api/server-contract.manifest.json",
    "manifest differs from its pin",
  ],
  ["documentation/api/public.openapi.yaml", "Vendored server contract differs"],
  [
    "documentation/api/stats-report.schema.json",
    "Vendored server contract differs",
  ],
  [
    "tests/fixtures/analytics-report-contract.json",
    "Vendored server contract differs",
  ],
])("rejects a modified pinned artifact: %s", (file, message) => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "unidock-contract-pin-"),
  );
  temporary.push(directory);
  cpSync("documentation/api", path.join(directory, "documentation/api"), {
    recursive: true,
  });
  mkdirSync(path.join(directory, "tests/fixtures"), { recursive: true });
  cpSync(
    "tests/fixtures/analytics-report-contract.json",
    path.join(directory, "tests/fixtures/analytics-report-contract.json"),
  );
  appendFileSync(path.join(directory, file), "\n");
  expect(() => checkServerContract(directory)).toThrow(message);
});
