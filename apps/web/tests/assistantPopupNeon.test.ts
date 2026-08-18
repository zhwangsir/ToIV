/**
 * RES2-2026-08-18 前端弹窗化/霓虹动画/Skill 检索 源码断言:
 * ① AssistantView popup 形态:仅对话区+输入框(页头/三面板/文档按钮/门户空态隐藏)
 * ② AssistantOverlay:variant="popup" 传递 + 最小关闭按钮
 * ③ page.tsx ⌘K 霓虹序列:registerProperty 注册 / reduced-motion 跳过 / neon-edge 渲染
 * ④ assistant.css:霓虹扫描 keyframes + 环形 mask + reduced-motion 静态回退
 * ⑤ SkillMarketView:搜索+范围筛选+R18 过滤三条件客户端过滤
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");
const readSrc = (p: string) => readFileSync(join(root, p), "utf8");

/* ── ① AssistantView popup 形态 ── */

test("AssistantView:variant prop 定义且 popup 隐藏页头/面板/文档按钮", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes(`variant?: "page" | "popup"`), "variant prop 缺失");
  assert.ok(src.includes(`props?.variant === "popup"`), "popup 派生缺");
  // 页头隐藏
  assert.ok(src.includes("{!popup && (\n      <header"), "页头未按 popup 隐藏");
  // 三个侧面板整体隐藏(fragment 包裹)
  assert.ok(src.includes("{!popup && (\n        <>"), "侧面板未按 popup 隐藏");
  // 文档入口按钮隐藏
  assert.ok(src.includes(") : !popup ? ("), "composer 文档按钮未按 popup 隐藏");
  // popup 空态极简 + 底部输入框
  assert.ok(src.includes("av-popup-empty"), "popup 极简空态缺失");
  assert.ok(src.includes("{(!isEmpty || popup) && renderComposer(false)}"), "popup 空态底部输入框缺失");
});

test("AssistantView:popup 气泡列 640px 收窄(层次聚焦)", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes(".av-view--popup .av-msg-list"), "popup 气泡列样式缺失");
  assert.ok(/max-width:\s*640px/.test(src), "popup 气泡列未收窄到 640px");
});

/* ── ② AssistantOverlay ── */

test("AssistantOverlay:variant=popup 传递 + 最小关闭按钮 + a11y", () => {
  const src = readSrc("components/assistant/AssistantOverlay.tsx");
  assert.ok(src.includes(`variant="popup"`), "未传 popup 形态");
  assert.ok(src.includes("av-overlay-close"), "最小关闭按钮缺失");
  assert.ok(src.includes('aria-label="关闭 AI 助手"'), "关闭按钮无 aria-label");
});

/* ── ③ page.tsx 霓虹序列 ── */

test("page.tsx:⌘K 霓虹序列(registerProperty/reduced-motion/连按直开/neon-edge 渲染)", () => {
  const src = readSrc("app/page.tsx");
  // @property 注册 + 容错
  assert.ok(src.includes('"registerProperty" in CSS'), "registerProperty 探测缺失");
  assert.ok(src.includes('"--neon-angle"'), "--neon-angle 注册缺失");
  // reduced-motion 跳过
  assert.ok(src.includes("prefers-reduced-motion: reduce"), "reduced-motion 未探测");
  // 霓虹后开弹窗 + 连按取消直开
  assert.ok(src.includes("setNeonPlaying(true)"), "霓虹未触发");
  assert.ok(src.includes("neonPlaying && <div className=\"neon-edge\""), "neon-edge 未条件渲染");
  assert.ok(/连按不等候/.test(src), "霓虹中连按直开逻辑缺失");
  // 关闭不播霓虹(ref 镜像避免 updater 副作用)
  assert.ok(src.includes("assistantOpenRef"), "开闭态 ref 镜像缺失");
});

/* ── ④ assistant.css 霓虹样式 ── */

test("assistant.css:霓虹扫描 + 环形 mask + 双回退", () => {
  const css = readSrc("app/styles/assistant.css");
  assert.ok(css.includes(".neon-edge"), "neon-edge 样式缺失");
  assert.ok(css.includes("@keyframes neon-edge-sweep"), "扫描 keyframes 缺失");
  assert.ok(css.includes("--neon-angle: 360deg"), "角度未扫满一圈");
  // 环形 mask(-webkit- 兜底 Safari)
  assert.ok(css.includes("-webkit-mask-composite: xor"), "Safari mask 兜底缺失");
  assert.ok(css.includes("mask-composite: exclude"), "标准 mask 缺失");
  // reduced-motion 静态定格 + @supports 回退
  assert.ok(/prefers-reduced-motion[\s\S]*\.neon-edge::before/.test(css), "reduced-motion 回退缺失");
  assert.ok(css.includes("@supports not"), "旧内核静态回退缺失");
  // 关闭按钮样式
  assert.ok(css.includes(".av-overlay-close"), "关闭按钮样式缺失");
});

