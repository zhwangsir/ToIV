/**
 * node:test 自定义 ESM 解析钩子:
 * 1. `@/lib/api` → tests/mocks/studioApi.ts(useStudioProject 单测的可控替身;
 *    trackJob 走的是相对 import ./api,不受影响)
 * 2. `@/*` → apps/web 根目录(对齐 tsconfig paths)
 * 3. 无扩展名的相对 import(tsconfig moduleResolution: bundler 风格)→ 补 .ts/.tsx
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiMock = pathToFileURL(path.join(webRoot, "tests", "mocks", "studioApi.ts")).href;

/** 依次尝试补扩展名,返回首个真实存在的文件路径。 */
function withExt(p) {
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
    if (fs.existsSync(p + ext)) return p + ext;
  }
  for (const ext of [".ts", ".tsx"]) {
    const idx = path.join(p, `index${ext}`);
    if (fs.existsSync(idx)) return idx;
  }
  return p + ".ts";
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/api") {
    return { url: apiMock, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    return {
      url: pathToFileURL(withExt(path.join(webRoot, specifier.slice(2)))).href,
      shortCircuit: true,
    };
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:") &&
    !/\.(ts|tsx|js|mjs|cjs|json)$/.test(specifier)
  ) {
    const abs = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    const resolved = withExt(abs);
    if (fs.existsSync(resolved)) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
