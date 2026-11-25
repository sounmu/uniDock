import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// site:demo writes into a folder that belongs to another repository, so it
// only ever touches files it listed there itself. A non-empty folder without
// that list is refused instead of emptied.
export const manifestName = ".site-demo-files.json";

const isOwnFile = (file) =>
  typeof file === "string" &&
  file !== "" &&
  !file.includes("\\") &&
  !path.isAbsolute(file) &&
  !file.split("/").includes("..");

// Returns the files a previous run left in outDir ([] for a missing or empty folder).
export async function readDemoOutput(outDir) {
  const entries = await readdir(outDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!entries.length) return [];
  if (!entries.includes(manifestName))
    throw new Error(
      `${outDir} is not empty and was not made by site:demo; choose an empty or dedicated folder.`,
    );
  const files = JSON.parse(
    await readFile(path.join(outDir, manifestName), "utf8"),
  );
  if (!Array.isArray(files) || !files.every(isOwnFile))
    throw new Error(`${path.join(outDir, manifestName)} is not a file list.`);
  return files;
}

// Removes the previous run's files, copies the new build in and records it.
// A build file that would overwrite a file it did not make stops the update
// before anything changes.
export async function publishDemoOutput(buildDir, outDir, previous) {
  const files = (
    await readdir(buildDir, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(buildDir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
  const owned = new Set(previous);
  for (const file of files) {
    if (owned.has(file)) continue;
    const exists = await access(path.join(outDir, file)).then(
      () => true,
      () => false,
    );
    if (exists)
      throw new Error(
        `${path.join(outDir, file)} was not made by site:demo; move it before updating.`,
      );
  }
  for (const file of previous)
    await rm(path.join(outDir, file), { force: true });
  await mkdir(outDir, { recursive: true });
  await cp(buildDir, outDir, { recursive: true });
  await writeFile(
    path.join(outDir, manifestName),
    `${JSON.stringify(files, null, 2)}\n`,
  );
  return files;
}
