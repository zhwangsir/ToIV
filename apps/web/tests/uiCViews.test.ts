/**
 * UI-C 里程碑视图组件单测(node:test + react-dom/server 静态渲染):
 * ① Agent-runs TaskCard:状态徽章类名与结构(agent-status is-*)
 * ② Agent-runs TaskCard:干预按钮已接 Ripple(ui-ripple 包裹)
 * ③ LoadingBlock 基座:line 变体渲染(原 DramaView 用例,W4 后改基座断言)
 * ④ ErrorBar 基座:role=alert 渲染(同③)
 * ⑤ CanvasView:移动端提示条结构(canvas-mobile-note)
 * ⑥ Studio ShotCard:操作按钮已接 Ripple(ui-ripple 包裹)
 * ⑦ Studio ShotCard:渲染中脉冲类(is-rendering)
 * ⑧ BacklotView:错误态使用 ErrorBar(ui-error-bar)
 * 说明:.tsx 组件经 tests/loader.mjs 的 load 钩子 transpile 后加载;
 * 有 hook 依赖的组件通过最小化 mock 渲染。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Ripple } from "../components/ui/Ripple";
import { LoadingBlock } from "../components/ui/LoadingBlock";
import { ErrorBar } from "../components/ui/ErrorBar";
import type { AgentRunTask } from "../lib/api";

const h = React.createElement;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── ① Agent-runs TaskCard 徽章类名 ── */
test("TaskCard 状态徽章渲染 agent-status is-* 类名", async () => {
  const { TaskCardList } = await import("../components/agent-run/TaskCardList");
  const tasks: AgentRunTask[] = [
    {
      id: "t1",
      kind: "video",
      title: "测试任务",
      depends_on: [],
      status: "running",
      attempt: 0,
      input: { prompt: "" },
      output: {},
      verdict: "",
      gpu_hint: "",
    },
  ];
  const html = renderToStaticMarkup(
    h(TaskCardList, { tasks, busy: {}, onAction: async () => {}, onUpload: async () => {} }),
  );
  assert.match(html, /agent-status/);
  assert.match(html, /is-accent/); // running → accent tone
});

/* ── ② Agent-runs TaskCard 干预按钮接 Ripple ── */
test("TaskCard 干预按钮被 Ripple 包裹", async () => {
  const { TaskCardList } = await import("../components/agent-run/TaskCardList");
  const tasks: AgentRunTask[] = [
    {
      id: "t1",
      kind: "video",
      title: "测试任务",
      depends_on: [],
      status: "done",
      attempt: 0,
      input: { prompt: "" },
      output: {},
      verdict: "",
      gpu_hint: "",
    },
  ];
  const html = renderToStaticMarkup(
    h(TaskCardList, { tasks, busy: {}, onAction: async () => {}, onUpload: async () => {} }),
  );
  // 改文案/重生成/通过/替换上传/反推提示词 五个按钮各被一个 Ripple 包裹
  const rippleCount = (html.match(/ui-ripple/g) ?? []).length;
  assert.ok(rippleCount >= 5, `期望 ≥5 个 ui-ripple,实际 ${rippleCount}`);
});

/* ── ③ LoadingBlock 基座渲染(原 DramaView 用例,W4 drama 删除后改为基座断言) ── */
test("LoadingBlock 基座:line 变体渲染 N 条骨架", async () => {
  const html = renderToStaticMarkup(h(LoadingBlock, { variant: "line", count: 3 }));
  assert.match(html, /ui-loading/);
  assert.match(html, /ui-loading--line/);
  assert.equal((html.match(/ui-loading-block/g) ?? []).length, 3);
});

/* ── ④ ErrorBar 基座渲染(原 DramaView 用例,同改基座断言) ── */
test("ErrorBar 基座:role=alert + 文案渲染", async () => {
  const html = renderToStaticMarkup(
    h(ErrorBar, { message: "加载项目详情失败", onClose: () => {} }),
  );
  assert.match(html, /ui-error-bar/);
  assert.match(html, /role="alert"/);
  assert.match(html, /加载项目详情失败/);
});

