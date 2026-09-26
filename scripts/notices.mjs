import fs from "node:fs";
import { dependencyNotices } from "./dependency-notices.mjs";
const notices = dependencyNotices();
fs.writeFileSync(
  "public/THIRD_PARTY_NOTICES.txt",
  notices.map((notice) => notice.trimEnd()).join("\n\n---\n\n") + "\n",
);
