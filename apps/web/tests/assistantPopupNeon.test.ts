/**
 * RES2-2026-08-18 前端弹窗化/霓虹动画/Skill 检索 源码断言:
 * ① AssistantView popup 形态:仅对话区+输入框(页头/三面板/文档按钮/门户空态隐藏)
 * ② AssistantOverlay:variant="popup" 传递 + 最小关闭按钮
 * ③ page.tsx Shift+Enter 霓虹序列:registerProperty 注册 / reduced-motion 跳过 / neon-edge 渲染
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

test("page.tsx:Shift+Enter 霓虹序列(registerProperty/reduced-motion/连按直开/neon-edge 渲染)", () => {
  const src = readSrc("app/page.tsx");
  // @property 注册 + 容错
  assert.ok(src.includes('"registerProperty" in CSS'), "registerProperty 探测缺失");
  assert.ok(src.includes('"--neon-angle"'), "--neon-angle 注册缺失");
  // reduced-motion 跳过
  assert.ok(src.includes("prefers-reduced-motion: reduce"), "reduced-motion 未探测");
  // 霓虹后开弹窗 + 连按取消直开
  assert.ok(src.includes("setNeonPlaying(true)"), "霓虹未触发");
  assert.ok(/neonPlaying && \([\s\S]*className="neon-edge"/.test(src), "neon-edge 未条件渲染");
  assert.ok(/连按不等候/.test(src), "霓虹中连按直开逻辑缺失");
  // 关闭不播霓虹(ref 镜像避免 updater 副作用)
  assert.ok(src.includes("assistantOpenRef"), "开闭态 ref 镜像缺失");
});

test("page.tsx:霓虹 rAF 驱动(2026-08-23 重写:CSS 自定义属性动画在本页层叠树下不重绘)", () => {
  const src = readSrc("app/page.tsx");
  // rAF 逐帧写内联 --neon-angle(内联 style 更新走 style recalc,每帧必重绘)
  assert.ok(src.includes("requestAnimationFrame"), "rAF 驱动缺失");
  assert.ok(src.includes('el.style.setProperty("--neon-angle"'), "内联角度写入缺失");
  // 首尾淡入淡出(不戛然而止)+ 扫满一圈后过冲收尾
  assert.ok(src.includes("el.style.opacity"), "淡出写入缺失");
  const sweep = src.match(/const NEON_SWEEP_DEG = (\d+)/);
  assert.ok(sweep && Number(sweep[1]) > 360, "收尾未过冲(应 >360deg 让软尾滑过终点)");
  // 单常量 NEON_MS 同时驱动 rAF 与开弹窗计时(时机不错位)
  const ms = src.match(/const NEON_MS = (\d+)/);
  assert.ok(ms && Number(ms[1]) >= 1000, "NEON_MS 缺失或过快(应 ≥1000ms 舒缓)");
});

test("page.tsx:Shift+Enter 触发键语义(纯 Shift+Enter + 输入上下文守卫)", () => {
  const src = readSrc("app/page.tsx");
  // 仅 Shift+Enter:Enter 键 + shiftKey,排除 Cmd/Ctrl/Alt(不碰 ⌘Enter 提交类快捷键)
  assert.ok(
    src.includes('e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey'),
    "纯 Shift+Enter 判定缺失",
  );
  // 焦点在 input/textarea/select/contenteditable 时不触发(保留输入框换行)
  assert.ok(src.includes('target.tagName === "INPUT"'), "input 守卫缺失");
  assert.ok(src.includes('target.tagName === "TEXTAREA"'), "textarea 守卫缺失");
  assert.ok(src.includes("target.isContentEditable"), "contenteditable 守卫缺失");
  // 可发现性提示文案同步(旧 ⌘K 提示键位已更换)
  assert.ok(src.includes("toiv_hint_shiftenter"), "首访提示 localStorage 键未更换");
  assert.ok(src.includes("Shift+Enter 随时唤起对话"), "首访提示文案未同步");
});

/* ── ④ assistant.css 霓虹样式 ── */