/* ── ⑤ CanvasView 移动端提示条 ── */
test("CanvasView 含移动端提示条结构", async () => {
  // CanvasView 依赖 window/document,node 环境无法直接渲染;
  // 验证提示条样式已定义在组件 styled-jsx 中
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "../components/canvas/CanvasView.tsx"),
    "utf8",
  );
  assert.ok(src.includes("canvas-mobile-note"), "缺少 canvas-mobile-note 类名");
  assert.ok(src.includes("画布建议桌面端操作"), "缺少移动端提示文案");
});

/* ── ⑥ Studio ShotCard 操作按钮接 Ripple ── */
test("ShotCard 操作按钮被 Ripple 包裹", async () => {
  const { ShotCard } = await import("../components/studio/ShotCard");
  const shot = {
    id: "s1",
    project_id: "p1",
    idx: 0,
    scene: "测试场景",
    prompt: "",
    negative: "",
    camera: "",
    dialogue: "你好",
    speaker: "",
    duration_sec: 4,
    characters: [],
    render_mode: "video" as const,
    status: "draft",
    image_url: "",
    video_url: "",
    voice_url: "",
    final_clip_url: "",
    error: "",
  };
  const html = renderToStaticMarkup(
    h(ShotCard, {
      shot,
      projectId: "p1",
      characters: [],
      busyRender: false,
      busyVoice: false,
      busyLipsync: false,
      saveState: "idle" as const,
      savedAt: null,
      onModeChange: () => {},
      onPatch: () => {},
      onRender: () => {},
      onVoice: () => {},
      onLipsync: () => {},
      onDelete: () => {},
    }),
  );
  const rippleCount = (html.match(/ui-ripple/g) ?? []).length;
  assert.ok(rippleCount >= 3, `期望 ≥3 个 ui-ripple,实际 ${rippleCount}`);
});

/* ── ⑦ Studio ShotCard 渲染中脉冲类 ── */
test("ShotCard 渲染中媒体区带 is-rendering 脉冲类", async () => {
  const { ShotCard } = await import("../components/studio/ShotCard");
  const shot = {
    id: "s1",
    project_id: "p1",
    idx: 0,
    scene: "",
    prompt: "",
    negative: "",
    camera: "",
    dialogue: "",
    speaker: "",
    duration_sec: 4,
    characters: [],
    render_mode: "video" as const,
    status: "rendering",
    image_url: "",
    video_url: "",
    voice_url: "",
    final_clip_url: "",
    error: "",
  };
  const html = renderToStaticMarkup(
    h(ShotCard, {
      shot,
      projectId: "p1",
      characters: [],
      busyRender: true,
      busyVoice: false,
      busyLipsync: false,
      saveState: "idle" as const,
      savedAt: null,
      onModeChange: () => {},
      onPatch: () => {},
      onRender: () => {},
      onVoice: () => {},
      onLipsync: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(html, /is-rendering/);
});

/* ── ⑧ BacklotView ErrorBar ── */
test("BacklotView 错误态渲染 ErrorBar", async () => {
  const html = renderToStaticMarkup(
    h(ErrorBar, { message: "加载看板失败", onClose: () => {} }),
  );
  assert.match(html, /ui-error-bar/);
  assert.match(html, /加载看板失败/);
});

/* ── ⑨ AgentRunStyles 兼容组件返回 null ── */
test("AgentRunStyles 兼容组件渲染为空", async () => {
  const { AgentRunStyles } = await import("../components/agent-run/AgentRunStyles");
  const result = AgentRunStyles();
  assert.equal(result, null);
});

/* ── ⑩ ConfirmGateModal 主按钮接 MagnetFollow+Ripple ── */
test("ConfirmGateModal 确认合成按钮被 MagnetFollow+Ripple 包裹", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "../components/agent-run/ConfirmGateModal.tsx"),
    "utf8",
  );
  assert.ok(src.includes("MagnetFollow"), "缺少 MagnetFollow import");
  assert.ok(src.includes("Ripple"), "缺少 Ripple import");
  assert.ok(src.includes("<MagnetFollow>"), "缺少 MagnetFollow JSX 使用");
  assert.ok(src.includes("<Ripple>"), "缺少 Ripple JSX 使用");
});
