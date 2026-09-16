"use client";

/**
 * 原生 ComfyUI 工作流画布(React Flow 底座,2026-09-16 画布去 iframe 化)。
 *
 * - 节点卡:端口按类型着色(语义色,TS 常量不受 CSS 零 hex 纪律约束),
 *   widget 内联编辑(combo/int/float/text/bool/raw),连线只读(v1 不做拓扑编辑);
 * - 状态契约:graph 由父层持有;graphKey 变化(换工作流)才重建内部 RF 状态,
 *   widget 编辑就地更新内部态并向父层回传(父层 graph 保持同步供导出运行);
 * - Reroute/Primitive/Note 为画布内建特型卡;未知节点灰卡 + raw 值兜底展示。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type {
  CanvasGraph,
  CanvasNodeModel,
  WidgetSlotModel,
} from "@/lib/canvasFlow";

/* 端口语义色(ComfyUI 社区约定;仅 TS 常量,CSS 零 hex 纪律不适用) */
const TYPE_COLORS: Record<string, string> = {
  MODEL: "#B39DDB",
  CLIP: "#E6C85A",
  VAE: "#E57373",
  CONDITIONING: "#F0A24B",
  IMAGE: "#64B5F6",
  LATENT: "#E58BD4",
  MASK: "#7DBD8E",
  CONTROL_NET: "#6EC6B3",
  UPSCALE_MODEL: "#7DA7D9",
  CLIP_VISION: "#9FA8DA",
  CLIP_VISION_OUTPUT: "#9FA8DA",
  STRING: "#8BC34A",
  INT: "#7FA6E3",
  FLOAT: "#7FA6E3",
  BOOLEAN: "#C9A227",
  AUDIO: "#E59866",
  "*": "#8A93A3",
};

function typeColor(t: string | undefined): string {
  if (!t) return TYPE_COLORS["*"];
  return TYPE_COLORS[t] ?? TYPE_COLORS[t.toUpperCase()] ?? TYPE_COLORS["*"];
}

export interface FlowCanvasProps {
  graph: CanvasGraph;
  /** 换工作流时递增;只有它变化才重建内部节点态 */
  graphKey: string;
  onWidgetChange?: (nodeId: string, widgetName: string, value: unknown) => void;
}

/* ── widget 编辑器 ── */

