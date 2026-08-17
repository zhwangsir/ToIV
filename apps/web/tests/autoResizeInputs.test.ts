/**
 * 全站输入框去高度限制(2026-08-16 Team B)单测:
 * ① useAutoResize 纯函数:computeAutoHeight / capFromVh / applyAutoHeight(假元素,node 无 DOM)
 * ② hook 全链路:renderHook 驱动 useEffect,手工假 ref({current:{style,scrollHeight,...}})
 *    覆盖受控值变化重算、input 事件兜底(非受控)、unmount 清理监听
 * ③ 源码断言:17 个接线文件均 import+调用 useAutoResize;删除的限制规则不复活
 *    (AssistantView 176px 硬顶/行数估算、AudioView resize:none、PlanPanel 单行 input 等);
 *    stage.css .promptbar-textarea 40vh 封顶(遮盖舞台反向问题修复)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";

import {
  applyAutoHeight,
  capFromVh,
  computeAutoHeight,
  useAutoResize,
} from "../hooks/useAutoResize";
import { flush, renderHook } from "./helpers/renderHook";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/** 假 textarea:仅实现 hook 触达的 style/scrollHeight/监听三件套。 */
function fakeTextarea(scrollHeight: number) {
  const listeners = new Map<string, (() => void)[]>();
  return {
    scrollHeight,
    style: { height: "", overflowY: "" } as Record<string, string>,
    addEventListener(type: string, fn: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    emit(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    listenerCount(type: string) {
      return (listeners.get(type) ?? []).length;
    },
  };
}
type FakeTextarea = ReturnType<typeof fakeTextarea>;
const asEl = (f: FakeTextarea) => f as unknown as HTMLTextAreaElement;

/* ── ① 纯函数 ── */
test("computeAutoHeight:scrollHeight 与 cap 取小;Infinity cap = 不封顶", () => {
  assert.equal(computeAutoHeight(200, 500), 200);
  assert.equal(computeAutoHeight(600, 500), 500);
  assert.equal(computeAutoHeight(600, Number.POSITIVE_INFINITY), 600);
  // 非法 cap 不拦截(返回原始 scrollHeight)
  assert.equal(computeAutoHeight(600, 0), 600);
  assert.equal(computeAutoHeight(600, Number.NaN), 600);
});

test("capFromVh:按视口高换算;缺省/非法输入退化为不封顶", () => {
  assert.equal(capFromVh(40, 1000), 400);
  assert.equal(capFromVh(60, 900), 540);
  assert.equal(capFromVh(undefined, 1000), Number.POSITIVE_INFINITY);
  assert.equal(capFromVh(0, 1000), Number.POSITIVE_INFINITY);
  assert.equal(capFromVh(-5, 1000), Number.POSITIVE_INFINITY);
  assert.equal(capFromVh(40, 0), Number.POSITIVE_INFINITY); // 无视口(node)→ 不封顶
});

test("applyAutoHeight:两段式写高 + overflow 按是否超 cap 切换", () => {
  const el = fakeTextarea(300);
  applyAutoHeight(asEl(el), Number.POSITIVE_INFINITY);
  assert.equal(el.style.height, "300px");
  assert.equal(el.style.overflowY, "hidden");

  const capped = fakeTextarea(800);
  applyAutoHeight(asEl(capped), 400);
  assert.equal(capped.style.height, "400px");
  assert.equal(capped.style.overflowY, "auto");
});

test("applyAutoHeight:scrollHeight=0(未布局/closed details)不动样式", () => {
  const el = fakeTextarea(0);
  applyAutoHeight(asEl(el), Number.POSITIVE_INFINITY);
  assert.equal(el.style.height, "");
  assert.equal(el.style.overflowY, "");
});

/* ── ② hook 全链路(假 ref + renderHook) ── */
test("useAutoResize:挂载即按 scrollHeight 撑开;受控值变化触发重算", async () => {
  const el = fakeTextarea(120);
  const ref = { current: asEl(el) };
  const h = renderHook(() => {
    const [v, setV] = React.useState("一行");
    useAutoResize(ref, v);
    return setV;
  });
  assert.equal(el.style.height, "120px");
  assert.equal(el.style.overflowY, "hidden");

  el.scrollHeight = 260; // 值变长后布局增高
  h.result.current?.("多行\n多行\n多行");
  await flush();
  assert.equal(el.style.height, "260px");
  h.unmount();
});

test("useAutoResize:input 事件兜底(非受控键入);unmount 移除监听", () => {
  const el = fakeTextarea(80);
  const ref = { current: asEl(el) };
  const h = renderHook(() => useAutoResize(ref, "初始"));
  assert.equal(el.listenerCount("input"), 1);

  el.scrollHeight = 180;
  el.emit("input");
  assert.equal(el.style.height, "180px");

  h.unmount();
  assert.equal(el.listenerCount("input"), 0);
});

test("useAutoResize:ref 为空时安全空转", () => {
  const ref = { current: null };
  const h = renderHook(() => useAutoResize(ref, "x"));
  assert.doesNotThrow(() => h.unmount());
});

/* ── ③ 源码断言:接线清单全量 import + 调用 ── */
const WIRED_FILES = [
  "components/assistant/AssistantView.tsx",
  "components/generate/GenerateView.tsx",
  "components/generate/ParamField.tsx",
  "components/generate/PromptBar.tsx",
  "components/drama/workbench/ShotTableRow.tsx",
  "components/drama/workbench/StageAssets.tsx",
  "components/drama/DramaView.tsx",
  "components/studio/stages/ScriptStage.tsx",
  "components/studio/stages/CastStage.tsx",
  "components/studio/ShotCard.tsx",
  "components/animatic/AnimaticView.tsx",
  "components/audio/AudioView.tsx",
  "components/avatartalk/AvatarGenPanel.tsx",
  "components/avatartalk/AvatarTalkView.tsx",
  "components/agent-run/PlanPanel.tsx",
  "components/agent-run/TaskCardList.tsx",
  "components/agent-run/ConfirmGateModal.tsx",
  "components/admin/AgentsAdminView.tsx",
  "app/agent-runs/page.tsx",
];

test("17 个接线文件均 import 并调用 useAutoResize", () => {
  for (const rel of WIRED_FILES) {
    const src = readSrc(rel);
    assert.ok(src.includes('from "@/hooks/useAutoResize"'), `${rel} 未导入 useAutoResize`);
    assert.ok(/useAutoResize\(/.test(src), `${rel} 未调用 useAutoResize`);
  }
});

test("AssistantView:176px 硬顶与行数估算逻辑已删除", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(!src.includes("max-height: 176px"), "styled-jsx 仍残留 176px 硬顶");
  assert.ok(!src.includes("textareaRows"), "行数估算 state 残留");
  assert.ok(!src.includes("resize: none"), "composer resize:none 残留");
  assert.ok(
    src.includes("useAutoResize(textareaRef, input, { maxVh: 40 })"),
    "composer 未按 40vh 接 hook",
  );
});

test("AudioView:情感描述 resize:none 已放行,min-height:36px 下限保留", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  assert.ok(!src.includes("resize: none"), "audio-oneline-input resize:none 残留");
  assert.ok(src.includes("min-height: 36px"), "单行下限被误删");
});

test("PlanPanel:打回反馈已升级 textarea;列表文案走 PlanTextarea 包装", () => {
  const src = readSrc("components/agent-run/PlanPanel.tsx");
  assert.ok(
    !/<input[^>]*agent-plan-feedback/.test(src),
    "打回反馈仍是单行 input",
  );
  assert.ok(
    /<textarea[\s\S]*?className="input agent-plan-feedback"/.test(src),
    "打回反馈 textarea 缺失",
  );
  assert.ok(src.includes("function PlanTextarea"), "列表映射包装组件缺失");
});

test("PromptBar 遮盖舞台修复:hook 40vh + stage.css max-height:40vh", () => {
  const bar = readSrc("components/generate/PromptBar.tsx");
  assert.ok(
    bar.includes("useAutoResize(taRef, value, { maxVh: 40 })"),
    "PromptBar 未按 40vh 接 hook",
  );
  assert.ok(!bar.includes("ta.scrollHeight"), "旧内联两段式实现残留");

  const css = readSrc("app/styles/stage.css");
  const block = css.match(/\.promptbar-textarea \{[^}]*\}/);
  assert.ok(block, "stage.css 缺 .promptbar-textarea 规则块");
  assert.ok(block[0].includes("max-height: 40vh"), ".promptbar-textarea 未 40vh 封顶");
  assert.ok(!block[0].includes("max-height: none"), ".promptbar-textarea 仍无限高(遮盖舞台)");
});

