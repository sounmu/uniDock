import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  manifestName,
  publishDemoOutput,
  readDemoOutput,
} from "../scripts/site-demo-output.mjs";

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const folder = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "site-demo-test-"));
  temporary.push(directory);
  return directory;
};
const write = (directory, file, text) => {
  mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  writeFileSync(path.join(directory, file), text);
};
const build = (files) => {
  const directory = folder();
  for (const [file, text] of Object.entries(files))
    write(directory, file, text);
  return directory;
};

it("accepts a missing or empty folder", async () => {
  const empty = folder();
  await expect(readDemoOutput(empty)).resolves.toEqual([]);
  await expect(readDemoOutput(path.join(empty, "new"))).resolves.toEqual([]);
});

it("refuses a non-empty folder it did not make and leaves its files alone", async () => {
  const site = folder();
  write(site, "index.html", "other site");
  write(site, "assets/app.js", "keep");
  await expect(readDemoOutput(site)).rejects.toThrow(
    "was not made by site:demo",
  );
  expect(readFileSync(path.join(site, "index.html"), "utf8")).toBe(
    "other site",
  );
  expect(readFileSync(path.join(site, "assets/app.js"), "utf8")).toBe("keep");
});

it("rejects a file list that points outside the folder", async () => {
  const out = folder();
  write(out, manifestName, JSON.stringify(["../outside.txt"]));
  await expect(readDemoOutput(out)).rejects.toThrow("is not a file list");
});

it("replaces only the files of the previous run", async () => {
  const out = folder();
  await publishDemoOutput(
    build({ "index.html": "v1", "assets/index-old.js": "old" }),
    out,
    await readDemoOutput(out),
  );
  write(out, "notes.txt", "added by hand");

  const files = await publishDemoOutput(
    build({ "index.html": "v2", "assets/index-new.js": "new" }),
    out,
    await readDemoOutput(out),
  );

  expect(files).toEqual(["assets/index-new.js", "index.html"]);
  expect(await readDemoOutput(out)).toEqual(files);
  expect(readFileSync(path.join(out, "index.html"), "utf8")).toBe("v2");
  expect(readdirSync(path.join(out, "assets"))).toEqual(["index-new.js"]);
  expect(readFileSync(path.join(out, "notes.txt"), "utf8")).toBe(
    "added by hand",
  );
});
