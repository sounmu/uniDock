import { copyFile, readFile } from "node:fs/promises";
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("Usage: node scripts/pages.mjs [--check]");
  process.exit(1);
}

const source = new URL("../public/privacy.html", import.meta.url);
const destinations = ["privacy.html", "index.html"];
const original = await readFile(source);

for (const name of destinations) {
  const destination = new URL(`../docs/${name}`, import.meta.url);
  if (args[0] === "--check") {
    const published = await readFile(destination).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!published?.equals(original)) {
      console.error(`docs/${name} is out of date. Run npm run pages:sync.`);
      process.exitCode = 1;
    }
  } else {
    await copyFile(source, destination);
    console.log(`Updated docs/${name}`);
  }
}
