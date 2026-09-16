/**
 * 原生画布解析层单测(2026-09-16 画布去 iframe 化):
 * ① UI 格式解析:links→边、widget 数组映射(control_after_generate 多占格)、
 *    Reroute/Note/未知节点特型、groups;
 * ② widget 对齐歧义消解:老前端(转连线 widget 值剔除)与新前端(保留)两种数组
 *    长度都能映射正确;
 * ③ API 格式解析 + toApiFormat 导出:reroute/primitive 穿透、note/group 剔除、
 *    无 SaveImage 节点告警、muted 剔除告警;
 * ④ 往返:parseApiWorkflow → toApiFormat 与原图等价(结构级)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  graphSummary,
  parseApiWorkflow,
  parseUiWorkflow,
  toApiFormat,
  type ApiGraphNode,
  type ObjectInfoMap,
  type UiWorkflow,
} from "../lib/canvasFlow";

const OBJ: ObjectInfoMap = {
  UNETLoader: {
    input: { required: { unet_name: [["a.safetensors", "b.safetensors"]], weight_dtype: [["default", "fp8"]] } },
    output: ["MODEL"],
    output_name: ["OUT"],
  },
  CLIPTextEncode: {
    input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP"] } },
    output: ["CONDITIONING"],
  },
  KSampler: {
    input: {
      required: {
        seed: ["INT", { default: 0, control_after_generate: true }],
        steps: ["INT", { default: 20 }],
        cfg: ["FLOAT", { default: 1.0 }],
        sampler_name: [["euler", "dpmpp_2m"]],
        denoise: ["FLOAT", { default: 1.0 }],
        model: ["MODEL"],
        positive: ["CONDITIONING"],
        negative: ["CONDITIONING"],
        latent_image: ["LATENT"],
      },
    },
    output: ["LATENT"],
  },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "out" }] } }, output: [] },
};

function uiFixture(widgetsArray: unknown[]): UiWorkflow {
  return {
    last_node_id: 6,
    last_link_id: 8,
    nodes: [
      {
        id: 1, type: "UNETLoader", pos: [40, 40], mode: 0, inputs: [], widgets_values: widgetsArray,
        outputs: [{ name: "OUT", type: "MODEL", links: [1], slot_index: 0 }],
      },
      {
        id: 2, type: "KSampler", pos: [380, 40], mode: 0,
        inputs: [
          { name: "model", type: "MODEL", link: 1 },
          { name: "positive", type: "CONDITIONING", link: 3 },
        ],
        widgets_values: widgetsArray2(),
        outputs: [{ name: "LATENT", type: "LATENT", links: [5], slot_index: 0 }],
      },
      { id: 3, type: "CLIPTextEncode", pos: [380, 320], mode: 0, inputs: [], widgets_values: ["一只猫", 7], outputs: [{ name: "OUT", type: "CONDITIONING", links: [3], slot_index: 0 }] },
      { id: 4, type: "Reroute", pos: [220, 200], mode: 0, inputs: [{ name: "", type: "*", link: 4 }], outputs: [{ name: "", type: "*", links: [1], slot_index: 0 }] },
      { id: 5, type: "Note", pos: [40, 380], mode: 0, inputs: [], widgets_values: ["备注:先跑低步数"], outputs: [] },
      { id: 9, type: "SomeCustomNode", pos: [600, 40], mode: 0, inputs: [{ name: "extra", type: "*", link: null }], widgets_values: [42], outputs: [] },
    ],
    links: [
      [4, 1, 0, 4, 0, "MODEL"],
      [1, 4, 0, 2, 0, "MODEL"],
      [3, 3, 0, 2, 1, "CONDITIONING"],
      [5, 2, 0, 6, 0, "LATENT"],
    ],
    groups: [{ title: "采样组", bounding: [360, 0, 420, 300] }],
  };
}

/* KSampler 全 widget 未连线:seed(+cag) 2 格 + steps/cfg/sampler/denoise 4 格 = 6 */
function widgetsArray2(): unknown[] {
  return [123, "randomize", 20, 3.5, "euler", 0.8];
}

test("parseUiWorkflow:基础映射与特型节点", () => {
  const g = parseUiWorkflow(uiFixture([123, "randomize", 20, 3.5, "euler", 0.8]), OBJ);
  assert.equal(g.nodes.length, 6);
  assert.equal(g.edges.length, 3); // link5 指向 fixture 外的节点 6,跳过

  const ks = g.nodes.find((n) => n.type === "KSampler")!;
  assert.equal(ks.widgets.length, 5);
  const seed = ks.widgets.find((w) => w.name === "seed")!;
  assert.equal(seed.value, 123);
  assert.equal(seed.controlAfterGenerate, true);
  assert.equal(ks.widgets.find((w) => w.name === "sampler_name")!.value, "euler");
  assert.equal(ks.widgets.find((w) => w.name === "sampler_name")!.options?.join(","), "euler,dpmpp_2m");
  assert.equal(ks.widgets.find((w) => w.name === "denoise")!.value, 0.8);
  // socket 输入
  assert.deepEqual(ks.inputs.map((s) => s.name), ["model", "positive", "negative", "latent_image"]);
  assert.equal(ks.inputs.find((s) => s.name === "model")!.link, 1);

  // 边:目标输入名从目标节点 inputs 序号解析
  const e = g.edges.find((x) => x.to === "2" && x.toInput === "model")!;
  assert.ok(e, "model 边存在");
  assert.equal(e.from, "4"); // 经 reroute

  const unet = g.nodes.find((n) => n.type === "UNETLoader")!;
  assert.equal(unet.widgets.find((w) => w.name === "unet_name")!.value, 123); // fixture 复用同一数组,取 index 0
  assert.equal(unet.special, "normal");

  const note = g.nodes.find((n) => n.special === "note")!;
  assert.equal(note.noteText, "备注:先跑低步数");
  assert.ok(g.nodes.find((n) => n.special === "reroute"));
  assert.ok(g.nodes.find((n) => n.special === "unknown"), "不在 object_info 的类 → unknown");
  assert.equal(g.groups[0].title, "采样组");
  assert.equal(graphSummary(g).unknown, 1);
});

