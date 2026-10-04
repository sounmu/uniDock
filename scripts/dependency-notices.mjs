import fs from "node:fs";
import path from "node:path";
export function dependencyNotices() {
  const notices = [
    "react",
    "react-dom",
    "scheduler",
    "wxt",
    "@wxt-dev/browser",
    "@posthog/core",
    "@posthog/types",
  ].map((name) => {
    const base = path.resolve("node_modules", name);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(base, "package.json"), "utf8"),
    );
    const license = fs
      .readdirSync(base)
      .find((file) => /^license(?:\.md|\.txt)?$/i.test(file));
    const fallback =
      ["wxt", "@wxt-dev/browser"].includes(name) && pkg.license === "MIT";
    if (!license && !fallback)
      throw new Error(`Missing dependency license: ${name}`);
    const file = license
      ? path.join(base, license)
      : "scripts/licenses/WXT-MIT.txt";
    return `${name} ${pkg.version} (${pkg.license})\n${fs.readFileSync(file, "utf8")}`;
  });
  return notices;
}
export function dependencyNoticesText() {
  return (
    dependencyNotices()
      .map((notice) => notice.replace(/[\t ]+$/gm, "").trimEnd())
      .join("\n\n---\n\n") + "\n"
  );
}
