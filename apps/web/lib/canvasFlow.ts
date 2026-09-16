/**
 * 原生 ComfyUI 工作流画布解析层(2026-09-16 画布去 iframe 化)。
 *
 * 两个方向:
 * - parseUiWorkflow / parseApiWorkflow:ComfyUI 图(UI 格式带坐标 / API 格式裸图)
 *   → CanvasGraph(节点模型 + 连线 + 分组),供 React Flow 渲染;
 * - toApiFormat:CanvasGraph(含用户在画布上改过的 widget 值)→ API 格式图,
 *   交 POST /api/generate/raw 运行。
 *
 * widget 映射的 ground truth 是真实 userdata 文件:links=[id,源节点,源槽,目标节点,
 * 目标输入序,类型];widgets_values 是按 widget 视觉顺序的数组,老前端把已转连线的
 * widget 值从数组剔除、新前端保留 —— 用「两种假设按数组长度就近对齐」消解歧义;
 * control_after_generate 会在数组里多占一格。
 */

/* ── ComfyUI UI 格式(带坐标) ── */

export interface UiNodeInput {
  name: string;
  type: string;
  link?: number | null;
  widget?: { name: string };
}

export interface UiNodeOutput {
  name: string;
  type: string;
  links?: number[] | null;
  slot_index?: number;
}

export interface UiNode {
  id: number;
  type: string;
  title?: string;
  pos?: [number, number];
  size?: { 0: number; 1: number } | [number, number];
  mode?: number;
  inputs?: UiNodeInput[];
  outputs?: UiNodeOutput[];
  widgets_values?: unknown[] | Record<string, unknown>;
  properties?: Record<string, unknown>;
}

export interface UiGroup {
  title?: string;
  bounding: [number, number, number, number];
  color?: string;
}

export interface UiWorkflow {
  nodes?: UiNode[];
  links?: Array<[number, number, number, number, number, string]>;
  groups?: UiGroup[];
  extra?: Record<string, unknown>;
  definitions?: { subgraphs?: unknown[] };
  last_node_id?: number;
  last_link_id?: number;
}

/* ── object_info 节点定义 ── */

export type DefSpec = Record<string, unknown[]>;

export interface NodeDef {
  name?: string;
  input?: { required?: DefSpec; optional?: DefSpec };
  output?: string[];
  output_name?: string[];
}

export type ObjectInfoMap = Record<string, NodeDef>;

/* ── 画布节点模型 ── */

export type WidgetKind = "combo" | "int" | "float" | "string" | "text" | "bool" | "raw";

export interface WidgetSlotModel {
  name: string;
  kind: WidgetKind;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
  controlAfterGenerate?: boolean;
  value: unknown;
  linked: boolean;
}

export interface SocketInputModel {
  name: string;
  type: string;
  link: number | null;
}

export type NodeSpecial = "normal" | "note" | "reroute" | "primitive" | "unknown" | "group";

export interface CanvasNodeModel {
  id: string;
  type: string;
  label: string;
  special: NodeSpecial;
  muted: boolean; // mode 2=静音 4=bypass
  x: number;
  y: number;
  inputs: SocketInputModel[];
  outputs: UiNodeOutput[];
  widgets: WidgetSlotModel[];
  noteText?: string;
  rawWidgets?: unknown[];
}

export interface CanvasEdgeModel {
  id: string;
  from: string;
  fromSlot: number;
  to: string;
  toInput: string;
  type: string;
}

