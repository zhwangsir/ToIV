/**
 * 2026-08-24 AI 助手启动序列重做 源码断言:
 * ① page.tsx 设计参数表:NEON_MS=1000 / NEON_SWEEP_DEG=430 / NEON_CORE_MS=350 /
 *   NEON_PANEL_LEAD_MS=300,双定时器阶段协调(弹窗收尾前 300ms 起播)
 * ② 阶段一核点:neon-core 真实子节点渲染 + rAF 内联驱动(--core-sweep/scale/opacity)
 * ③ 跳过/reduced-motion 分支保留:连按直开、canNeon 门控
 * ④ assistant.css:弹窗 400ms cubic-bezier(.22,1,.36,1) + backdrop blur 0→12px +
 *   关闭 200ms ease-in(scale→.96) + 辉光 600ms 衰减到稳态
 * ⑤ 加载态「核心启动」:av-boot 呼吸小核 1.6s + 状态文字
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(import.meta.dirname, "..");
const readSrc = (p: string) => readFileSync(join(root, p), "utf8");

/* ── ① page.tsx 设计参数表 ── */

test("page.tsx:启动序列设计参数表(扫边 1000ms/430deg,核点 350ms,弹窗提前 300ms)", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(src.includes("const NEON_MS = 1000"), "NEON_MS 未提速到 1000ms");
  assert.ok(src.includes("const NEON_SWEEP_DEG = 430"), "NEON_SWEEP_DEG 应为 430deg");
  assert.ok(src.includes("const NEON_CORE_MS = 350"), "NEON_CORE_MS 缺失(阶段一 350ms)");
  assert.ok(
    src.includes("const NEON_PANEL_LEAD_MS = 300"),
    "NEON_PANEL_LEAD_MS 缺失(弹窗收尾前 300ms 起播)",
  );
  // 参数表注释落在文件顶部常量区
  assert.ok(src.includes("设计参数表"), "设计参数表注释缺失");
});

test("page.tsx:双定时器阶段协调(弹窗 700ms 起播 + 灯带 1000ms 收尾)", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(src.includes("openTimer") && src.includes("doneTimer"), "双定时器缺失");
  // 弹窗起播时机 = 扫边总时长 - 提前量(700ms),与灯带余光交叠
  assert.ok(
    src.includes("NEON_MS - NEON_PANEL_LEAD_MS"),
    "弹窗起播未按收尾提前量协调",
  );
});

/* ── ② 阶段一核点 ── */

test("page.tsx:阶段一核点(真实子节点 + 同 rAF 内联驱动)", () => {
  const src = readSrc("app/page.tsx");
  // 伪元素在本页层叠树下不重绘(2026-08-23 实证),核点用真实子节点
  assert.ok(src.includes('className="neon-core"'), "neon-core 未渲染");
  assert.ok(src.includes('className="neon-core-arc"'), "雷达弧子节点缺失");
  assert.ok(src.includes('className="neon-core-dot"'), "核点子节点缺失");
  assert.ok(src.includes("coreRef"), "核点 ref 缺失");
  // 同一 rAF 内联驱动:扫描角(registerProperty 注册)+ 脉冲缩放 + 淡出
  assert.ok(src.includes('"--core-sweep"'), "--core-sweep 注册缺失");
  assert.ok(src.includes('core.style.setProperty("--core-sweep"'), "雷达弧角度未内联驱动");
  assert.ok(src.includes("core.style.transform = `scale("), "核点脉冲缩放未驱动");
  assert.ok(src.includes("core.style.opacity"), "核点淡出未驱动");
});

/* ── ③ 跳过 / reduced-motion 分支保留 ── */

test("page.tsx:连按跳过 + reduced-motion 直开分支保留", () => {
  const src = readSrc("app/page.tsx");
  // 序列进行中再按:清双定时器 + 直开(连按不等候)
  assert.ok(src.includes("if (openTimer || doneTimer)"), "连按跳过判定缺失");
  assert.ok(/连按不等候/.test(src), "连按直开逻辑缺失");
  // reduced-motion / 无 registerProperty:canNeon=false → 直接 setAssistantOpen(true)
  assert.ok(src.includes("prefers-reduced-motion: reduce"), "reduced-motion 探测缺失");
  assert.ok(src.includes('"registerProperty" in CSS'), "registerProperty 探测缺失");
});

/* ── ④ assistant.css 弹窗/关闭/辉光 ── */

