/**
 * 应用工作流/画布打开防回归(2026-09-07:运行台去简洁/工作流段控,导航 view=canvas):
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
import { AppWorkflowGraph, layoutWorkflow } from "../components/apps/AppWorkflowGraph";

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

test("normalizeApp:列表绑定取首个合法槽(images 扇出)", () => {
  const app = normalizeApp({
    id: "r2v",
    name: "多参考",
    bindings: {
      images: [
        { node: "110", field: "inputs.image" },
        { node: "111", field: "inputs.image" },
      ],
      bad: [{ node: 1 }, { node: "112", field: "inputs.image" }],
    },
  });
  assert.deepEqual(app.bindings, {
    images: { node: "110", field: "inputs.image" },
    bad: { node: "112", field: "inputs.image" },
  });
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

test("AppRunnerView:RH 运行台无简洁/工作流段控;画布编辑走 open-in-Comfy(源码断言)", () => {
  const src = readSrc("components/apps/AppRunnerView.tsx");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!code.includes('"simple", "简洁"'), "不应再有简洁段控");
  assert.ok(!code.includes('"workflow", "工作流"'), "不应再有工作流段控");
  assert.ok(!code.includes("AppWorkflowGraph"), "运行台不应内嵌 AppWorkflowGraph");
  assert.ok(code.includes("在画布中编辑"), "运行台应有「在画布中编辑」入口");
  assert.ok(code.includes("openAppWorkflowInComfy"), "应接线 open-in-Comfy");
  assert.ok(code.includes("RhPanelTabs") || code.includes("应用详情"), "应保留 RH 右栏 tabs");
});

test("layoutWorkflow:分层成列 + 连线提取 + 端口坐标", () => {
  const layout = layoutWorkflow(WF, { prompt: { node: "2", field: "inputs.text" } });
  const box = (id: string) => layout.boxes.find((b) => b.id === id)!;
  // 分层:4(无依赖)与 1 在第 0 列;3(依赖 4/2)列序严格大于二者
  assert.equal(box("4").x, 0);
  assert.equal(box("1").x, 0);
  assert.ok(box("3").x > box("4").x, "KSampler 应在依赖列右侧");
  assert.ok(box("3").x > box("2").x, "KSampler 应在提示词列右侧");
  // 连线:model←4、positive←2 两条
  assert.equal(layout.edges.length, 2);
  assert.ok(layout.edges.some((e) => e.from === "4" && e.to === "3" && e.toInput === "model"));
  // 端口:绑定行(text)汇入头部;只读行(image)有行内 y
  assert.ok(box("2").inPortY.text < 30, "绑定输入端口汇入头部");
  assert.ok(box("1").inPortY.image >= 30, "只读输入端口在头部之下");
  // 画布尺寸为正
  assert.ok(layout.width > 0 && layout.height > 0);
});

test("layoutWorkflow:环不炸,节点不丢", () => {
  const cyc: Record<string, AppWorkflowNode> = {
    a: { class_type: "X", inputs: { i: ["b", 0] } },
    b: { class_type: "Y", inputs: { i: ["a", 0] } },
  };
  const layout = layoutWorkflow(cyc, {});
  assert.equal(layout.boxes.length, 2);
});

test("AppWorkflowGraph:画布渲染——节点卡 + SVG 连线 + 工具栏 + 绑定内联", () => {
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
  // 画布骨架
  assert.ok(html.includes("wf-canvas"), "缺画布容器");
  assert.ok(html.includes("wf-canvas-edges"), "缺 SVG 连线层");
  assert.ok(html.includes("适配全图"), "缺工具栏");
  // 四节点全渲染,绝对定位(left/top style)
  assert.equal((html.match(/wf-node-id/g) ?? []).length, 4, "节点数不符");
  assert.ok(html.includes("left:"), "节点未绝对定位");
  // 连线:两条 wf-edge(图标 SVG 的 <path> 不计)
  // 注:is-bound 连线仅当「链接落到绑定输入」(reroute 形态)才出现,本夹具绑定标量输入故不断言
  assert.equal((html.match(/class="wf-edge/g) ?? []).length, 2, "连线数不符");
  // 绑定节点:is-bound + 可调徽标 + 内联 textarea
  assert.ok(html.includes("is-bound"), "绑定节点未高亮");
  assert.ok(html.includes("可调"), "缺可调徽标");
  assert.ok(html.includes("<textarea"), "绑定参数未内联渲染 ParamField");
  // 连线行文本
  assert.ok(html.includes("← #4"), "连线来源标注缺失");
  // 绑定叶子不在只读区重复
  assert.ok(!/wf-io-name">text</.test(html), "绑定叶子在只读区重复展示");
});

test("AppWorkflowGraph:无工作流兜底文案", () => {
  const app = normalizeApp({ id: "a2", name: "空" });
  const html = renderToStaticMarkup(
    h(AppWorkflowGraph, { app, values: {}, onParamChange: () => {} }),
  );
  assert.ok(html.includes("wf-empty"), "缺空态兜底");
});

test("AppWorkflowGraph:可用性优化——可调导航 + 出口徽标 + 浮动运行条(2026-09-02)", () => {
  const app = normalizeApp({
    id: "a3",
    name: "文生图完整",
    params_schema: [{ key: "prompt", label: "提示词", type: "textarea" }],
    bindings: { prompt: { node: "2", field: "inputs.text" } },
    workflow_json: { ...WF, "9": { class_type: "SaveImage", inputs: { images: ["3", 0] } } },
  }) satisfies AppItem;
  const html = renderToStaticMarkup(
    h(AppWorkflowGraph, {
      app,
      values: {},
      onParamChange: () => {},
      runSlot: h("button", { className: "run-btn" }, "运行应用"),
    }),
  );
  // 「可调 n」聚焦导航按钮(1 个绑定节点 → 可调 1)
  assert.ok(html.includes("可调 1"), "缺可调聚焦导航按钮");
  // 出口徽标(SaveImage 命中 OUTPUT_TYPE_RE)
  assert.ok(html.includes("wf-node-out") && html.includes("出口"), "出口节点未标记");
  // 浮动运行条(runSlot 落进 wf-run-float)
  assert.ok(html.includes("wf-run-float") && html.includes("run-btn"), "浮动运行条未渲染");
  // 双击聚焦提示
  assert.ok(html.includes("双击聚焦"), "缺聚焦交互提示");
});

test("AppWorkflowGraph:无绑定节点时不渲染可调导航", () => {
  const app = normalizeApp({ id: "a4", name: "纯展示", workflow_json: WF });
  const html = renderToStaticMarkup(
    h(AppWorkflowGraph, { app, values: {}, onParamChange: () => {} }),
  );
  assert.ok(!html.includes("wf-toolbar-focus"), "无绑定节点不应出现可调导航");
});

test("AppWorkflowGraph:导出工作流 + 在 Comfy 中打开(源码)", () => {
  const src = readSrc("components/apps/AppWorkflowGraph.tsx");
  const lib = readSrc("lib/apps.ts");
  assert.ok(src.includes("downloadWorkflowJson"), "缺导出 helper");
  assert.ok(src.includes("openAppWorkflowInComfy"), "缺打开画布 helper");
  assert.ok(lib.includes("export async function openAppInComfy"), "lib 应有后端 open-in-comfy client");
  assert.ok(lib.includes("export async function openAppWorkflowInComfy"), "lib 应封装跳转 /?view=canvas");
  assert.ok(lib.includes('searchParams.set("view", "canvas")'), "导航应 searchParams.set view=canvas");
  assert.ok(!/#canvas[`'"]/.test(lib) && !lib.includes("${base}#canvas"), "location.assign 不应再拼 #canvas");
  assert.ok(src.includes("在 Comfy 中打开"), "缺「在 Comfy 中打开」按钮文案");
  assert.ok(lib.includes("toiv_pending_comfy_workflow"), "应暂存 pending workflow");
  assert.ok(lib.includes("workflow_name"), "成功时应暂存 workflow_name 供 Canvas 自动 Load");
});

/* ── save-back(2026-09-22):从 Comfy 画布存回应用工作流 ── */
test("save-from-comfy:lib 封装契约 + AppRunnerView 按钮接线(源码断言)", () => {
  const lib = readSrc("lib/apps.ts");
  assert.ok(lib.includes("export async function saveAppFromComfy"), "缺 saveAppFromComfy 导出");
  assert.ok(lib.includes("/save-from-comfy`"), "路径错误");
  assert.ok(lib.includes('method: "POST"'), "应为 POST");
  const src = readSrc("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("saveAppFromComfy"), "运行台未引入 saveAppFromComfy");
  assert.ok(src.includes("handleSaveFromComfy"), "缺存回处理函数");
  assert.ok(src.includes("从画布存回"), "缺「从画布存回」按钮");
  assert.ok(src.includes("isAdmin &&"), "存回入口应 admin 门控(公共/内置应用仅 admin 可改)");
  assert.ok(src.includes("await load()"), "存回成功后应重拉应用联动刷新");
  assert.ok(src.includes("orphan_bindings"), "悬空绑定应透出提示");
});