function WidgetEditor({
  w,
  onChange,
}: {
  w: WidgetSlotModel;
  onChange: (v: unknown) => void;
}) {
  if (w.linked) {
    return <span className="cfl-widget-linked">已连线</span>;
  }
  switch (w.kind) {
    case "combo":
      return w.options && w.options.length > 0 ? (
        <select
          className="cfl-input cfl-select"
          value={String(w.value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          {w.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          {!w.options.includes(String(w.value ?? "")) && String(w.value ?? "") !== "" && (
            <option value={String(w.value)}>{String(w.value)}</option>
          )}
        </select>
      ) : (
        <input
          className="cfl-input"
          value={String(w.value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      );
    case "int":
    case "float": {
      const num = typeof w.value === "number" ? w.value : Number(w.value);
      return (
        <input
          className="cfl-input cfl-num"
          type="number"
          value={Number.isFinite(num) ? num : ""}
          step={w.kind === "int" ? 1 : w.step ?? 0.01}
          min={w.min}
          max={w.max}
          onChange={(e) => {
            const v = e.target.value === "" ? undefined : Number(e.target.value);
            onChange(w.kind === "int" ? Math.trunc(v ?? 0) : v);
          }}
        />
      );
    }
    case "bool":
      return (
        <input
          className="cfl-check"
          type="checkbox"
          checked={Boolean(w.value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "text":
      return (
        <textarea
          className="cfl-input cfl-area"
          rows={2}
          value={String(w.value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
      );
    default: {
      // string / raw:非对象原样文本;对象/数组尝试 JSON 往返
      const asText =
        w.value !== null && typeof w.value === "object" ? JSON.stringify(w.value) : String(w.value ?? "");
      return (
        <input
          className="cfl-input"
          value={asText}
          onChange={(e) => {
            const t = e.target.value;
            if (w.kind === "raw" && t.startsWith("{")) {
              try {
                onChange(JSON.parse(t));
                return;
              } catch {
                /* 半途 JSON:先存字符串 */
              }
            }
            onChange(t);
          }}
          spellCheck={false}
        />
      );
    }
  }
}

/* ── 节点卡 ── */

function ToivNodeCard({ data }: NodeProps) {
  const n = (data as { model: CanvasNodeModel }).model;
  const onWidget = (data as { onWidgetChange?: (nodeId: string, name: string, v: unknown) => void })
    .onWidgetChange;

  if (n.special === "reroute") {
    return (
      <div className="cfl-reroute" title="Reroute">
        <Handle type="target" position={Position.Left} style={{ background: typeColor(n.inputs[0]?.type) }} />
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: typeColor(n.outputs[0]?.type) }}
        />
      </div>
    );
  }
  if (n.special === "note") {
    return (
      <div className="cfl-note">
        <div className="cfl-note-text">{n.noteText || "(空注释)"}</div>
      </div>
    );
  }

  return (
    <div className={`cfl-card${n.muted ? " cfl-card--muted" : ""}${n.special === "unknown" ? " cfl-card--unknown" : ""}`}>
      <div className="cfl-card-head">
        <span className="cfl-card-title" title={n.type}>
          {n.label}
        </span>
        {n.muted && <span className="cfl-badge cfl-badge--muted">已跳过</span>}
        {n.special === "unknown" && <span className="cfl-badge">未知节点</span>}
      </div>

      {n.outputs.length > 0 && (
        <div className="cfl-sockets">
          {n.outputs.map((o, i) => (
            <div className="cfl-socket cfl-socket--out" key={`${o.name}-${i}`}>
              <span className="cfl-socket-dot" style={{ background: typeColor(o.type) }} aria-hidden="true" />
              <span className="cfl-socket-name">{o.name}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={String(i)}
                style={{ background: typeColor(o.type) }}
              />
            </div>
          ))}
        </div>
      )}

      {n.inputs.length > 0 && (
        <div className="cfl-sockets">
          {n.inputs.map((s) => (
            <div className="cfl-socket" key={s.name}>
              <Handle
                type="target"
                position={Position.Left}
                id={s.name}
                style={{ background: typeColor(s.type) }}
              />
              <span className="cfl-socket-dot" style={{ background: typeColor(s.type) }} aria-hidden="true" />
              <span className="cfl-socket-name">{s.name}</span>
              <span className="cfl-socket-type">{s.type}</span>
            </div>
          ))}
        </div>
      )}

      {n.widgets.length > 0 && (
        <div className="cfl-widgets">
          {n.widgets.map((w) => (
            <label className="cfl-widget" key={w.name}>
              <span className="cfl-widget-name" title={w.name}>
                {w.name}
              </span>
              <WidgetEditor w={w} onChange={(v) => onWidget?.(n.id, w.name, v)} />
            </label>
          ))}
        </div>
      )}

      {n.rawWidgets && n.rawWidgets.length > 0 && (
        <pre className="cfl-raw">{JSON.stringify(n.rawWidgets)}</pre>
      )}
    </div>
  );
}

function GroupBox({ data }: NodeProps) {
  const g = data as { title: string };
  return (
    <div className="cfl-group">
      <span className="cfl-group-title">{g.title}</span>
    </div>
  );
}

const NODE_TYPES = { toiv: ToivNodeCard, group: GroupBox };

/* ── 主画布 ── */

function FlowInner({ graph, graphKey, onWidgetChange }: FlowCanvasProps) {
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const widgetCbRef = useRef(onWidgetChange);
  widgetCbRef.current = onWidgetChange;

  // 换工作流(或首次)→ 从 graph 重建内部态;widget 编辑不重建
  useEffect(() => {
    const rfNodes: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: "toiv",
      position: { x: n.x, y: n.y },
      data: {
        model: n,
        onWidgetChange: (nodeId: string, name: string, v: unknown) => {
          setNodes((prev) =>
            prev.map((nd) => {
              if (nd.id !== nodeId) return nd;
              const m = (nd.data as { model: CanvasNodeModel }).model;
              const updated: CanvasNodeModel = {
                ...m,
                widgets: m.widgets.map((w) => (w.name === name ? { ...w, value: v } : w)),
              };
              return { ...nd, data: { ...nd.data, model: updated } };
            }),
          );
          widgetCbRef.current?.(nodeId, name, v);
        },
      },
      zIndex: n.special === "unknown" ? 1 : 2,
    }));
    if (graph.groups.length > 0) {
      rfNodes.push(
        ...graph.groups.map(
          (g): Node => ({
            id: g.id,
            type: "group",
            position: { x: g.x, y: g.y },
            data: { title: g.title },
            style: { width: g.w, height: g.h },
            zIndex: -1,
            selectable: false,
            deletable: false,
            draggable: true,
          }),
        ),
      );
    }
    setNodes(rfNodes);
    setEdges(
      graph.edges.map(
        (e): Edge => ({
          id: e.id,
          source: e.from,
          sourceHandle: String(e.fromSlot),
          target: e.to,
          targetHandle: e.toInput,
          type: "default",
          style: { stroke: typeColor(e.type), strokeWidth: 1.6, opacity: 0.9 },
        }),
      ),
    );
    const t = setTimeout(() => rf.fitView({ padding: 0.12, duration: 240 }), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey]);

  const minimapColor = useCallback((n: Node) => {
    const m = (n.data as { model?: CanvasNodeModel }).model;
    if (!m) return "#2E3440";
    if (m.special === "unknown") return "#7A5A3A";
    if (m.special === "note") return "#6E6444";
    if (m.muted) return "#4A4F58";
    return "#33415C";
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={NODE_TYPES}
      nodesConnectable={false}
      edgesFocusable={false}
      minZoom={0.06}
      maxZoom={2.2}
      proOptions={{ hideAttribution: true }}
      deleteKeyCode={null}
      fitView
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} />
      <Controls position="bottom-right" showInteractive={false} />
      <MiniMap
        position="top-right"
        pannable
        zoomable
        nodeColor={minimapColor}
        maskColor="rgba(8, 10, 13, 0.72)"
      />
    </ReactFlow>
  );
}

export default function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}
