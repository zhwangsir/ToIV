#!/usr/bin/env node
/**
 * ui_lint.mjs — ToIV 前端 UI 一致性门禁(2026-08-14 UI 二轮优化引入)
 *
 * 硬门禁(命中即 exit 1):
 *   1. font-weight 数字字面值(应走 var(--font-*))
 *   2. window.confirm(/window.alert((应走 ui/Modal)
 *   3. <button> 缺 type 属性
 *   4. 生产 tsx 内联 hex 颜色(白名单:theme.ts swatch、global-error/not-found 兜底、功能色注释)
 * 软提醒(仅 warn 不 fail):
 *   5. css 中 animation 字面时长(应走 var(--duration-*))
 *   6. tsx 中 z-index 裸值(应走 var(--z-*),0/1 层内微调除外)
 *
 * 用法: node scripts/ui_lint.mjs   (CI/预提交均可)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const WEB = join(ROOT, "apps", "web");

const SKIP_DIRS = new Set(["node_modules", ".next", "tests", "e2e", "playwright-report", "test-results"]);
// hex 白名单:主题色板/错误页兜底/功能默认值(均已在文件内注释声明)
const HEX_ALLOW = new Set([
  "apps/web/lib/theme.ts",
  "apps/web/app/global-error.tsx",
  "apps/web/app/not-found.tsx",
  "apps/web/app/layout.tsx",
  "apps/web/components/video-edit/VideoEditView.tsx", // 字幕烧录默认色,文件内已注释
  "apps/web/components/ui/ParticleButton.tsx", // JS fallback 色,已注释
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(WEB);
const hard = [];
const soft = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  lines.forEach((line, i) => {
    const ln = `${rel}:${i + 1}`;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
    if (line.includes("ui-lint-ok")) return; // 行级豁免(须附理由注释)

    if (/font-weight:\s*[0-9]/.test(line) && !line.includes("--font-")) {
      hard.push(`[font-weight] ${ln}  ${trimmed}`);
    }
    if (/window\.(confirm|alert)\s*\(/.test(line)) {
      hard.push(`[native-dialog] ${ln}  ${trimmed}`);
    }
    if (file.endsWith(".tsx") && /#[0-9a-fA-F]{3,8}\b/.test(line) && !HEX_ALLOW.has(rel)) {
      // 排除 mask/url 等功能串
      if (!/mask|url\(|xmlns/.test(line)) hard.push(`[hex-color] ${ln}  ${trimmed}`);
    }
    if (file.endsWith(".css") && /animation:[^;{}]*\s[0-9.]+m?s\b/.test(line) && !line.includes("var(--duration")) {
      soft.push(`[anim-duration] ${ln}  ${trimmed}`);
    }
    if (file.endsWith(".tsx") && /z-?[iI]ndex:\s*[^v0-1]/.test(line) && !/var\(|calc\(|["']/.test(line.split(/z-?[iI]ndex:/)[1] ?? "")) {
      soft.push(`[z-index] ${ln}  ${trimmed}`);
    }
  });

  // <button> 缺 type:剥离 => 与注释(注释内容替换为等长空白保行号),避免箭头函数 >/注释内示例标签干扰
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'])\/\/[^\n]*/g, (s, p1) => p1 + " ".repeat(s.length - p1.length))
    .replace(/=>/g, "  ");
  const btnRe = /<button\b([^>]*)>/gs;
  let m;
  while ((m = btnRe.exec(stripped)) !== null) {
    if (!/\btype\s*=/.test(m[1]) && !/\{\.\.\./.test(m[1])) {
      const ln = src.slice(0, m.index).split("\n").length;
      hard.push(`[button-type] ${rel}:${ln}  <button${m[1].slice(0, 60).replace(/\s+/g, " ")}…>`);
    }
  }
}

for (const s of soft) console.warn(`WARN ${s}`);
if (hard.length) {
  console.error(`\nUI 门禁失败 ${hard.length} 处:`);
  for (const h of hard) console.error(`  FAIL ${h}`);
  process.exit(1);
}
console.log(`UI 门禁通过(${files.length} 文件,${soft.length} 条软提醒)`);
