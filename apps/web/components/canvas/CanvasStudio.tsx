"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeTypes,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { listModels, uploadImage } from "@/lib/api";

import { CanvasProvider, isType, type CanvasApi } from "./CanvasContext";
import { NodeMenu } from "./NodeMenu";
import { TextNode } from "./nodes/TextNode";
import { ImageNode } from "./nodes/ImageNode";
import { VideoNode } from "./nodes/VideoNode";
import { AudioNode } from "./nodes/AudioNode";
import { topoOrder, upstreamOf } from "./pipeline";
import { loadDraft, saveDraft } from "./storage";
import {
  EMPTY_RUN,
  canConnect,
  defaultData,
  nextNodeId,
  type AudioNodeData,
  type CanvasNodeType,
  type ImageNodeData,
  type NodeRunState,
  type VideoNodeData,
} from "./types";
import {
  uploadFromUrl,
  useNodeGeneration,
  type GenOutput,
  type NodeDispatch,
  type RunReporter,
} from "./useNodeGeneration";

import "./canvas.css";

const NODE_TYPES: NodeTypes = {
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  audio: AudioNode,
};

/** 起手示例:文本 → 图片,降低空画布的上手门槛。 */
function seedNodes(): { nodes: Node[]; edges: Edge[] } {
  const t = nextNodeId();
  const i = nextNodeId();
  return {
    nodes: [
      { id: t, type: "text", position: { x: 80, y: 160 }, data: defaultData("text") },
      { id: i, type: "image", position: { x: 460, y: 100 }, data: defaultData("image") },
    ],
    edges: [
      { id: `e-${t}-${i}`, source: t, target: i, sourceHandle: "text", targetHandle: "in" },
    ],
  };
}