test("assistant.css:极光配色(多色柔和)——≥3 色彩带、无纯白硬头、双层柔辉光", () => {
  const css = readSrc("app/styles/assistant.css");
  const neon = css.slice(css.indexOf(".neon-edge::before"), css.indexOf("@keyframes neon-edge-sweep"));
  // 多色极光板:琥珀/玫紫/靛/青/翡翠 至少命中 4 色
  const palette = ["#fbbf24", "#e879f9", "#818cf8", "#22d3ee", "#34d399"];
  const hits = palette.filter((c) => neon.includes(c));
  assert.ok(hits.length >= 4, `多色极光配色不足(仅 ${hits.length} 色): ${hits.join(",")}`);
  // 柔和:禁止纯白硬头(单色时代的 #fff 亮头)
  assert.ok(!/#fff\s+\d+deg/.test(neon), "出现纯白硬头色标(应全彩柔和)");
  // 双层柔辉光(非单束刺眼)
  assert.ok((neon.match(/drop-shadow/g) ?? []).length >= 2, "双层柔辉光缺失");
});

test("霓虹节奏与光芒幅度:CSS 扫描时长 = page NEON_MS,且 ≥1000ms 舒缓;辉光宽幅外扩", () => {
  const css = readSrc("app/styles/assistant.css");
  const page = readSrc("app/page.tsx");
  // CSS 动画时长(唯一 neon-edge-sweep animation 行)
  const m = css.match(/animation:\s*neon-edge-sweep\s+(\d+)ms/);
  assert.ok(m, "扫描时长声明缺失");
  const cssMs = Number(m![1]);
  // page 侧 NEON_MS 常量
  const p = page.match(/const NEON_MS = (\d+)/);
  assert.ok(p, "NEON_MS 缺失");
  const pageMs = Number(p![1]);
  assert.equal(cssMs, pageMs, "CSS 扫描时长与 NEON_MS 不同步(弹窗展开时机错位)");
  assert.ok(cssMs >= 1000, `扫描过快(${cssMs}ms < 1000ms),应为舒缓节奏`);
  // 光芒幅度:主弥散辉光 ≥20px + 静息底衬 ≥36px(宽幅光晕,非细线辉光)
  const neon = css.slice(css.indexOf(".neon-edge {"), css.indexOf("@keyframes neon-edge-sweep"));
  const glows = [...neon.matchAll(/(?:drop-shadow\(0 0|box-shadow: inset 0 0) (\d+)px/g)].map((g) => Number(g[1]));
  assert.ok(Math.max(...glows) >= 20, `主辉光幅度不足(最大 ${Math.max(...glows)}px < 20px)`);
  assert.ok(/box-shadow: inset 0 0 (\d+)px/.test(neon) && Number(RegExp.$1) >= 36, "静息底衬光晕未宽幅化");
});

/* ── ⑤ SkillMarketView 检索 ── */

test("SkillMarketView:搜索+范围+R18 三条件客户端过滤", () => {
  const src = readSrc("components/skills/SkillMarketView.tsx");
  assert.ok(src.includes('type="search"'), "搜索框缺失");
  assert.ok(src.includes("SCOPE_CHIPS"), "范围 chips 缺失");
  assert.ok(src.includes("nsfwOnly"), "R18 过滤缺失");
  // 过滤逻辑:名称/描述包含 + 范围包含 + R18
  assert.ok(src.includes("a.applies_to.includes(scope)"), "范围匹配逻辑缺");
  assert.ok(src.includes("if (nsfwOnly && !a.is_nsfw) return false"), "R18 过滤逻辑缺");
  assert.ok(src.includes("skill-filter-empty"), "空结果提示缺失");
});

test("skills.css:检索工具栏样式存在", () => {
  const css = readSrc("app/styles/skills.css");
  assert.ok(css.includes(".skill-toolbar"), "工具栏样式缺失");
  assert.ok(css.includes(".skill-chip"), "chip 样式缺失");
});
