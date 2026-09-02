/**
 * 应用运行页双模式(2026-09-02,简洁/工作流)防回归:
 * ① normalizeApp 新增 bindings/workflow_json 归一(非法项剔除)
 * ② orderWorkflowNodes 拓扑排序(链式/环回退)
 * ③ bindingsByNode 分组
 * ④ AppRunnerView 双模式段控接线(源码断言)
 * ⑤ AppWorkflowGraph 静态渲染(节点卡/绑定内联/连线行/空态)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  bindingsByNode,
  normalizeApp,
  orderWorkflowNodes,
  type AppItem,
  type AppWorkflowNode,
} from "../lib/apps";
import { AppWorkflowGraph } from "../components/apps/AppWorkflowGraph";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

const WF: Record<string, AppWorkflowNode> = {
  "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
  "2": { class_type: "CLIPTextEncode", _meta: { title: "正向提示词" }, inputs: { text: "默认" } },
  "3": { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["2", 0], seed: 42 } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
};

test("normalizeApp:bindings/workflow_json 归一,非法项剔除", () => {
  const app = normalizeApp({
    id: "a1",
    name: "测试",
    bindings: {
      prompt: { node: "2", field: "inputs.text" },
      bad: { node: 1 },
      junk: "x",
    },
    workflow_json: { ...WF, ghost: { no_class: true } },
  });
  assert.deepEqual(app.bindings, { prompt: { node: "2", field: "inputs.text" } });
  assert.ok(app.workflow_json);
  assert.equal(Object.keys(app.workflow_json).length, 4, "缺 class_type 的节点剔除");
  assert.equal(app.workflow_json["2"].title, "正向提示词", "_meta.title 透出");
});

test("normalizeApp:无 workflow_json → null(列表形态兼容)", () => {
  assert.equal(normalizeApp({ id: "x" }).workflow_json, null);
  assert.deepEqual(normalizeApp({ id: "x" }).bindings, {});
});

test("orderWorkflowNodes:依赖边拓扑序(被依赖者先)", () => {
  const order = orderWorkflowNodes(WF);
  const pos = (id: string) => order.indexOf(id);
  assert.ok(pos("4") < pos("3"), "CheckpointLoader 应在 KSampler 前");
  assert.ok(pos("2") < pos("3"), "CLIPTextEncode 应在 KSampler 前");
  assert.equal(order.length, 4);
});

test("orderWorkflowNodes:环回退原 key 序,节点不丢", () => {
  const cyc: Record<string, AppWorkflowNode> = {
    a: { class_type: "X", inputs: { i: ["b", 0] } },
    b: { class_type: "Y", inputs: { i: ["a", 0] } },
  };
  assert.deepEqual(orderWorkflowNodes(cyc), ["a", "b"]);
});

test("bindingsByNode:按节点分组", () => {
  const m = bindingsByNode({
    prompt: { node: "2", field: "inputs.text" },
    seed: { node: "3", field: "inputs.seed" },
    steps: { node: "3", field: "inputs.steps" },
  });
  assert.equal(m.get("3")?.length, 2);
  assert.equal(m.get("2")?.[0].key, "prompt");
});

test("AppRunnerView:双模式段控 + 工作流组件接线(源码断言)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes('["simple", "简洁"]') && src.includes('["workflow", "工作流"]'), "缺双模式段控");
  assert.ok(src.includes("AppWorkflowGraph"), "未接工作流组件");
  assert.ok(src.includes('role="tablist"'), "段控缺 tablist 语义");
});

test("AppWorkflowGraph:节点卡拓扑渲染 + 绑定内联 + 连线行", () => {
  const app = normalizeApp({
    id: "a1",
    name: "文生图",
    params_schema: [{ key: "prompt", label: "提示词", type: "textarea" }],
    bindings: { prompt: { node: "2", field: "inputs.text" } },
    workflow_json: WF,
  }) satisfies AppItem;
  const html = renderToStaticMarkup(
    h(AppWorkflowGraph, { app, values: { prompt: "猫" }, onParamChange: () => {} }),
  );
  // 四节点全渲染,拓扑序:#4 在 #3 前
  assert.ok((html.match(/wf-node-id/g) ?? []).length === 4, "节点数不符");
  assert.ok(html.indexOf("#4") < html.indexOf("#3"), "拓扑序不符");
  // 绑定节点:is-bound + 可调徽标 + 内联 ParamField(textarea)
  assert.ok(html.includes("is-bound"), "绑定节点未高亮");
  assert.ok(html.includes("可调"), "缺可调徽标");
  assert.ok(html.includes("<textarea"), "绑定参数未内联渲染 ParamField");
  // 连线行:KSampler 的 model ← #4
  assert.ok(html.includes("← #4"), "连线未渲染");
  // 绑定叶子不在只读区重复(节点2 的 text 被绑定,只读区不应再出现 text:)
  assert.ok(!/wf-io-name">text</.test(html), "绑定叶子在只读区重复展示");
});

test("AppWorkflowGraph:无工作流兜底文案", () => {
  const app = normalizeApp({ id: "a2", name: "空" });
  const html = renderToStaticMarkup(
    h(AppWorkflowGraph, { app, values: {}, onParamChange: () => {} }),
  );
  assert.ok(html.includes("wf-empty"), "缺空态兜底");
});