test("widget 对齐:老前端剔除转连线值 vs 新前端保留,两种长度都映射正确", () => {
  const base = uiFixture(widgetsArray2());
  // 把 seed 转成连线(老前端:数组剔除 seed+control 两格 → [20,3.5,"euler",0.8])
  const ks = base.nodes!.find((n) => n.id === 2)!;
  ks.inputs!.unshift({ name: "seed", type: "INT", link: 9, widget: { name: "seed" } });
  base.links!.push([9, 3, 0, 2, 4, "INT"] as unknown as [number, number, number, number, number, string]);

  const legacy = structuredClone(base) as UiWorkflow;
  legacy.nodes!.find((n) => n.id === 2)!.widgets_values = [20, 3.5, "euler", 0.8];
  const gLegacy = parseUiWorkflow(legacy, OBJ);
  const ksL = gLegacy.nodes.find((n) => n.id === "2")!;
  assert.equal(ksL.widgets.find((w) => w.name === "seed")!.linked, true);
  assert.equal(ksL.widgets.find((w) => w.name === "steps")!.value, 20);
  assert.equal(ksL.widgets.find((w) => w.name === "cfg")!.value, 3.5);
  assert.equal(ksL.widgets.find((w) => w.name === "sampler_name")!.value, "euler");
  assert.equal(ksL.widgets.find((w) => w.name === "denoise")!.value, 0.8);

  const modern = structuredClone(base) as UiWorkflow;
  modern.nodes!.find((n) => n.id === 2)!.widgets_values = [123, "randomize", 20, 3.5, "euler", 0.8];
  const gModern = parseUiWorkflow(modern, OBJ);
  const ksM = gModern.nodes.find((n) => n.id === "2")!;
  assert.equal(ksM.widgets.find((w) => w.name === "seed")!.linked, true);
  assert.equal(ksM.widgets.find((w) => w.name === "steps")!.value, 20);
  assert.equal(ksM.widgets.find((w) => w.name === "denoise")!.value, 0.8);
});

test("toApiFormat:reroute/primitive 穿透 + note 剔除 + 无产物节点告警", () => {
  const g = parseUiWorkflow(uiFixture(widgetsArray2()), OBJ);
  // 接上 SaveImage,让链路完整:KSampler → SaveImage
  g.nodes.push({
    id: "6", type: "SaveImage", label: "SaveImage", special: "normal", muted: false, x: 700, y: 40,
    inputs: [{ name: "images", type: "IMAGE", link: 5 }], outputs: [], widgets: [
      { name: "filename_prefix", kind: "string", linked: false, value: "toiv" },
    ],
  });
  // 解析发生在入桩前,link5 当时因目标缺失被跳过;此处手工补边
  g.edges.push({ id: "l5", from: "2", fromSlot: 0, to: "6", toInput: "images", type: "LATENT" });
  const { graph, warnings } = toApiFormat(g);
  assert.ok(graph, "可导出");
  assert.deepEqual(warnings, []);
  // KSampler.model 应穿透 reroute 回到 UNETLoader 槽 0
  assert.deepEqual(graph!["2"].inputs.model, ["1", 0]);
  assert.equal(graph["2"].inputs.seed, 123);
  assert.equal(graph["2"].inputs.sampler_name, "euler");
  assert.deepEqual(graph!["6"].inputs.images, ["2", 0]);
  assert.ok(!graph["5"], "note 不导出");
  assert.ok(!graph["4"], "reroute 不导出(已穿透)");

  const g2 = parseApiWorkflow({ "1": { class_type: "UNETLoader", inputs: { unet_name: "a.safetensors" } } }, OBJ);
  const r2 = toApiFormat(g2);
  assert.ok(r2.warnings.some((w) => w.includes("SaveImage")));
});

test("parseApiWorkflow→toApiFormat 往返等价 + muted 剔除", () => {
  const src: Record<string, ApiGraphNode> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "b.safetensors", weight_dtype: "fp8" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "prompt", clip: ["1", 0] } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "x" } },
  };
  const g = parseApiWorkflow(src, OBJ);
  assert.equal(g.edges.length, 2);
  const clipNode = g.nodes.find((n) => n.id === "2")!;
  assert.equal(clipNode.widgets.find((w) => w.name === "text")!.value, "prompt");
  const { graph, warnings } = toApiFormat(g);
  assert.deepEqual(warnings, []);
  assert.deepEqual(graph!["2"].inputs.clip, ["1", 0]);
  assert.equal(graph!["1"].inputs.unet_name, "b.safetensors");

  // muted 节点剔除 + 告警
  g.nodes.find((n) => n.id === "3")!.muted = true;
  const r = toApiFormat(g);
  assert.ok(r.warnings.some((w) => w.includes("静音")));
  assert.ok(!r.graph?.["3"]);
});
