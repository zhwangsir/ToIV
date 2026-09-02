"use client";

/**
 * 应用「工作流」模式 v2(2026-09-02):ComfyUI 节点图画布(类 RunningHub)。
 * 存的 workflow_json 是 API 格式(无坐标),画布用分层拓扑自动布局:
 *   深度=最长路径分层成列,列内按父节点重心排序减少交叉(Sugiyama 简化);
 *   SVG 贝塞尔连线在下,HTML 节点卡在上(同一份 transform,pan/zoom 同步);
 *   绑定参数在节点内联编辑(与简洁模式共享 values)。
 * 交互:拖空白平移、滚轮缩放(指针为中心)、工具栏 +/-/适配。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ParamField } from "@/components/generate/ParamField";
import { Icon } from "@/components/ui/Icon";
import type { AppItem, AppBinding, AppWorkflowNode } from "@/lib/apps";

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

const NODE_W = 232;
const HEAD_H = 30;
const ROW_H = 18;
const BOUND_H = 72; /* 绑定参数(ParamField 紧凑态)占位高 */
const BOUND_AREA_PAD = 8;
const PAD_B = 10;
const GAP_X = 96;
const GAP_Y = 20;

export interface WfEdge {
  from: string;
  fromSlot: number;
  to: string;
  toInput: string;
}

export interface WfNodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 输入端口 y(相对节点顶):input 名 → y;绑定 inputs.<名> 的行被内联编辑占位 */
  inPortY: Record<string, number>;
}

export interface WfLayout {
  boxes: WfNodeBox[];
  edges: WfEdge[];
  width: number;
  height: number;
}

/** 节点高度:头部 + 只读输入行 + 绑定区 + 底 padding。 */
function nodeHeight(node: AppWorkflowNode, bound: { key: string; field: string }[]): number {
  const boundInputs = new Set(
    bound.filter((b) => b.field.startsWith("inputs.")).map((b) => b.field.slice(7)),
  );
  const ioRows = Object.keys(node.inputs ?? {}).filter((n) => !boundInputs.has(n)).length;
  const widgetsRow =
    node.widgets_values?.length && !bound.some((b) => b.field.startsWith("widgets_values.")) ? 1 : 0;
  const boundH = bound.length ? bound.length * BOUND_H + BOUND_AREA_PAD : 0;
  return HEAD_H + (ioRows + widgetsRow) * ROW_H + boundH + PAD_B;
}

/** 分层拓扑布局:深度成列(最长路径),列内按父重心排序(2 轮迭代减交叉)。 */
export function layoutWorkflow(
  wf: Record<string, AppWorkflowNode>,
  bindings: Record<string, AppBinding>,
): WfLayout {
  const ids = Object.keys(wf);
  const idSet = new Set(ids);
  const edges: WfEdge[] = [];
  for (const id of ids) {
    for (const [name, v] of Object.entries(wf[id].inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && idSet.has(v[0])) {
        edges.push({ from: v[0], fromSlot: typeof v[1] === "number" ? v[1] : 0, to: id, toInput: name });
      }
    }
  }
  // 深度 = 最长路径(Kahn 变体;环按 0 兜底)
  const parents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) parents.get(e.to)!.push(e.from);
  const depth = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; /* 环截断 */
    seen.add(id);
    let d = 0;
    for (const p of parents.get(id) ?? []) d = Math.max(d, resolve(p, seen) + 1);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) resolve(id, new Set());

  // 分列
  const cols = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    cols.set(d, [...(cols.get(d) ?? []), id]);
  }
  const sortedCols = [...cols.keys()].sort((a, b) => a - b);

  // 列内重心排序(父节点平均位置;无父保原序),两轮前向+一轮后向
  const yIndex = new Map<string, number>();
  const bary = (id: string, from: "parents" | "children"): number => {
    const rel =
      from === "parents"
        ? (parents.get(id) ?? [])
        : edges.filter((e) => e.from === id).map((e) => e.to);
    const ys = rel.map((r) => yIndex.get(r)).filter((v): v is number => v !== undefined);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.MAX_SAFE_INTEGER;
  };
  for (const c of sortedCols) cols.get(c)!.forEach((id, i) => yIndex.set(id, i));
  for (let round = 0; round < 2; round++) {
    for (const c of sortedCols) {
      cols.get(c)!.sort((a, b) => bary(a, "parents") - bary(b, "parents"));
      cols.get(c)!.forEach((id, i) => yIndex.set(id, i));
    }
    for (const c of [...sortedCols].reverse()) {
      cols.get(c)!.sort((a, b) => bary(a, "children") - bary(b, "children"));
      cols.get(c)!.forEach((id, i) => yIndex.set(id, i));
    }
  }

  // 坐标
  const byNode = new Map<string, { key: string; field: string }[]>();
  for (const [key, b] of Object.entries(bindings)) {
    byNode.set(b.node, [...(byNode.get(b.node) ?? []), { key, field: b.field }]);
  }
  const boxes: WfNodeBox[] = [];
  let maxY = 0;
  for (const c of sortedCols) {
    let y = 0;
    for (const id of cols.get(c)!) {
      const node = wf[id];
      const bound = byNode.get(id) ?? [];
      const h = nodeHeight(node, bound);
      // 输入端口 y:DOM 序 = 头部 → 绑定区 → 只读行;只读行端口须加绑定区偏移
      const inPortY: Record<string, number> = {};
      const boundInputs = new Set(
        bound.filter((b) => b.field.startsWith("inputs.")).map((b) => b.field.slice(7)),
      );
      const boundAreaH = bound.length ? bound.length * BOUND_H + BOUND_AREA_PAD : 0;
      let row = 0;
      for (const name of Object.keys(node.inputs ?? {})) {
        if (boundInputs.has(name)) {
          inPortY[name] = HEAD_H / 2; /* 绑定行连线汇入头部端口 */
        } else {
          inPortY[name] = HEAD_H + boundAreaH + row * ROW_H + ROW_H / 2;
          row++;
        }
      }
      boxes.push({ id, x: c * (NODE_W + GAP_X), y, w: NODE_W, h, inPortY });
      y += h + GAP_Y;
    }
    maxY = Math.max(maxY, y - GAP_Y);
  }
  const width = sortedCols.length * (NODE_W + GAP_X) - GAP_X;
  return { boxes, edges, width, height: Math.max(maxY, 1) };
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