test("布局受困处宽松上限:DramaView 侧栏 40vh、AgentsAdminView System Prompt 60vh", () => {
  assert.ok(
    readSrc("components/drama/DramaView.tsx").includes("{ maxVh: 40 }"),
    "DramaView 梗概未设 40vh(侧栏 100vh 定高链裁切风险)",
  );
  assert.ok(
    readSrc("components/admin/AgentsAdminView.tsx").includes("{ maxVh: 60 }"),
    "AgentsAdminView System Prompt 未设 60vh",
  );
});

test("ui/Textarea 基座支持 ref(React 19 ref-as-prop),供 hook 取节点", () => {
  const src = readSrc("components/ui/Input.tsx");
  assert.ok(/ref\?: Ref<HTMLTextAreaElement>/.test(src), "TextareaProps 未声明 ref");
  assert.ok(/function Textarea\(\{ className, ref, \.\.\.rest \}/.test(src), "Textarea 未透传 ref");
});

test("CastStage 非受控角色卡走 CastTextarea 包装(初始撑开 + input 兜底)", () => {
  const src = readSrc("components/studio/stages/CastStage.tsx");
  assert.ok(src.includes("function CastTextarea"), "CastTextarea 包装缺失");
  assert.ok(!/<textarea\n\s+className="input"\n\s+rows=\{2\}\n\s+defaultValue/.test(src), "仍有未包装的裸 textarea");
});