function Inner() {
  const initial = useMemo(() => loadDraft() ?? seedNodes(), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [ckpts, setCkpts] = useState<string[]>([]);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; flow: XYPosition } | null>(null);
  const [savedTick, setSavedTick] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const { generate } = useNodeGeneration();

  // 让运行逻辑总能拿到最新 nodes/edges(回调闭包用 ref 兜底)。
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // ── 模型列表(图片节点的 ckpt 下拉)──
  useEffect(() => {
    let alive = true;
    listModels()
      .then((m) => {
        if (alive) setCkpts(m.checkpoints ?? []);
      })
      .catch(() => {
        /* 静默:下拉回落「默认模型」 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 图片节点拿到模型后,把 ckpt 为空的默认成第一个。
  useEffect(() => {
    if (ckpts.length === 0) return;
    setNodes((ns) =>
      ns.map((n) => {
        if (n.type !== "image") return n;
        const d = n.data as unknown as ImageNodeData;
        if (d.ckpt) return n;
        return { ...n, data: { ...d, ckpt: ckpts[0] } };
      }),
    );
  }, [ckpts, setNodes]);

  // ── 数据更新原语 ──
  const patchNodeData = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, data: { ...(n.data as object), ...patch } } : n,
        ),
      );
    },
    [setNodes],
  );

  const patchRun = useCallback(
    (id: string, patch: Partial<NodeRunState>) => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== id) return n;
          const data = n.data as Record<string, unknown>;
          const run = (data.run as NodeRunState | undefined) ?? EMPTY_RUN;
          return { ...n, data: { ...data, run: { ...run, ...patch } } };
        }),
      );
    },
    [setNodes],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    },
    [setNodes, setEdges],
  );

  // ── 连线:只允许语义合法的边 ──
  const isValidConnection = useCallback(
    (c: Connection | Edge): boolean => {
      const src = nodesRef.current.find((n) => n.id === c.source);
      const tgt = nodesRef.current.find((n) => n.id === c.target);
      if (!src?.type || !tgt?.type || src.id === tgt.id) return false;
      return canConnect(src.type as CanvasNodeType, tgt.type as CanvasNodeType);
    },
    [],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!isValidConnection(c)) return;
      setEdges((es) => addEdge({ ...c, animated: true }, es));
    },
    [isValidConnection, setEdges],
  );

  // ── 新建节点 ──
  const addNode = useCallback(
    (type: CanvasNodeType, flowPos: XYPosition, extra?: Record<string, unknown>) => {
      const id = nextNodeId();
      const data = { ...defaultData(type), ...extra };
      if (type === "image" && ckpts.length && !(data as ImageNodeData).ckpt) {
        (data as ImageNodeData).ckpt = ckpts[0];
      }
      setNodes((ns) => [...ns, { id, type, position: flowPos, data }]);
      return id;
    },
    [ckpts, setNodes],
  );

  // 双击空白 → 弹菜单
  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setMenu({
        x: e.clientX - (rect?.left ?? 0),
        y: e.clientY - (rect?.top ?? 0),
        flow,
      });
    },
    [screenToFlowPosition],
  );

  // ── 拖图片文件入画布 → 自动建图片节点(带该图作为参考)──
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const file = Array.from(e.dataTransfer.files).find((f) =>
        f.type.startsWith("image/"),
      );
      if (!file) return;
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const previewUrl = URL.createObjectURL(file);
      const id = addNode("image", flow, {
        run: { ...EMPTY_RUN, outputUrl: previewUrl },
      });
      // 后台上传,把 filename/worker 记到节点(供图生图/图生视频复用)。
      try {
        const up = await uploadImage(file, "img2img");
        patchNodeData(id, { _ref: up });
      } catch {
        /* 上传失败不阻断:仍可作为本地预览参考 */
      }
    },
    [addNode, patchNodeData, screenToFlowPosition],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  // ── 取上游输入:文本 / 图片产物 ──
  const collectInputs = useCallback((id: string) => {
    const ns = nodesRef.current;
    const refs = upstreamOf(id, ns, edgesRef.current);
    const byId = new Map(ns.map((n) => [n.id, n]));
    let upstreamText = "";
    let upstreamImageUrl: string | null = null;
    let upstreamRef: { filename: string; worker: string } | null = null;
    for (const r of refs) {
      const src = byId.get(r.sourceId);
      if (!src) continue;
      const d = src.data as Record<string, unknown>;
      if (r.sourceType === "text") {
        upstreamText = (d.prompt as string) ?? "";
      } else if (r.sourceType === "image") {
        const run = d.run as NodeRunState | undefined;
        if (run?.outputUrl) upstreamImageUrl = run.outputUrl;
        const ref = d._ref as { filename: string; worker: string } | undefined;
        if (ref) upstreamRef = ref;
      }
    }
    return { upstreamText, upstreamImageUrl, upstreamRef };
  }, []);

  // ── 构建单节点的派发载荷 ──
  const buildDispatch = useCallback(
    async (node: Node): Promise<NodeDispatch | { error: string } | null> => {
      const type = node.type as CanvasNodeType;
      const d = node.data as Record<string, unknown>;
      const { upstreamText, upstreamImageUrl, upstreamRef } = collectInputs(node.id);

      if (type === "image") {
        const data = d as unknown as ImageNodeData;
        const positive = (upstreamText || data.prompt || "").trim();
        // 有上游图片 → 图生图;否则文生图。
        if (upstreamImageUrl || upstreamRef) {
          let ref = upstreamRef;
          if (!ref && upstreamImageUrl) {
            ref = await uploadFromUrl(upstreamImageUrl, "img2img");
          }
          if (!ref) return { error: "上游图片不可用" };
          return {
            kind: "img2img",
            positive,
            ckpt: data.ckpt || ckpts[0] || "",
            image: ref.filename,
            worker: ref.worker,
          };
        }
        if (!positive) return { error: "缺少提示词(连文本节点或填写本地提示词)" };
        return {
          kind: "txt2img",
          positive,
          ckpt: data.ckpt || ckpts[0] || "",
          width: data.width,
          height: data.height,
        };
      }

      if (type === "video") {
        const data = d as unknown as VideoNodeData;
        const positive = (data.prompt || upstreamText || "").trim();
        if (upstreamImageUrl || upstreamRef) {
          let ref = upstreamRef;
          if (!ref && upstreamImageUrl) {
            ref = await uploadFromUrl(upstreamImageUrl, "video");
          }
          if (!ref) return { error: "上游图片不可用" };
          return {
            kind: "i2v",
            positive,
            image: ref.filename,
            worker: ref.worker,
            width: data.width,
            height: data.height,
            length: data.length,
            fps: data.fps,
          };
        }
        return {
          kind: "txt2video",
          positive,
          width: data.width,
          height: data.height,
          length: data.length,
          fps: data.fps,
        };
      }

      if (type === "audio") {
        const data = d as unknown as AudioNodeData;
        const tags = (upstreamText || data.prompt || "").trim();
        if (!tags) return { error: "缺少描述(连文本节点或填写标签)" };
        return { kind: "audio", tags, seconds: data.seconds };
      }

      return null; // 文本节点无需生成
    },
    [ckpts, collectInputs],
  );

  // ── 运行单节点 ──
  const runNode = useCallback(
    async (id: string): Promise<void> => {
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node || node.type === "text") return;
      patchRun(id, { busy: true, error: null, stage: "提交中…", progress: null, outputUrl: null });
      const dispatch = await buildDispatch(node);
      if (!dispatch || "error" in (dispatch ?? {})) {
        patchRun(id, {
          busy: false,
          stage: "",
          error: (dispatch as { error: string } | null)?.error ?? "无法生成",
        });
        return;
      }
      const reporter: RunReporter = {
        onStage: (stage, progress) => patchRun(id, { stage, progress }),
        onDone: (out: GenOutput) =>
          patchRun(id, {
            busy: false,
            stage: "",
            progress: null,
            error: null,
            outputUrl: out.url,
            outputWidth: out.width,
            outputHeight: out.height,
          }),
        onError: (message) => patchRun(id, { busy: false, stage: "", error: message }),
      };
      await generate(dispatch as NodeDispatch, reporter);
    },
    [buildDispatch, generate, patchRun],
  );

  // ── 运行全部:按拓扑顺序串行 ──
  const runAll = useCallback(async () => {
    if (pipelineBusy) return;
    setPipelineBusy(true);
    try {
      const order = topoOrder(nodesRef.current, edgesRef.current);
      for (const id of order) {
        const node = nodesRef.current.find((n) => n.id === id);
        if (!node || node.type === "text") continue;
        await runNode(id);
      }
    } finally {
      setPipelineBusy(false);
    }
  }, [pipelineBusy, runNode]);

  // ── 持久化:节点/边变动后防抖存草稿 ──
  useEffect(() => {
    const t = setTimeout(() => saveDraft(nodesRef.current, edgesRef.current), 600);
    return () => clearTimeout(t);
  }, [nodes, edges]);

  const onSaveClick = useCallback(() => {
    const ok = saveDraft(nodesRef.current, edgesRef.current);
    setSavedTick(ok ? "已保存草稿 ✓" : "保存失败");
    setTimeout(() => setSavedTick(null), 1800);
  }, []);

  const ctx: CanvasApi = useMemo(
    () => ({ patchNodeData, deleteNode, runNode, ckpts, pipelineBusy }),
    [patchNodeData, deleteNode, runNode, ckpts, pipelineBusy],
  );

  const pickFromMenu = useCallback(
    (type: CanvasNodeType) => {
      if (menu) addNode(type, menu.flow);
      setMenu(null);
    },
    [addNode, menu],
  );

  // 兼容 isType(避免未用告警)+ 节点计数展示
  const stat = useMemo(() => {
    const imgs = nodes.filter((n) => isType(n.type) && n.type !== "text").length;
    return { total: nodes.length, runnable: imgs };
  }, [nodes]);

  return (
    <div className="cv-studio" ref={wrapRef}>
      <div className="cv-toolbar">
        <div className="cv-toolbar__lead">
          <span className="cv-toolbar__kicker">CANVAS</span>
          <h2 className="cv-toolbar__title">创作画布</h2>
          <span className="cv-toolbar__hint">
            双击空白新建节点 · 拖图片入画布 · 连线成管线
          </span>
        </div>
        <div className="cv-toolbar__actions">
          {savedTick && <span className="cv-toolbar__saved">{savedTick}</span>}
          <span className="cv-toolbar__count">
            {stat.total} 节点 · {stat.runnable} 可生成
          </span>
          <button type="button" className="cv-btn" onClick={onSaveClick}>
            存草稿
          </button>
          <button
            type="button"
            className="cv-btn cv-btn--primary"
            onClick={runAll}
            disabled={pipelineBusy || stat.runnable === 0}
          >
            {pipelineBusy ? "运行中…" : "▶ 运行全部"}
          </button>
        </div>
      </div>

      <div className="cv-flow" onDrop={onDrop} onDragOver={onDragOver}>
        <CanvasProvider value={ctx}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            nodeTypes={NODE_TYPES}
            onInit={(inst) => (rfRef.current = inst)}
            onDoubleClick={onPaneDoubleClick}
            defaultEdgeOptions={{ animated: true }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.2}
            maxZoom={2}
            fitView
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={26}
              size={1.4}
              className="cv-bg"
            />
            <MiniMap
              className="cv-minimap"
              pannable
              zoomable
              nodeStrokeWidth={2}
              maskColor="rgba(12, 11, 13, 0.7)"
            />
            <Controls className="cv-controls" showInteractive={false} />
          </ReactFlow>
        </CanvasProvider>

        {menu && (
          <NodeMenu
            x={menu.x}
            y={menu.y}
            onPick={pickFromMenu}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    </div>
  );
}

/** 创作画布:LibLib/LibTV canvas 式的简化版可视化工作流。
 *  必须裹 ReactFlowProvider 才能用 useReactFlow / screenToFlowPosition。 */
export function CanvasStudio() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}