test("assistant.css:阶段三弹窗降临(400ms easeOutExpo 感 + blur 0→12px)", () => {
  const css = readSrc("app/styles/assistant.css");
  // 面板:keyframes 从 scale(.92) 起播,400ms cubic-bezier(.22,1,.36,1)
  assert.ok(css.includes("@keyframes av-panel-in"), "弹窗降临 keyframes 缺失");
  assert.ok(
    css.includes("animation: av-panel-in 400ms cubic-bezier(0.22, 1, 0.36, 1)"),
    "弹窗 400ms cubic-bezier(.22,1,.36,1) 缺失",
  );
  const panelIn = css.slice(css.indexOf("@keyframes av-panel-in"));
  assert.ok(panelIn.includes("transform: scale(0.92)"), "入场起点 scale(.92) 缺失");
  // backdrop blur 0→12px 渐入
  assert.ok(css.includes("backdrop-filter: blur(0)"), "backdrop 起始 blur(0) 缺失");
  assert.ok(css.includes("backdrop-filter: blur(12px)"), "backdrop 目标 blur(12px) 缺失");
});

test("assistant.css:关闭动画 200ms ease-in(scale→.96 + 淡出,常驻挂载方向性 transition)", () => {
  const css = readSrc("app/styles/assistant.css");
  // 容器:200ms 淡出 + visibility 延迟到动画播完(无 closing 态延时卸载)
  assert.ok(
    css.includes("transition: opacity 200ms ease-in, visibility 0s linear 200ms"),
    "浮层关闭 200ms 过渡缺失",
  );
  // 面板关闭落点:scale(.96) + opacity 0,200ms ease-in
  const panelStart = css.indexOf(".av-overlay-panel {");
  const panel = css.slice(panelStart, css.indexOf("}", panelStart));
  assert.ok(panel.includes("transform: scale(0.96)"), "关闭落点 scale(.96) 缺失");
  assert.ok(panel.includes("opacity: 0"), "关闭落点淡出缺失");
  assert.ok(
    panel.includes("transition: transform 200ms ease-in, opacity 200ms ease-in"),
    "面板关闭 200ms ease-in 过渡缺失",
  );
});

test("assistant.css:开场辉光 600ms 衰减到稳态微光(forwards 不归零)", () => {
  const css = readSrc("app/styles/assistant.css");
  assert.ok(
    css.includes("animation: av-panel-aura 600ms"),
    "辉光 600ms 时长缺失",
  );
  const aura = css.slice(css.indexOf("@keyframes av-panel-aura"));
  assert.ok(/opacity:\s*0\.[1-9]/.test(aura), "辉光应衰减到稳态微光(不归零)");
});

test("assistant.css:reduced-motion 新动画全停(弹窗/辉光/呼吸)", () => {
  const css = readSrc("app/styles/assistant.css");
  // 弹窗降临 keyframes 停(reduced-motion 块内的 animation: none 覆盖)
  assert.ok(
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.av-overlay\.is-open \.av-overlay-panel \{\s*animation: none;/.test(
      css,
    ),
    "reduced-motion 未停弹窗降临动画",
  );
  // 加载态呼吸/文字淡入停
  assert.ok(
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.av-boot-core,[\s\S]*animation: none;/.test(css),
    "reduced-motion 未覆盖加载态呼吸",
  );
});

test("assistant.css:动画参数总表注释落位文件顶部", () => {
  const css = readSrc("app/styles/assistant.css");
  const head = css.slice(0, 900);
  assert.ok(head.includes("动画参数总表"), "参数总表注释缺失");
  assert.ok(head.includes("1000ms") && head.includes("350ms"), "扫边/核点参数未入表");
  assert.ok(head.includes("400ms") && head.includes("200ms"), "弹窗/关闭参数未入表");
  assert.ok(head.includes("1.6s"), "呼吸参数未入表");
});

/* ── ⑤ 加载态「核心启动」 ── */

test("AssistantOverlay:Suspense fallback 换「核心启动」(呼吸小核 + 状态文字)", () => {
  const src = readSrc("components/assistant/AssistantOverlay.tsx");
  assert.ok(src.includes('className="av-boot"'), "av-boot 容器缺失");
  assert.ok(src.includes('className="av-boot-core"'), "呼吸小核缺失");
  assert.ok(src.includes("正在接入引擎矩阵…"), "状态文字缺失");
  assert.ok(src.includes("fallback={<AssistantBoot />}"), "fallback 未接 AssistantBoot");
  // 旧 LoadingBlock 线条 fallback 已退役
  assert.ok(!src.includes("av-overlay-loading"), "旧线条 fallback 残留");
});

test("assistant.css:加载态呼吸 1.6s ease-in-out infinite(scale 1↔1.15)", () => {
  const css = readSrc("app/styles/assistant.css");
  assert.ok(
    css.includes("animation: av-boot-breathe 1.6s ease-in-out infinite"),
    "呼吸 1.6s 循环缺失",
  );
  const breathe = css.slice(css.indexOf("@keyframes av-boot-breathe"));
  assert.ok(breathe.includes("transform: scale(1.15)"), "呼吸幅度 1.15 缺失");
});
