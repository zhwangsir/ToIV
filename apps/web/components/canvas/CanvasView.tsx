"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Icon, type IconName } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { runSubgraph } from "@/lib/canvas/api";
import { useCanvasStore } from "@/lib/canvas/store";
import type { CanvasNodeKind } from "@/lib/canvas/types";
import { ToivNodeComponent } from "./nodes/ToivNode";
import { CanvasAmbience, type CanvasAmbienceHandle } from "./CanvasAmbience";
import { VoiceBar } from "./VoiceBar";
import { WorkflowLibrary } from "./WorkflowLibrary";

// ---------- 节点类型注册(模块级常量,避免每次渲染重新创建导致重渲染) ----------
const nodeTypes: NodeTypes = {
  toiv: ToivNodeComponent,
};

// ---------- 添加节点菜单配置 ----------
interface AddNodeOption {
  kind: CanvasNodeKind;
  label: string;
  icon: IconName;
  defaultTitle: string;
  defaultPayload: Record<string, unknown>;
}

const ADD_NODE_OPTIONS: AddNodeOption[] = [
  { kind: "text", label: "文本", icon: "file", defaultTitle: "文本笔记", defaultPayload: { text: "" } },
  { kind: "prompt", label: "提示词", icon: "sparkles", defaultTitle: "提示词", defaultPayload: { text: "", negative: "" } },
  { kind: "image", label: "图像", icon: "image", defaultTitle: "图像产物", defaultPayload: { urls: [] } },
  { kind: "video", label: "视频", icon: "video", defaultTitle: "视频产物", defaultPayload: { urls: [] } },
  { kind: "audio", label: "音频", icon: "audio", defaultTitle: "音频产物", defaultPayload: { urls: [] } },
  { kind: "model3d", label: "3D 模型", icon: "model3d", defaultTitle: "3D 模型", defaultPayload: { urls: [] } },
  { kind: "llm", label: "LLM", icon: "chat", defaultTitle: "LLM 对话", defaultPayload: { text: "", response: "" } },
  { kind: "comfy_workflow", label: "工作流", icon: "canvas", defaultTitle: "ComfyUI 工作流", defaultPayload: { graph: {}, summary: "" } },
  { kind: "tts", label: "TTS", icon: "mic", defaultTitle: "TTS 合成", defaultPayload: { text: "" } },
  { kind: "asr", label: "ASR", icon: "audio", defaultTitle: "ASR 听写", defaultPayload: { audio_url: "", text: "" } },
];

// ---------- 主组件 ----------
export function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasViewInner />
    </ReactFlowProvider>
  );
}