test("assistant.css:霓虹环带 + 环形 mask + 双回退", () => {
  const css = readSrc("app/styles/assistant.css");
  assert.ok(css.includes(".neon-edge"), "neon-edge 样式缺失");
  // 彗核直接画在 .neon-edge 本体(伪元素承载在本页层叠树下不重绘)
  assert.ok(/\.neon-edge \{[^}]*conic-gradient/.test(css), "彗核未画在真实元素上");
  // 动画由 JS rAF 驱动:CSS 侧不得残留 keyframes 扫描动画(实证不重绘)
  assert.ok(!/\.neon-edge \{[^}]*animation:/.test(css), "neon-edge 不得使用 CSS 动画(用 rAF)");
  // 环形 mask(-webkit- 兜底 Safari)
  assert.ok(css.includes("-webkit-mask-composite: xor"), "Safari mask 兜底缺失");
  assert.ok(css.includes("mask-composite: exclude"), "标准 mask 缺失");
  // reduced-motion 静态定格 + @supports 回退
  assert.ok(/prefers-reduced-motion[\s\S]*\.neon-edge \{/.test(css), "reduced-motion 回退缺失");
  assert.ok(css.includes("@supports not"), "旧内核静态回退缺失");
  // 关闭按钮样式
  assert.ok(css.includes(".av-overlay-close"), "关闭按钮样式缺失");
});

test("assistant.css:极光配色(2026-08-24 品牌双色 cyan→violet)——无品红残留、无纯白硬头、三层柔辉光", () => {
  const css = readSrc("app/styles/assistant.css");
  const neonStart = css.indexOf(".neon-edge {");
  const neon = css.slice(neonStart, css.indexOf("@supports not", neonStart));
  // 品牌极光双色板:cyan #22d3ee → violet #a78bfa
  assert.ok(neon.includes("#22d3ee"), "品牌 cyan #22d3ee 缺失");
  assert.ok(neon.includes("#a78bfa"), "品牌 violet #a78bfa 缺失");
  // 双色升级:旧三色板的品红/浅青不得残留
  assert.ok(!neon.includes("#f0abfc"), "品红 #f0abfc 残留(已收敛为双色)");
  assert.ok(!neon.includes("#67e8f9"), "浅青 #67e8f9 残留(已升级为品牌 cyan)");
  // 柔和:禁止纯白硬头(单色时代的 #fff 亮头)
  assert.ok(!/#fff\s+\d+deg/.test(neon), "出现纯白硬头色标(应全彩柔和)");
  // 三层柔辉光(贴核/中层/远景弥散),最大 ≥40px 宽幅外扩
  assert.ok((neon.match(/drop-shadow/g) ?? []).length >= 3, "三层柔辉光缺失");
  const glows = [...neon.matchAll(/drop-shadow\(0 0 (\d+)px/g)].map((g) => Number(g[1]));
  assert.ok(Math.max(...glows) >= 40, `主辉光幅度不足(最大 ${Math.max(...glows)}px < 40px)`);
});

test("assistant.css:静态双色底环 + 弹窗玻璃拟态 + 开场辉光", () => {
  const css = readSrc("app/styles/assistant.css");
  const neonStart = css.indexOf(".neon-edge {");
  const neon = css.slice(neonStart, css.indexOf("@supports not", neonStart));
  // 双层背景:彗核(随 --neon-angle 旋转)+ 静态双色整环(任意时刻四边有色彩)
  assert.ok((neon.match(/conic-gradient/g) ?? []).length >= 2, "静态双色底环缺失");
  // 弹窗玻璃拟态 + 开场光晕(灯带联动收束拍)
  assert.ok(css.includes("backdrop-filter: var(--glass-blur)"), "面板玻璃模糊缺失");
  assert.ok(css.includes("background: var(--glass-bg)"), "面板玻璃底色缺失");
  assert.ok(css.includes("@keyframes av-panel-aura"), "开场光晕 keyframes 缺失");
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