function leafText(v: unknown): string {
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "—";
  const j = JSON.stringify(v);
  return j.length > 36 ? `${j.slice(0, 36)}…` : j;
}

/** 贝塞尔连线路径(横向 control handle 随距离伸缩)。 */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

interface AppWorkflowGraphProps {
  app: AppItem;
  values: Record<string, unknown>;
  onParamChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  /** 运行操作槽(2026-09-02):浮动在画布右下,改完参数就地跑,不用滚出画布 */
  runSlot?: ReactNode;
}

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2;

/** 输出类节点(Save 系/Preview 系/合成器):画布上标「出口」徽标,一眼找到产物落点。 */
const OUTPUT_TYPE_RE =
  /^(SaveImage|SaveVideo|SaveAudio|SaveAnimatedWEBP|SaveAnimatedPNG|PreviewImage|VHS_VideoCombine|SaveWEBP|ExportAudio|SaveAudioMP3)/i;

export function AppWorkflowGraph({ app, values, onParamChange, disabled, runSlot }: AppWorkflowGraphProps) {
  const wf = app.workflow_json;
  const layout = useMemo(
    () => (wf && Object.keys(wf).length ? layoutWorkflow(wf, app.bindings) : null),
    [wf, app.bindings],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  /** 视图变换:scale + translate(屏幕系) */
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const dragRef = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);
  /** hover 节点 id(高亮上下游连线) */
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** 脉冲高亮节点 id(聚焦导航时) */
  const [pulseId, setPulseId] = useState<string | null>(null);
  /** 「可调 n」循环聚焦游标 */
  const focusIdxRef = useRef(-1);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 适配全图(首次挂载 + 图变化时) */
  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || !layout) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    if (!vw || !vh) return;
    const s = Math.min(vw / (layout.width + 80), vh / (layout.height + 80), 1);
    setView({
      s,
      x: (vw - layout.width * s) / 2,
      y: (vh - layout.height * s) / 2 + 8,
    });
  }, [layout]);

  useEffect(() => {
    fit();
  }, [fit]);

  const zoomBy = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const px = cx ?? rect.width / 2;
      const py = cy ?? rect.height / 2;
      setView((v) => {
        const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.s * factor));
        const k = s / v.s;
        return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      });
    },
    [],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0));
    },
    [zoomBy],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    /* 只响应空白背景拖拽(节点/工具栏/浮动运行条不抢) */
    if ((e.target as HTMLElement).closest(".wf-node, .wf-canvas-toolbar, .wf-run-float")) return;
    dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.x, view.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.px, y: d.vy + e.clientY - d.py }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  /** 聚焦节点:缩放到 ≥100% 并居中 + 脉冲 1.6s(双击节点头 / 「可调」导航用)。 */
  const focusNode = useCallback(
    (id: string) => {
      const el = containerRef.current;
      const box = layout?.boxes.find((b) => b.id === id);
      if (!el || !box) return;
      setView((v) => {
        const s = Math.max(v.s, 1);
        return {
          s,
          x: el.clientWidth / 2 - (box.x + box.w / 2) * s,
          y: el.clientHeight / 2 - (box.y + box.h / 2) * s,
        };
      });
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      setPulseId(id);
      pulseTimerRef.current = setTimeout(() => setPulseId(null), 1600);
    },
    [layout],
  );

  if (!wf || !layout) {
    return <p className="wf-empty">该应用未提供工作流细节</p>;
  }

  const boxById = new Map(layout.boxes.map((b) => [b.id, b]));
  /** 可调节点(按布局序):「可调 n」按钮循环聚焦 */
  const boundNodeIds = layout.boxes
    .filter((b) => Object.values(app.bindings).some((bb) => bb.node === b.id))
    .map((b) => b.id);
  const focusNextBound = () => {
    if (!boundNodeIds.length) return;
    focusIdxRef.current = (focusIdxRef.current + 1) % boundNodeIds.length;
    focusNode(boundNodeIds[focusIdxRef.current]);
  };
  /** 输出端口 y:头部中心按 slot 微错开 */
  const outPortY = (slot: number) => HEAD_H / 2 + Math.min(slot, 4) * 5 - 10;

  return (
    <div className="wf-canvas-wrap">
      <div className="wf-canvas-toolbar">
        {boundNodeIds.length > 0 && (
          <button
            type="button"
            className="wf-toolbar-focus"
            onClick={focusNextBound}
            title="逐个定位可调节点(自动缩放居中)"
          >
            <Icon name="sliders" size={12} /> 可调 {boundNodeIds.length}
          </button>
        )}
        <button type="button" aria-label="缩小" onClick={() => zoomBy(0.8)}>
          <Icon name="minus" size={13} />
        </button>
        <button type="button" aria-label="放大" onClick={() => zoomBy(1.25)}>
          <Icon name="plus" size={13} />
        </button>
        <button type="button" aria-label="适配全图" onClick={fit}>
          <Icon name="maximize" size={13} />
        </button>
        <span className="wf-canvas-hint">
          拖动空白平移 · 滚轮缩放 · 双击节点聚焦 · {layout.boxes.length} 节点
        </span>
      </div>
      <div
        ref={containerRef}
        className="wf-canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="application"
        aria-label="工作流画布"
      >
        <div
          className="wf-canvas-inner"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
        >
          {/* 连线层(SVG 在下) */}
          <svg
            className="wf-canvas-edges"
            width={layout.width + NODE_W}
            height={layout.height + 40}
            aria-hidden="true"
          >
            {layout.edges.map((e, i) => {
              const a = boxById.get(e.from);
              const b = boxById.get(e.to);
              if (!a || !b) return null;
              const bound = Object.values(app.bindings).some(
                (bb) => bb.node === e.to && bb.field === `inputs.${e.toInput}`,
              );
              const hot = hoverId !== null && (e.from === hoverId || e.to === hoverId);
              return (
                <path
                  key={i}
                  className={`wf-edge${bound ? " is-bound" : ""}${hot ? " is-hot" : ""}`}
                  d={edgePath(a.x + a.w, a.y + outPortY(e.fromSlot), b.x, b.y + (b.inPortY[e.toInput] ?? HEAD_H / 2))}
                />
              );
            })}
          </svg>

          {/* 节点层(HTML 在上,表单可交互) */}
          {layout.boxes.map((box) => {
            const node = wf[box.id];
            const bound: { key: string; field: string }[] = [];
            for (const [key, b] of Object.entries(app.bindings)) {
              if (b.node === box.id) bound.push({ key, field: b.field });
            }
            const boundInputs = new Set(
              bound.filter((b) => b.field.startsWith("inputs.")).map((b) => b.field.slice(7)),
            );
            const ioRows = Object.entries(node.inputs ?? {}).filter(([n]) => !boundInputs.has(n));
            const isOutput = OUTPUT_TYPE_RE.test(node.class_type);
            return (
              <section
                key={box.id}
                className={`wf-node${bound.length ? " is-bound" : ""}${pulseId === box.id ? " is-pulse" : ""}${hoverId === box.id ? " is-hot" : ""}`}
                style={{ left: box.x, top: box.y, width: box.w, minHeight: box.h }}
                aria-label={`节点 ${box.id}`}
                onMouseEnter={() => setHoverId(box.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                <header
                  className="wf-node-head"
                  title="双击聚焦"
                  onDoubleClick={() => focusNode(box.id)}
                >
                  <span className="wf-node-id">#{box.id}</span>
                  <span className="wf-node-type">{node.class_type}</span>
                  {isOutput && <span className="wf-node-out">出口</span>}
                  {bound.length > 0 && (
                    <span className="wf-node-flag">
                      <Icon name="sliders" size={10} /> 可调
                    </span>
                  )}
                </header>

                {bound.length > 0 && (
                  <div className="wf-bound">
                    {bound.map((b) => {
                      const param = app.params_schema.find((p) => p.key === b.key);
                      if (!param) return null;
                      return (
                        <ParamField
                          key={b.key}
                          param={param}
                          value={values[b.key]}
                          onChange={onParamChange}
                          disabled={disabled}
                        />
                      );
                    })}
                  </div>
                )}

                {ioRows.length > 0 && (
                  <dl className="wf-node-ios">
                    {ioRows.map(([name, v]) => (
                      <div key={name} className="wf-io">
                        <dt className="wf-io-name">{name}</dt>
                        <dd className="wf-io-val">
                          {Array.isArray(v) ? <span className="wf-io-link">← #{String(v[0])}</span> : leafText(v)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            );
          })}
        </div>
        {/* 浮动运行条(改完参数就地跑,不用滚出画布) */}
        {runSlot && <div className="wf-run-float">{runSlot}</div>}
      </div>
    </div>
  );
}