function CanvasViewInner() {
  const {
    canvases,
    canvasesLoading,
    canvasesError,
    activeCanvas,
    activeCanvasId,
    nodes,
    edges,
    loading,
    error,
    loadCanvases,
    createCanvas,
    selectCanvas,
    deleteActiveCanvas,
    renameActiveCanvas,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    selectedNodeIds,
  } = useCanvasStore();

  const { fitView, zoomIn, zoomOut, fitBounds } = useReactFlow();
  const toast = useToast();

  // ---------- 氛围层:暗房浮尘 + 点击涟漪 ----------
  const flowWrapRef = useRef<HTMLDivElement | null>(null);
  const ambienceRef = useRef<CanvasAmbienceHandle | null>(null);

  // 点击空白画布 → 在点击处激起慢速水波纹(自中心向外扩散)
  const handlePaneClick = useCallback((e: React.MouseEvent) => {
    const el = flowWrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    ambienceRef.current?.ripple(e.clientX - rect.left, e.clientY - rect.top);
  }, []);

  // ---------- 一次性加载画布列表 ----------
  useEffect(() => {
    void loadCanvases();
  }, [loadCanvases]);

  // ---------- M1 修复:组件挂载/卸载时管理 SSE 订阅生命周期 ----------
  // 问题:切换视图时 CanvasView 卸载但 SSE EventSource 未关闭导致泄漏;
  // 切回画布时若 activeCanvasId 已存在则 selectCanvas 不会被重新调用,
  // SSE 不会自动重连。
  // 策略:
  //   - 空依赖数组:cleanup 只在组件真正卸载时运行,关闭 SSE 连接
  //   - 挂载时若检测到是「切回画布」场景(有 activeCanvasId、数据已加载、
  //     无活跃连接),则手动重新订阅
  //   - 画布切换(activeCanvasId 变化)由 selectCanvas 内部自行处理:
  //     它先调 _unsubscribe() 关旧连接,加载完成后再 _subscribe() 新画布
  useEffect(() => {
    const store = useCanvasStore.getState();
    if (store.activeCanvasId && !store.loading && !store._eventSource) {
      store._subscribe(store.activeCanvasId);
    }
    return () => {
      useCanvasStore.getState()._unsubscribe();
    };
  }, []);

  // ---------- 自动选中画布:优先恢复 localStorage 记住的,否则选第一个 ----------
  useEffect(() => {
    if (!activeCanvasId && canvases.length > 0 && !canvasesLoading) {
      const saved =
        typeof window !== "undefined"
          ? window.localStorage.getItem("toiv_active_canvas")
          : null;
      const target =
        saved && canvases.some((c) => c.id === saved) ? saved : canvases[0].id;
      void selectCanvas(target);
    }
  }, [activeCanvasId, canvases, canvasesLoading, selectCanvas]);

  // ---------- 节点加载后自动适应视图(M1 修复:初始 fitView 在空画布时无法正确缩放,
  //            改为节点到位后延迟 fitView,确保缩放按钮范围正确) ----------
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (loading || !activeCanvasId || nodes.length === 0) {
      didInitialFit.current = false;
      return;
    }
    if (didInitialFit.current) return;
    didInitialFit.current = true;
    const t = setTimeout(() => {
      fitView({ padding: 0.2, duration: 300 });
    }, 100);
    return () => clearTimeout(t);
  }, [loading, activeCanvasId, nodes.length, fitView]);

  // ---------- 顶部工具栏状态 ----------
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [voiceOn, setVoiceOn] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  // 点击外部关闭添加节点菜单
  useEffect(() => {
    if (!addMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!addMenuRef.current) return;
      if (!addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [addMenuOpen]);

  // ---------- 操作回调 ----------
  const handleNewCanvas = useCallback(async () => {
    try {
      const c = await createCanvas(`未命名画布 ${new Date().toLocaleString("zh-CN")}`);
      await selectCanvas(c.id);
    } catch {
      /* 错误已通过 store.error 展示 */
    }
  }, [createCanvas, selectCanvas]);

  const handleSelectCanvas = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      if (id) void selectCanvas(id);
    },
    [selectCanvas],
  );

  const handleStartRename = useCallback(() => {
    if (!activeCanvas) return;
    setRenameValue(activeCanvas.name);
    setRenaming(true);
  }, [activeCanvas]);

  const handleCommitRename = useCallback(async () => {
    setRenaming(false);
    const next = renameValue.trim();
    if (!activeCanvas || !next || next === activeCanvas.name) return;
    try {
      await renameActiveCanvas(next);
    } catch {
      /* ignore */
    }
  }, [activeCanvas, renameValue, renameActiveCanvas]);

  const handleDeleteCanvas = useCallback(async () => {
    if (!activeCanvas) return;
    if (!window.confirm(`确定删除画布「${activeCanvas.name}」?所有节点和连线将一并删除。`)) return;
    try {
      await deleteActiveCanvas();
    } catch {
      /* ignore */
    }
  }, [activeCanvas, deleteActiveCanvas]);

  const handleAddNode = useCallback(
    async (opt: AddNodeOption) => {
      setAddMenuOpen(false);
      try {
        await addNode({
          kind: opt.kind,
          title: opt.defaultTitle,
          payload: opt.defaultPayload,
          position: { x: 120 + Math.random() * 200, y: 120 + Math.random() * 160 },
        });
      } catch {
        /* ignore */
      }
    },
    [addNode],
  );

  const toggleVoice = useCallback(() => setVoiceOn((v) => !v), []);

  // ---------- M2:运行选中节点(子图执行) ----------
  const [runningSelected, setRunningSelected] = useState(false);
  // M3.3:执行耗时计时(秒),运行中按钮显示进度感
  const [runElapsed, setRunElapsed] = useState(0);
  useEffect(() => {
    if (!runningSelected) return;
    setRunElapsed(0);
    const timer = setInterval(() => setRunElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [runningSelected]);

  // 选中计数(nodes 订阅已保证选中变化触发重渲染;id 列表在点击时经 store getter 取最新)
  const selectedCount = useMemo(
    () => nodes.filter((n) => n.selected).length,
    [nodes],
  );

  const handleRunSelected = useCallback(async () => {
    const canvasId = activeCanvasId;
    if (!canvasId || runningSelected) return;
    const ids = selectedNodeIds();
    if (ids.length === 0) return;
    setRunningSelected(true);
    try {
      const res = await runSubgraph(canvasId, ids);
      const shortId =
        res.prompt_id.length > 8
          ? `${res.prompt_id.slice(0, 8)}…`
          : res.prompt_id;
      // M3.1:自动 pin 产物节点已在画布落位(经 SSE node_added 推送)
      const pinNote =
        res.pinned.length > 0 ? `,产物已固定为 ${res.pinned.length} 个节点` : "";
      toast.success(`执行完成(${shortId})${pinNote}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunningSelected(false);
    }
  }, [activeCanvasId, runningSelected, selectedNodeIds, toast]);

  // ---------- M3.3:子图高亮(选中节点 + 与其直接相连的节点/边) ----------
  const highlightIds = useMemo(() => {
    const sel = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    if (sel.size === 0) return sel;
    const ids = new Set(sel);
    for (const e of edges) {
      if (sel.has(e.source) || sel.has(e.target)) {
        ids.add(e.source);
        ids.add(e.target);
      }
    }
    return ids;
  }, [nodes, edges]);

  // 高亮映射:仅在非空时重建数组(拖拽期选中态少见,O(n) 开销可接受)
  const displayNodes = useMemo(() => {
    if (highlightIds.size === 0) return nodes;
    return nodes.map((n) =>
      highlightIds.has(n.id) && !n.selected
        ? { ...n, className: "cv-flow-node-hl" }
        : n,
    );
  }, [nodes, highlightIds]);

  const displayEdges = useMemo(() => {
    if (highlightIds.size === 0) return edges;
    const sel = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    return edges.map((e) =>
      sel.has(e.source) || sel.has(e.target)
        ? { ...e, className: "cv-flow-edge-hl" }
        : e,
    );
  }, [edges, nodes, highlightIds]);

  // 快捷键:Ctrl/Cmd + Enter 等价于点击"运行选中"(重命名输入激活时不触发)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (renaming) return;
        e.preventDefault();
        void handleRunSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleRunSelected, renaming]);

  // ---------- 派生 ----------
  const hasCanvas = !!activeCanvas;
  const showEmpty = !canvasesLoading && canvases.length === 0;
  const showError = !!canvasesError || !!error;

  // ---------- 渲染 ----------
  return (
    <div className="canvas-view">
      {/* ───── 顶部工具栏 ───── */}
      <header className="cv-toolbar">
        <div className="cv-tb-left">
          {/* 画布选择器 */}
          <div className="cv-canvas-select">
            <Icon name="canvas" size={14} strokeWidth={1.8} />
            <select
              value={activeCanvasId ?? ""}
              onChange={handleSelectCanvas}
              disabled={canvasesLoading || canvases.length === 0}
              aria-label="选择画布"
            >
              {canvases.length === 0 && <option value="">尚无画布</option>}
              {canvases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* 新建画布 */}
          <button
            type="button"
            className="cv-tb-btn"
            onClick={handleNewCanvas}
            title="新建画布"
            aria-label="新建画布"
          >
            <Icon name="create" size={14} strokeWidth={1.8} />
            <span>新建</span>
          </button>

          {/* 重命名 */}
          {renaming ? (
            <input
              className="cv-rename-input"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleCommitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCommitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              placeholder="画布名称"
            />
          ) : (
            <button
              type="button"
              className="cv-tb-btn cv-tb-btn-ghost"
              onClick={handleStartRename}
              disabled={!hasCanvas}
              title="重命名画布"
              aria-label="重命名画布"
            >
              <Icon name="brush" size={14} strokeWidth={1.8} />
              <span>重命名</span>
            </button>
          )}

          {/* 删除 */}
          <button
            type="button"
            className="cv-tb-btn cv-tb-btn-danger"
            onClick={handleDeleteCanvas}
            disabled={!hasCanvas}
            title="删除画布"
            aria-label="删除画布"
          >
            <Icon name="delete" size={14} strokeWidth={1.8} />
            <span>删除</span>
          </button>
        </div>

        <div className="cv-tb-right">
          {/* 语音开关 */}
          <button
            type="button"
            className={`cv-tb-btn cv-tb-btn-voice${voiceOn ? " is-on" : ""}`}
            onClick={toggleVoice}
            disabled={!hasCanvas}
            title={voiceOn ? "关闭语音 Agent" : "开启语音 Agent"}
            aria-pressed={voiceOn}
            aria-label="语音 Agent 开关"
          >
            <Icon name="mic" size={14} strokeWidth={1.8} />
            <span>{voiceOn ? "语音已开" : "语音"}</span>
          </button>

          {/* M2:ComfyUI 模板库(触发按钮自带弹出面板) */}
          <WorkflowLibrary canvasId={activeCanvasId} />

          {/* 添加节点菜单 */}
          <div className="cv-add-menu" ref={addMenuRef}>
            <button
              type="button"
              className="cv-tb-btn cv-tb-btn-primary"
              onClick={() => setAddMenuOpen((v) => !v)}
              disabled={!hasCanvas}
              title="添加节点"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
            >
              <Icon name="sparkles" size={14} strokeWidth={2.2} />
              <span>添加节点</span>
              <Icon name="chevron-down" size={11} strokeWidth={1.8} />
            </button>
            {addMenuOpen && (
              <div className="cv-add-popover" role="menu">
                {ADD_NODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.kind}
                    type="button"
                    className="cv-add-item"
                    role="menuitem"
                    onClick={() => handleAddNode(opt)}
                  >
                    <span className="cv-add-item-icon">
                      <Icon name={opt.icon} size={13} strokeWidth={1.8} />
                    </span>
                    <span className="cv-add-item-label">{opt.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* M2:运行选中节点(子图提交 ComfyUI 执行) */}
          <button
            type="button"
            className="cv-tb-btn cv-run-selected"
            onClick={() => void handleRunSelected()}
            disabled={!hasCanvas || selectedCount === 0 || runningSelected}
            title="运行选中节点(Ctrl/⌘+Enter)"
            aria-label="运行选中节点"
          >
            <Icon name="playing" size={14} strokeWidth={1.8} />
            <span>
              {runningSelected
                ? `执行中 ${runElapsed}s…`
                : selectedCount > 0
                  ? `运行选中(${selectedCount})`
                  : "运行选中"}
            </span>
          </button>
        </div>
      </header>

      {/* ───── 主区域 ───── */}
      <div className="cv-flow-wrap" ref={flowWrapRef}>
        {/* 暗房氛围层:浮尘 + 鼠标视差 + 涟漪(最底层,不响应指针) */}
        <CanvasAmbience ref={ambienceRef} />
        {/* 加载态 */}
        {(canvasesLoading || loading) && (
          <div className="cv-overlay" role="status" aria-live="polite">
            <div className="cv-loading-card">
              <div className="cv-loading-orb" aria-hidden="true" />
              <div className="cv-loading-text">
                {canvasesLoading ? "加载画布列表…" : "加载画布内容…"}
              </div>
            </div>
          </div>
        )}

        {/* 错误态 */}
        {showError && !loading && (
          <div className="cv-overlay">
            <div className="cv-error-card">
              <div className="cv-error-icon">
                <Icon name="error" size={32} strokeWidth={1.5} />
              </div>
              <div className="cv-error-text">
                {canvasesError ?? error ?? "加载画布失败"}
              </div>
              <button
                type="button"
                className="cv-tb-btn cv-tb-btn-primary"
                onClick={() => void loadCanvases()}
              >
                <Icon name="refresh" size={13} strokeWidth={1.8} />
                <span>重试</span>
              </button>
            </div>
          </div>
        )}

        {/* 空态:无画布 */}
        {showEmpty && !showError && (
          <div className="cv-overlay">
            <div className="cv-empty-card">
              <div className="cv-empty-icon">
                <Icon name="canvas" size={48} strokeWidth={1.1} />
              </div>
              <div className="cv-empty-title">尚未创建画布</div>
              <div className="cv-empty-desc">
                无限画布是 ToIV 的自研节点工作流编辑器,支持文本 / 提示词 / 媒体 / LLM / 工作流 / TTS / ASR 等 10 种节点
              </div>
              <button
                type="button"
                className="cv-tb-btn cv-tb-btn-primary"
                onClick={handleNewCanvas}
              >
                <Icon name="create" size={14} strokeWidth={1.8} />
                <span>创建第一个画布</span>
              </button>
            </div>
          </div>
        )}

        {/* ReactFlow 画布(仅当有激活画布时渲染) */}
        {hasCanvas && !showEmpty && (
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onPaneClick={handlePaneClick}
            deleteKeyCode={["Backspace", "Delete"]}
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{
              type: "smoothstep",
              style: { stroke: "var(--accent)", strokeWidth: 1.5 },
            }}
            connectionLineStyle={{
              stroke: "var(--accent-soft)",
              strokeWidth: 2,
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="var(--hairline-strong)" />
            <Controls
              position="bottom-right"
              showInteractive={false}
              showZoom={true}
              showFitView={true}
              fitViewOptions={{ padding: 0.2, duration: 300 }}
            />
            <MiniMap
              position="bottom-left"
              pannable
              zoomable
              maskColor="oklch(7% 0.006 265 / 0.7)"
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--hairline-2)",
                borderRadius: "var(--radius-xs)",
              }}
              onNodeClick={(_, node) => {
                fitBounds({ x: node.position.x - 100, y: node.position.y - 100, width: 400, height: 300 }, { duration: 300 });
              }}
            />
          </ReactFlow>
        )}

        {/* 语音 Agent 浮层条(底部居中) */}
        {hasCanvas && voiceOn && <VoiceBar canvasId={activeCanvasId!} />}
      </div>

      <CanvasViewStyles />
    </div>
  );
}

// ---------- 样式(styled-jsx global:本组件样式由独立组件注入,普通 jsx 模式会因
// styled-jsx 作用域只标记本组件元素而导致选择器全部失配;选择器均以 .canvas-view/.cv- 命名空间隔离) ----------
function CanvasViewStyles() {
  return (
    <style jsx global>{`
      .canvas-view {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--bg-0);
        overflow: hidden;
      }

      /* ───── 顶部工具栏 ───── */
      .cv-toolbar {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: 0.5rem 0.75rem;
        background: var(--bg-1);
        border-bottom: 1px solid var(--hairline);
        z-index: 5;
      }
      .cv-tb-left,
      .cv-tb-right {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }

      .cv-canvas-select {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.3rem 0.5rem;
        background: var(--bg-2);
        border: 1px solid var(--hairline-2);
        border-radius: var(--radius-xs);
        color: var(--accent-soft);
      }
      .cv-canvas-select select {
        background: transparent;
        border: none;
        color: var(--ink);
        font-size: 0.8rem;
        font-family: var(--font-sans);
        font-weight: 500;
        cursor: pointer;
        outline: none;
        min-width: 120px;
        max-width: 220px;
      }
      .cv-canvas-select select option {
        background: var(--bg-1);
        color: var(--ink);
      }

      .cv-tb-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.32rem 0.6rem;
        background: var(--bg-2);
        border: 1px solid var(--hairline-2);
        border-radius: var(--radius-xs);
        color: var(--ink-soft);
        font-size: 0.75rem;
        font-weight: 500;
        font-family: var(--font-sans);
        cursor: pointer;
        transition: color var(--dur) var(--ease),
          background-color var(--dur) var(--ease),
          border-color var(--dur) var(--ease);
      }
      .cv-tb-btn:hover:not(:disabled) {
        color: var(--ink);
        border-color: var(--hairline-strong);
        background: var(--bg-3);
      }
      .cv-tb-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .cv-tb-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }

      .cv-tb-btn-primary {
        background: var(--accent-quiet);
        border-color: var(--accent-line);
        color: var(--accent-soft);
      }
      .cv-tb-btn-primary:hover:not(:disabled) {
        background: linear-gradient(135deg, var(--accent), var(--accent-deep));
        border-color: transparent;
        color: var(--accent-ink);
      }

      .cv-tb-btn-ghost {
        background: transparent;
      }

      .cv-tb-btn-danger {
        color: var(--danger);
      }
      .cv-tb-btn-danger:hover:not(:disabled) {
        background: var(--danger-quiet);
        border-color: var(--danger);
      }

      .cv-tb-btn-voice.is-on {
        background: var(--success-quiet);
        border-color: var(--success);
        color: var(--success);
      }

      /* M2:运行选中 —— 可用时以 accent 弱高亮,暗示可执行动作 */
      .cv-run-selected:not(:disabled) {
        background: var(--accent-quiet);
        border-color: var(--accent-line);
        color: var(--accent-soft);
      }
      .cv-run-selected:not(:disabled):hover {
        background: linear-gradient(135deg, var(--accent), var(--accent-deep));
        border-color: transparent;
        color: var(--accent-ink);
      }

      /* ───── M3.3:子图高亮(克制物理感:柔光环 + 边增亮,无闪烁动画) ───── */
      .react-flow__node.cv-flow-node-hl {
        filter: drop-shadow(0 0 10px color-mix(in oklab, var(--accent) 45%, transparent));
      }
      .react-flow__node.cv-flow-node-hl .toiv-node {
        border-color: var(--accent-line);
        box-shadow: 0 0 0 1px var(--accent-line),
          0 8px 24px -12px color-mix(in oklab, var(--accent) 55%, transparent);
      }
      .react-flow__edge.cv-flow-edge-hl path.react-flow__edge-path {
        stroke: var(--accent-soft);
        stroke-width: 2.2;
        filter: drop-shadow(0 0 4px color-mix(in oklab, var(--accent) 40%, transparent));
      }

      .cv-rename-input {
        padding: 0.32rem 0.55rem;
        background: var(--bg-0);
        border: 1px solid var(--accent);
        border-radius: var(--radius-xs);
        color: var(--ink);
        font-size: 0.78rem;
        font-family: var(--font-sans);
        min-width: 160px;
        outline: none;
        box-shadow: 0 0 0 2px var(--accent-wash);
      }

      /* 添加节点菜单 */
      .cv-add-menu {
        position: relative;
      }
      .cv-add-popover {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        min-width: 168px;
        padding: 0.3rem;
        background: var(--bg-2);
        border: 1px solid var(--hairline-2);
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-lg);
        z-index: 20;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        animation: cv-popover-in var(--dur) var(--ease);
      }
      @keyframes cv-popover-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .cv-add-item {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.4rem 0.5rem;
        background: transparent;
        border: none;
        border-radius: var(--radius-xs);
        color: var(--ink-soft);
        font-size: 0.78rem;
        cursor: pointer;
        text-align: left;
        transition: background-color var(--dur) var(--ease),
          color var(--dur) var(--ease);
      }
      .cv-add-item:hover {
        background: var(--accent-quiet);
        color: var(--accent-soft);
      }
      .cv-add-item-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 4px;
        background: var(--bg-1);
        color: var(--ink-faint);
      }
      .cv-add-item:hover .cv-add-item-icon {
        color: var(--accent-soft);
      }

      /* ───── 主区域 ───── */
      .cv-flow-wrap {
        position: relative;
        flex: 1;
        min-height: 0;
        background: var(--bg-sunken, var(--bg-0));
        /* vignette 暗房感 */
        background-image: radial-gradient(
          ellipse at center,
          transparent 0%,
          transparent 55%,
          oklch(0% 0 0 / 0.35) 100%
        );
      }

      /* 暗房氛围层:浮尘 + 涟漪,最底层、不响应指针 */
      .cv-ambience {
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
      }

      /* 覆盖 ReactFlow 默认背景色 */
      .cv-flow-wrap .react-flow {
        background: transparent;
      }

      /* ReactFlow 控件主题对齐 */
      .cv-flow-wrap .react-flow__controls {
        background: var(--bg-1);
        border: 1px solid var(--hairline-2);
        border-radius: var(--radius-xs);
        box-shadow: var(--shadow-md);
        overflow: hidden;
      }
      .cv-flow-wrap .react-flow__controls-button {
        background: transparent;
        border-bottom: 1px solid var(--hairline);
        color: var(--ink-soft);
        fill: var(--ink-soft);
      }
      .cv-flow-wrap .react-flow__controls-button:hover {
        background: var(--accent-quiet);
        color: var(--accent-soft);
        fill: var(--accent-soft);
      }
      .cv-flow-wrap .react-flow__controls-button svg {
        fill: currentColor;
      }
      .cv-flow-wrap .react-flow__minimap {
        background: var(--bg-1);
      }
      .cv-flow-wrap .react-flow__edge-path {
        stroke: var(--accent);
        stroke-width: 1.5;
        transition: stroke var(--dur) var(--ease),
          stroke-width var(--dur) var(--ease);
      }
      .cv-flow-wrap .react-flow__edge.selected .react-flow__edge-path,
      .cv-flow-wrap .react-flow__edge:hover .react-flow__edge-path {
        stroke: var(--accent-hover);
        stroke-width: 2;
      }
      /* 拖拽连线:柔光引导线 */
      .cv-flow-wrap .react-flow__connection-path {
        filter: drop-shadow(
          0 0 4px color-mix(in oklab, var(--accent) 50%, transparent)
        );
      }
      /* 框选:靛蓝薄纱 */
      .cv-flow-wrap .react-flow__selection,
      .cv-flow-wrap .react-flow__nodesselection-rect {
        background: var(--accent-wash);
        border: 1px solid var(--accent-line);
        border-radius: 2px;
      }
      /* 节点拖拽:物理抬升感 */
      .react-flow__node.dragging .toiv-node {
        border-color: var(--hairline-strong);
        box-shadow: 0 18px 40px -10px oklch(0% 0 0 / 0.65),
          0 0 0 1px var(--accent-line);
      }
      .cv-flow-wrap .react-flow__handle {
        opacity: 0.7;
      }
      .cv-flow-wrap .react-flow__handle:hover {
        opacity: 1;
      }
      .cv-flow-wrap .react-flow__attribution {
        display: none;
      }

      /* ───── 覆盖层(加载 / 错误 / 空态) ───── */
      .cv-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 4;
        background: color-mix(in oklch, var(--bg-0) 85%, transparent);
        backdrop-filter: blur(4px);
      }
      .cv-loading-card,
      .cv-error-card,
      .cv-empty-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.8rem;
        padding: 2rem 2.4rem;
        background: var(--bg-1);
        border: 1px solid var(--hairline-2);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-width: 420px;
        text-align: center;
      }
      .cv-loading-orb {
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: radial-gradient(
          circle at 35% 35%,
          var(--accent-hover),
          var(--accent-deep) 60%,
          transparent 70%
        );
        filter: blur(6px);
        opacity: 0.7;
        animation: cv-orb-breath 2.4s var(--ease) infinite;
      }
      @keyframes cv-orb-breath {
        0%, 100% { transform: scale(1); opacity: 0.7; }
        50% { transform: scale(1.18); opacity: 0.95; }
      }
      .cv-loading-text {
        font-size: 0.82rem;
        color: var(--ink-soft);
        letter-spacing: 0.02em;
      }

      .cv-error-icon {
        color: var(--danger);
        opacity: 0.85;
      }
      .cv-error-text {
        font-size: 0.85rem;
        color: var(--ink-soft);
        line-height: 1.5;
        word-break: break-word;
      }

      .cv-empty-icon {
        color: var(--ink-faint);
        opacity: 0.6;
      }
      .cv-empty-title {
        font-family: var(--font-display);
        font-size: 1.1rem;
        font-weight: 500;
        color: var(--ink);
        letter-spacing: -0.01em;
      }
      .cv-empty-desc {
        font-size: 0.78rem;
        color: var(--ink-faint);
        line-height: 1.6;
        max-width: 320px;
      }

      @media (prefers-reduced-motion: reduce) {
        .cv-loading-orb {
          animation: none;
        }
        .cv-add-popover {
          animation: none;
        }
      }

      /* 移动端:工具栏换行 + 缩小按钮文字 */
      @media (max-width: 768px) {
        .cv-toolbar {
          flex-wrap: wrap;
          gap: 0.3rem;
          padding: 0.4rem 0.5rem;
        }
        .cv-tb-btn span {
          font-size: 0.7rem;
        }
        .cv-canvas-select select {
          min-width: 80px;
          max-width: 140px;
        }
      }
    `}</style>
  );
}
