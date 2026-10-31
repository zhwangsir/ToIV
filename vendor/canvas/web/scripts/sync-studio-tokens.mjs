import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = readFileSync(resolve(root, "src/studio/theme/tokens.css"), "utf8");
const banner = "/* 生成物：scripts/sync-studio-tokens.mjs · 单源 apps/canvas/web/src/studio/theme/tokens.css · 勿手改 */\n";
writeFileSync(resolve(root, "../../web/app/styles/studio-tokens.css"), banner + source);
console.log("studio tokens synced");
