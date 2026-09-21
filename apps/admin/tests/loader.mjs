/**
 * node:test 自定义 ESM 解析钩子(自 apps/web/tests/loader.mjs 平移,去掉 studioApi mock——
 * admin 首批测试是契约级,直接加载真实 lib/api 模块):
 * 1. `.css` → 空模块(组件 import 样式时短路)
 * 2. `@/*` → apps/admin 根目录(对齐 tsconfig paths)
 * 3. 无扩展名的相对 import(tsconfig moduleResolution: bundler 风格)→ 补 .ts/.tsx 或 index.*
 * 4. load 钩子:.tsx 经 typescript transpileModule 转 ESM(Node strip-types 不认 .tsx)
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// typescript 从 apps/admin/node_modules 解析(loader 线程非 apps/admin cwd,显式 createRequire)
const require = createRequire(path.join(adminRoot, "package.json"));
const ts = require("typescript");

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
  if (specifier.endsWith(".css")) {
    return { url: "data:text/javascript,export default {}", shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    return {
      url: pathToFileURL(withExt(path.join(adminRoot, specifier.slice(2)))).href,
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

/** .tsx → ESM 源码(react-jsx 自动运行时)。 */
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const filename = fileURLToPath(url);
    const source = fs.readFileSync(filename, "utf8");
    const out = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