export interface CanvasGroupModel {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasGraph {
  nodes: CanvasNodeModel[];
  edges: CanvasEdgeModel[];
  groups: CanvasGroupModel[];
  hasSubgraphDefs: boolean;
}

export interface ApiGraphNode {
  class_type: string;
  inputs?: Record<string, unknown>;
  mode?: number;
  _meta?: { title?: string };
}

/* ── widget 分类 ── */

const BUILTIN_SPECIAL = new Set(["Reroute", "PrimitiveNode", "Note", "MarkdownNote"]);

function classifySpec(spec: unknown[]): { kind: WidgetKind | "socket"; config?: Record<string, unknown> } {
  const t = spec[0];
  const config = (spec[1] && typeof spec[1] === "object" && !Array.isArray(spec[1])
    ? (spec[1] as Record<string, unknown>)
    : undefined);
  if (Array.isArray(t)) return { kind: "combo", config };
  if (t === "INT") return { kind: "int", config };
  if (t === "FLOAT") return { kind: "float", config };
  if (t === "BOOLEAN") return { kind: "bool", config };
  if (t === "STRING") {
    const multiline = Boolean(config?.multiline);
    return { kind: multiline ? "text" : "string", config };
  }
  return { kind: "socket" };
}

function numberFromConfig(config: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = config?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 特殊节点归类(Reroute/Primitive/Note 不在 object_info,画布内建支持)。 */
function specialOf(type: string): NodeSpecial | null {
  if (type === "Reroute") return "reroute";
  if (type === "PrimitiveNode") return "primitive";
  if (type === "Note" || type === "MarkdownNote") return "note";
  return null;
}

/**
 * widget 值对齐:老前端数组不含已转连线的 widget 值,新前端含;
 * 两种假设各算一遍总消费数,与实际数组长度就近取假设。
 */
function pickWidgetHypothesis(
  entries: Array<{ name: string; kind: WidgetKind; config?: Record<string, unknown>; linked: boolean; consume: number }>,
  arrLen: number,
): { name: string; kind: WidgetKind; config?: Record<string, unknown>; linked: boolean; index: number }[] {
  const build = (linkedConsume: boolean) => {
    let idx = 0;
    const out: Array<{ name: string; kind: WidgetKind; config?: Record<string, unknown>; linked: boolean; index: number }> = [];
    for (const e of entries) {
      const consume = linkedConsume || !e.linked ? e.consume : 0;
      if (consume > 0) out.push({ ...e, index: idx });
      idx += consume;
    }
    return { out, total: idx };
  };
  const a = build(true);
  const b = build(false);
  const pick = Math.abs(a.total - arrLen) <= Math.abs(b.total - arrLen) ? a : b;
  return pick.out.filter((e) => e.index < arrLen || e.kind === "combo");
}

function widgetModel(
  name: string,
  kind: WidgetKind,
  config: Record<string, unknown> | undefined,
  linked: boolean,
  value: unknown,
): WidgetSlotModel {
  return {
    name,
    kind,
    linked,
    value,
    options: kind === "combo" ? (config?.__opts__ as string[] | undefined) : undefined,
    min: numberFromConfig(config, "min"),
    max: numberFromConfig(config, "max"),
    step: numberFromConfig(config, "step") ?? (kind === "int" ? 1 : undefined),
    multiline: kind === "text",
    controlAfterGenerate: Boolean(config?.control_after_generate),
  };
}

function readWidgetValue(wv: unknown, name: string): unknown {
  if (wv && typeof wv === "object" && !Array.isArray(wv)) {
    const obj = wv as Record<string, unknown>;
    return name in obj ? obj[name] : undefined;
  }
  return undefined;
}

/** def 的 required+optional 里 name→[spec] 有序展开(COMBO 枚举表挂 config.__opts__)。 */
function defEntries(def: NodeDef): Array<[string, unknown[]]> {
  const out: Array<[string, unknown[]]> = [];
  for (const section of [def.input?.required, def.input?.optional]) {
    if (!section) continue;
    for (const [name, spec] of Object.entries(section)) {
      if (Array.isArray(spec) && spec.length > 0) out.push([name, spec]);
    }
  }
  return out;
}

function resolveComboOptions(spec: unknown[]): string[] {
  const t = spec[0];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  // 动态 COMBO(如 file paths):定义是 STRING,前端运行时展开 —— 无枚举可给,文本框兜底
  return [];
}

/* ── UI 格式解析 ── */

export function parseUiWorkflow(wf: UiWorkflow, objectInfo: ObjectInfoMap): CanvasGraph {
  const rawNodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const byId = new Map(rawNodes.map((n) => [String(n.id), n]));
  const linkOf = new Map<number, [number, number, number, number, number, string]>();
  for (const l of wf.links ?? []) linkOf.set(l[0], l);

  const nodes: CanvasNodeModel[] = [];
  for (const n of rawNodes) {
    const id = String(n.id);
    const def = objectInfo[n.type];
    const builtin = specialOf(n.type);
    const special: NodeSpecial = builtin ?? (def ? "normal" : "unknown");
    const wv = n.widgets_values;

    if (special === "note") {
      const text = Array.isArray(wv) ? String(wv[0] ?? "") : typeof wv === "string" ? wv : "";
      nodes.push({
        id, type: n.type, label: n.type, special, muted: false,
        x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0,
        inputs: [], outputs: [], widgets: [], noteText: text,
      });
      continue;
    }
    if (special === "reroute") {
      const inp = n.inputs?.[0];
      nodes.push({
        id, type: n.type, label: "Reroute", special, muted: n.mode === 2 || n.mode === 4,
        x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0,
        inputs: [{ name: "input", type: inp?.type ?? "*", link: inp?.link ?? null }],
        outputs: n.outputs ?? [], widgets: [],
      });
      continue;
    }
    if (special === "primitive") {
      const value = Array.isArray(wv) ? wv[0] : undefined;
      nodes.push({
        id, type: n.type, label: n.title || "Primitive", special, muted: false,
        x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0,
        inputs: [],
        outputs: n.outputs ?? [],
        widgets: [{ name: "value", kind: "string", linked: false, value }],
      });
      continue;
    }

    const inputs: SocketInputModel[] = [];
    const widgets: WidgetSlotModel[] = [];

    if (!def) {
      // 未知节点:inputs 全按 socket 展示,widgets_values 原样列出(仍可运行)
      for (const i of n.inputs ?? []) {
        inputs.push({ name: i.name, type: i.type, link: i.link ?? null });
      }
      const raw = Array.isArray(wv) ? wv : wv && typeof wv === "object" ? Object.values(wv) : [];
      nodes.push({
        id, type: n.type, label: n.title || n.type, special: "unknown", muted: n.mode === 2 || n.mode === 4,
        x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0,
        inputs, outputs: n.outputs ?? [], widgets: [], rawWidgets: raw,
      });
      continue;
    }

    // 正常节点:按 def 顺序走一遍,socket/widget 分槽
    type DefEntry = { name: string; kind: WidgetKind | "socket"; config?: Record<string, unknown>; linked: boolean; consume: number };
    const entries: DefEntry[] = defEntries(def).map(([name, spec]) => {
      const { kind, config } = classifySpec(spec);
      const inputEntry = (n.inputs ?? []).find((i) => i.name === name);
      const linked = Boolean(inputEntry && inputEntry.link != null);
      const consume = kind === "socket" ? 0 : 1 + (config?.control_after_generate ? 1 : 0);
      return { name, kind, config, linked, consume };
    });
    const widgetEntries = entries.filter(
      (e): e is DefEntry & { kind: WidgetKind } => e.consume > 0,
    );
    const arrLen = Array.isArray(wv) ? wv.length : 0;
    const aligned = Array.isArray(wv)
      ? pickWidgetHypothesis(widgetEntries, arrLen)
      : widgetEntries.map((e) => ({ ...e, index: -1 }));
    const alignedByName = new Map(aligned.map((e) => [e.name, e]));
    const isWvObject = Boolean(wv && typeof wv === "object" && !Array.isArray(wv));

    for (const [name, spec] of defEntries(def)) {
      const { kind, config } = classifySpec(spec);
      const inputEntry = (n.inputs ?? []).find((i) => i.name === name);
      if (kind === "socket") {
        inputs.push({ name, type: String(spec[0]), link: inputEntry?.link ?? null });
        continue;
      }
      const linked = Boolean(inputEntry && inputEntry.link != null);
      let value: unknown;
      if (isWvObject) value = readWidgetValue(wv, name);
      else {
        const hit = alignedByName.get(name);
        value = hit && hit.index >= 0 && hit.index < arrLen ? (wv as unknown[])[hit.index] : undefined;
      }
      if (kind === "combo" && value === undefined) value = "";
      const model = widgetModel(name, kind, { ...config, __opts__: resolveComboOptions(spec) }, linked, value);
      widgets.push(model);
      // 同名的 socket 槽(转连线后仍有 socket 语义)已并入 linked,无需另开行
    }
    // def 没有但节点上存在的 socket 输入(扩展注入,如 image 升级链):保留展示
    const defNames = new Set(defEntries(def).map(([name]) => name));
    for (const i of n.inputs ?? []) {
      if (!defNames.has(i.name) && !inputs.some((x) => x.name === i.name)) {
        inputs.push({ name: i.name, type: i.type, link: i.link ?? null });
      }
    }

    nodes.push({
      id, type: n.type, label: n.title || def.name || n.type, special: "normal",
      muted: n.mode === 2 || n.mode === 4,
      x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0,
      inputs, outputs: n.outputs ?? [], widgets,
    });
  }

  const edges: CanvasEdgeModel[] = [];
  for (const [lid, origin, oslot, target, tslot, type] of wf.links ?? []) {
    const from = String(origin);
    const to = String(target);
    if (!byId.has(from) || !byId.has(to)) continue;
    const targetNode = byId.get(to)!;
    // Reroute 的 socket 名常为空串;穿透逻辑统一用 "input" 寻源
    const inputName =
      targetNode.inputs?.[tslot]?.name || (targetNode.type === "Reroute" ? "input" : `in${tslot}`);
    edges.push({ id: `l${lid}`, from, fromSlot: oslot, to, toInput: inputName, type: type || "*" });
  }

  const groups: CanvasGroupModel[] = (wf.groups ?? []).map((g, i) => ({
    id: `g${i}`,
    title: g.title || "",
    x: g.bounding?.[0] ?? 0,
    y: g.bounding?.[1] ?? 0,
    w: g.bounding?.[2] ?? 300,
    h: g.bounding?.[3] ?? 200,
  }));

  return { nodes, edges, groups, hasSubgraphDefs: Boolean(wf.definitions?.subgraphs?.length) };
}

/* ── API 格式解析(应用 workflow_json;坐标由调用方接 layoutWorkflow 补) ── */

export function parseApiWorkflow(wf: Record<string, ApiGraphNode>, objectInfo: ObjectInfoMap): CanvasGraph {
  const nodes: CanvasNodeModel[] = [];
  const edges: CanvasEdgeModel[] = [];

  const isLink = (v: unknown): v is [string, number] =>
    Array.isArray(v) && v.length >= 2 && (typeof v[0] === "string" || typeof v[0] === "number") && typeof v[1] === "number";

  for (const [id, gn] of Object.entries(wf)) {
    if (!gn || typeof gn.class_type !== "string") continue;
    const def = objectInfo[gn.class_type];
    const inputs: SocketInputModel[] = [];
    const widgets: WidgetSlotModel[] = [];
    if (!def) {
      for (const [name, v] of Object.entries(gn.inputs ?? {})) {
        if (isLink(v)) inputs.push({ name, type: "*", link: null });
        else widgets.push({ name, kind: "raw", linked: false, value: v });
      }
      nodes.push({
        id, type: gn.class_type, label: gn._meta?.title || gn.class_type, special: "unknown",
        muted: false, x: 0, y: 0, inputs, outputs: [], widgets,
      });
      continue;
    }
    const seen = new Set<string>();
    for (const [name, spec] of defEntries(def)) {
      seen.add(name);
      const { kind, config } = classifySpec(spec);
      const v = (gn.inputs ?? {})[name];
      if (kind === "socket") {
        inputs.push({ name, type: String(spec[0]), link: isLink(v) ? -1 : null });
        if (isLink(v)) {
          edges.push({
            id: `e-${id}-${name}`, from: String(v[0]), fromSlot: v[1], to: id, toInput: name, type: String(spec[0]),
          });
        }
        continue;
      }
      if (isLink(v)) {
        widgets.push(widgetModel(name, kind, { ...config, __opts__: resolveComboOptions(spec) }, true, undefined));
        edges.push({
          id: `e-${id}-${name}`, from: String(v[0]), fromSlot: v[1], to: id, toInput: name, type: kind,
        });
        continue;
      }
      widgets.push(widgetModel(name, kind, { ...config, __opts__: resolveComboOptions(spec) }, false, v));
    }
    for (const [name, v] of Object.entries(gn.inputs ?? {})) {
      if (seen.has(name)) continue;
      if (isLink(v)) {
        inputs.push({ name, type: "*", link: -1 });
        edges.push({ id: `e-${id}-${name}`, from: String(v[0]), fromSlot: v[1], to: id, toInput: name, type: "*" });
      } else {
        widgets.push({ name, kind: "raw", linked: false, value: v });
      }
    }
    const outputTypes = def.output ?? [];
    nodes.push({
      id, type: gn.class_type, label: gn._meta?.title || def.name || gn.class_type, special: "normal",
      muted: false, x: 0, y: 0,
      inputs,
      outputs: outputTypes.map((t, i) => ({ name: def.output_name?.[i] || t, type: t, links: null, slot_index: i })),
      widgets,
    });
  }
  return { nodes, edges, groups: [], hasSubgraphDefs: false };
}

/* ── 导出 API 格式(运行用) ── */

export interface ExportResult {
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> | null;
  warnings: string[];
}

const SAVE_NODE_RE = /^(SaveImage|SaveAnimatedWEBP|SaveAnimatedPNG|SaveImageWebsocket|VHS_SaveVideo|VHS_SaveImage|SaveVideo|WanVideo blockbuster|SaveWEBM|SaveAudio|SaveAudioMP3|SaveAudioOpus|SaveAudioFlac|3D Pack|MeshSave|SaveMesh)/i;

/** 画布图 → API 格式。跳过 note/reroute(后者在取源时穿透);muted 节点报 warning 不阻塞。 */
export function toApiFormat(graph: CanvasGraph): ExportResult {
  const warnings: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeByTarget = new Map<string, CanvasEdgeModel>();
  for (const e of graph.edges) edgeByTarget.set(`${e.to}::${e.toInput}`, e);

  const resolveSource = (nodeId: string, inputName: string, depth = 0): [string, number] | { value: unknown } | null => {
    if (depth > 32) return null; // 环兜底
    const e = edgeByTarget.get(`${nodeId}::${inputName}`);
    if (!e) return null;
    const src = byId.get(e.from);
    if (!src) return null;
    if (src.special === "reroute") return resolveSource(src.id, "input", depth + 1);
    if (src.special === "primitive") return { value: src.widgets[0]?.value };
    return [src.id, e.fromSlot];
  };

  const out: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
  let skippedMuted = 0;
  for (const n of graph.nodes) {
    if (n.special === "note" || n.special === "group") continue;
    if (n.muted) {
      skippedMuted += 1;
      continue;
    }
    if (n.special === "primitive") continue; // 只作为取源穿透目标,不产出 API 节点
    if (n.special === "reroute") continue; // 已在取源时穿透,本体不产出
    const inputs: Record<string, unknown> = {};
    for (const s of n.inputs) {
      if (s.link == null && n.special !== "unknown") continue; // 未连socket:缺参交上游校验
      const src = resolveSource(n.id, s.name);
      if (src && Array.isArray(src)) inputs[s.name] = src;
    }
    for (const w of n.widgets) {
      if (w.linked) {
        const src = resolveSource(n.id, w.name);
        if (src && Array.isArray(src)) inputs[w.name] = src;
        continue;
      }
      if (w.value === undefined || w.value === "") {
        if (w.kind === "raw" || w.kind === "string" || w.kind === "text") continue; // 空串省略(交上游必填校验)
      }
      inputs[w.name] = w.value;
    }
    if (n.special === "unknown") {
      // 未知节点:rawWidgets 原值保底塞回不了名字,只能尽量透传已知名 widget
      for (const w of n.widgets) inputs[w.name] = w.value;
    }
    out[n.id] = { class_type: n.type, inputs };
  }
  if (skippedMuted > 0) warnings.push(`已跳过 ${skippedMuted} 个静音/bypass 节点(bypass 透传不支持,请在 ComfyUI 中处理)`);
  const hasSave = Object.values(out).some((n) => SAVE_NODE_RE.test(n.class_type));
  if (!hasSave) warnings.push("图中没有 SaveImage/SaveVideo 类产物节点,作业可能无处取产物");
  return { graph: Object.keys(out).length ? out : null, warnings };
}

/** 画布图摘要(顶栏显示 + 测试)。 */
export function graphSummary(graph: CanvasGraph): { nodes: number; links: number; unknown: number } {
  return {
    nodes: graph.nodes.length,
    links: graph.edges.length,
    unknown: graph.nodes.filter((n) => n.special === "unknown").length,
  };
}
