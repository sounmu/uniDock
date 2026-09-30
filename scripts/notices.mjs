import fs from "node:fs";
import { dependencyNoticesText } from "./dependency-notices.mjs";
fs.writeFileSync("public/THIRD_PARTY_NOTICES.txt", dependencyNoticesText());
