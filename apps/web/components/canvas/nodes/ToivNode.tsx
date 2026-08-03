"use client";

import { memo, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useCanvasStore } from "@/lib/canvas/store";
import type {
  CanvasNodeData,
  CanvasNodeKind,
  CanvasNodeStatus,
  ToivFlowNode,
} from "@/lib/canvas/types";
import { TextNodeBody } from "./TextNode";
import { PromptNodeBody } from "./PromptNode";
import { ImageNodeBody } from "./ImageNode";
import { VideoNodeBody } from "./VideoNode";
import { AudioNodeBody } from "./AudioNode";
import { Model3DNodeBody } from "./Model3DNode";
import { LLMNodeBody } from "./LLMNode";
import { ComfyWorkflowNodeBody } from "./ComfyWorkflowNode";
import { TTSNodeBody } from "./TTSNode";
import { ASRNodeBody } from "./ASRNode";

// ---------- kind → 图标 ----------
const KIND_ICON: Record<CanvasNodeKind, IconName> = {
  text: "file",
  prompt: "sparkles",
  image: "image",
  video: "video",
  audio: "audio",
  model3d: "model3d",
  llm: "chat",
  comfy_workflow: "canvas",
  tts: "mic",
  asr: "audio",
};

// ---------- kind → 中文标签 ----------
const KIND_LABEL: Record<CanvasNodeKind, string> = {
  text: "文本",
  prompt: "提示词",
  image: "图像",
  video: "视频",
  audio: "音频",
  model3d: "3D",
  llm: "LLM",
  comfy_workflow: "工作流",
  tts: "TTS",
  asr: "ASR",
};

// ---------- 可执行节点(显示运行按钮)----------
const EXECUTABLE_KINDS = new Set<CanvasNodeKind>([
  "llm",
  "comfy_workflow",
  "tts",
  "asr",
]);

// ---------- kind → body 派发 ----------
function renderBody(data: CanvasNodeData, nodeId: string) {
  switch (data.kind) {
    case "text":
      return <TextNodeBody data={data} nodeId={nodeId} />;
    case "prompt":
      return <PromptNodeBody data={data} nodeId={nodeId} />;
    case "image":
      return <ImageNodeBody data={data} nodeId={nodeId} />;
    case "video":
      return <VideoNodeBody data={data} nodeId={nodeId} />;
    case "audio":
      return <AudioNodeBody data={data} nodeId={nodeId} />;
    case "model3d":
      return <Model3DNodeBody data={data} nodeId={nodeId} />;
    case "llm":
      return <LLMNodeBody data={data} nodeId={nodeId} />;
    case "comfy_workflow":
      return <ComfyWorkflowNodeBody data={data} nodeId={nodeId} />;
    case "tts":
      return <TTSNodeBody data={data} nodeId={nodeId} />;
    case "asr":
      return <ASRNodeBody data={data} nodeId={nodeId} />;
    default:
      return null;
  }
}

// ---------- 节点渲染组件 ----------
function ToivNodeComponentImpl(props: NodeProps<ToivFlowNode>) {
  const { data, selected, id } = props;
  const runNode = useCanvasStore((s) => s.runNode);
  const onRun = useCallback(() => {
    void runNode(id);
  }, [id, runNode]);

  const status: CanvasNodeStatus = data.status ?? "idle";
  const iconName = KIND_ICON[data.kind];
  const kindLabel = KIND_LABEL[data.kind];
  const executable = EXECUTABLE_KINDS.has(data.kind);

  return (
    <div
      className={`toiv-node tn-status-${status}${selected ? " is-selected" : ""}`}
      data-kind={data.kind}
    >
      <Handle type="target" position={Position.Left} className="tn-handle" />
      <div className="tn-header">
        <span className="tn-icon" aria-hidden="true">
          <Icon name={iconName} size={14} strokeWidth={1.8} />
        </span>
        <span className="tn-kind">{kindLabel}</span>
        <span className="tn-title" title={data.title}>
          {data.title}
        </span>
        {executable && (
          <button
            type="button"
            className={`tn-run${status === "running" ? " is-running" : ""}`}
            onClick={onRun}
            disabled={status === "running"}
            aria-label="运行节点"
            title={status === "running" ? "运行中…" : "运行节点"}
          >
            <Icon name={status === "running" ? "loading" : "playing"} size={12} strokeWidth={2} />
          </button>
        )}
        <span
          className="tn-status-dot"
          role="img"
          aria-label={`状态: ${status}`}
        />
      </div>
      <div className="tn-body">{renderBody(data, id)}</div>
      {data.error && (
        <div className="tn-error" title={data.error}>
          {data.error}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="tn-handle" />

      {/* 共享节点样式(:global 让子组件 className 直接受控;全部走 canonical token) */}
      <style jsx global>{`
        .toiv-node {
          min-width: 200px;
          max-width: 380px;
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          box-shadow: var(--shadow-md);
          font-family: var(--font-sans);
          font-size: 0.78rem;
          color: var(--text-primary);
          transition: border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .toiv-node:hover {
          border-color: var(--border-strong);
        }
        .toiv-node.is-selected {
          border-color: var(--accent);
          box-shadow: 0 0 0 1px var(--accent),
            0 8px 24px -4px var(--accent-glow);
        }

        /* 节点卡片状态:运行 run 描边+脉冲 / 完成 ok / 失败 err */
        .toiv-node.tn-status-running {
          border-color: var(--run);
          animation: tn-card-run 1.6s var(--ease-standard) infinite;
        }
        .toiv-node.tn-status-done {
          border-color: var(--ok);
        }
        .toiv-node.tn-status-error {
          border-color: var(--err);
        }
        @keyframes tn-card-run {
          0%,
          100% {
            box-shadow: 0 0 0 0 var(--run-soft);
          }
          50% {
            box-shadow: 0 0 0 5px transparent;
          }
        }

        .tn-header {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.4rem 0.55rem;
          border-bottom: 1px solid var(--border-subtle);
          background: var(--bg-surface-2);
          border-radius: var(--radius-panel) var(--radius-panel) 0 0;
        }
        .tn-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: var(--radius-badge);
          background: var(--accent-soft);
          color: var(--accent);
          flex-shrink: 0;
        }
        .tn-kind {
          font-family: var(--font-mono);
          font-size: 0.62rem;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--text-muted);
          flex-shrink: 0;
        }
        .tn-title {
          flex: 1;
          min-width: 0;
          font-weight: 600;
          font-size: 0.78rem;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .tn-run {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          flex-shrink: 0;
          border-radius: var(--radius-control);
          color: var(--accent);
          background: var(--accent-soft);
          border: 1px solid var(--accent-glow);
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .tn-run:hover:not(:disabled) {
          color: var(--text-on-accent);
          background: var(--accent-hover);
          border-color: transparent;
        }
        .tn-run:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .tn-run:focus-visible {
          outline: 1px solid var(--accent);
          outline-offset: 2px;
        }

        .tn-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
          background: var(--text-muted);
        }
        .toiv-node.tn-status-idle .tn-status-dot {
          background: var(--text-muted);
        }
        .toiv-node.tn-status-running .tn-status-dot {
          background: var(--run);
          /* 纯 CSS 脉冲动画,不占 React 渲染循环;速度 ≤ 1.2s(项目硬约束) */
          animation: tn-breath 1.2s var(--ease-standard) infinite;
        }
        .toiv-node.tn-status-done .tn-status-dot {
          background: var(--ok);
          box-shadow: 0 0 6px
            color-mix(in oklch, var(--ok) 60%, transparent);
        }
        .toiv-node.tn-status-error .tn-status-dot {
          background: var(--err);
        }
        @keyframes tn-breath {
          0%,
          100% {
            opacity: 1;
            transform: scale(1);
            box-shadow: 0 0 0 0 var(--run-soft);
          }
          50% {
            opacity: 0.5;
            transform: scale(0.85);
            box-shadow: 0 0 0 6px transparent;
          }
        }

        .tn-body {
          padding: 0.55rem;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .tn-error {
          padding: 0.35rem 0.55rem;
          background: var(--err-soft);
          color: var(--err);
          font-size: 0.7rem;
          border-top: 1px solid
            color-mix(in oklch, var(--err) 30%, transparent);
          border-radius: 0 0 var(--radius-panel) var(--radius-panel);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* ---------- 共享子组件样式 ---------- */
        .tn-field {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
        }
        .tn-field-label {
          font-size: 0.64rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          letter-spacing: 0.03em;
          text-transform: uppercase;
        }
        .tn-input,
        .tn-textarea {
          width: 100%;
          padding: 0.35rem 0.45rem;
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: 0.74rem;
          font-family: var(--font-sans);
          line-height: 1.45;
          resize: vertical;
          transition: border-color var(--duration-fast) var(--ease-standard);
        }
        .tn-input:focus,
        .tn-textarea:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 2px var(--accent-soft);
        }
        .tn-textarea {
          font-family: var(--font-mono);
          font-size: 0.7rem;
        }
        .tn-input::placeholder,
        .tn-textarea::placeholder {
          color: var(--text-muted);
        }

        .tn-media {
          position: relative;
          width: 100%;
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 80px;
        }
        .tn-media img,
        .tn-media video {
          width: 100%;
          height: auto;
          display: block;
        }
        .tn-media-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.3rem;
          padding: 1.2rem 0.6rem;
          color: var(--text-muted);
          font-size: 0.7rem;
        }
        .tn-media-loading {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: color-mix(in oklch, var(--bg-canvas) 70%, transparent);
          color: var(--accent);
        }

        .tn-link {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.35rem 0.55rem;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--accent);
          font-size: 0.72rem;
          text-decoration: none;
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .tn-link:hover {
          border-color: var(--accent-glow);
          background: var(--accent-soft);
        }

        .tn-response {
          padding: 0.4rem 0.5rem;
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-secondary);
          font-size: 0.72rem;
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 160px;
          overflow-y: auto;
        }
        .tn-response-empty {
          color: var(--text-muted);
          font-style: italic;
        }

        .tn-file-row {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          flex-wrap: wrap;
        }
        .tn-file-name {
          font-family: var(--font-mono);
          font-size: 0.68rem;
          color: var(--text-secondary);
          padding: 0.2rem 0.4rem;
          background: var(--bg-surface-2);
          border-radius: var(--radius-badge);
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tn-file-pick {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.3rem 0.5rem;
          background: var(--bg-surface-2);
          border: 1px dashed var(--border-strong);
          border-radius: var(--radius-control);
          color: var(--text-secondary);
          font-size: 0.7rem;
          cursor: pointer;
          transition: border-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .tn-file-pick:hover {
          border-color: var(--accent-glow);
          color: var(--accent);
        }

        /* Handle 样式覆盖 @xyflow/react 默认 */
        .tn-handle {
          width: 8px;
          height: 8px;
          background: var(--accent);
          border: 2px solid var(--bg-canvas);
          border-radius: 50%;
        }
        .tn-handle:hover {
          background: var(--accent-hover);
        }

        @media (prefers-reduced-motion: reduce) {
          .toiv-node.tn-status-running {
            animation: none;
          }
          .toiv-node.tn-status-running .tn-status-dot {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

// ---------- 自定义 props 比较:拖动/视口变化时不重渲染节点 ----------
// NodeProps(@xyflow/react v12,@xyflow/system)含字段:
//   id / data / width / height / sourcePosition / targetPosition / dragHandle /
//   parentId / type / dragging / zIndex / selectable / deletable / selected /
//   draggable / isConnectable / positionAbsoluteX / positionAbsoluteY
// 节点位置由 ReactFlow 的 NodeWrapper 通过 transform 处理,positionAbsoluteX/Y
// 变化不需要节点内容重渲染;zIndex / width / height(实测尺寸)同样不影响内容。
// 只比较:身份(id)、交互态(selected / dragging / isConnectable)、
// 以及 data 的关键字段(kind / title / status / error / payload 引用 / width / height)。
function toivNodePropsAreEqual(
  prev: NodeProps<ToivFlowNode>,
  next: NodeProps<ToivFlowNode>,
): boolean {
  if (
    prev.id !== next.id ||
    prev.selected !== next.selected ||
    prev.dragging !== next.dragging ||
    prev.isConnectable !== next.isConnectable
  ) {
    return false;
  }
  const pd = prev.data;
  const nd = next.data;
  if (pd === nd) return true;
  return (
    pd.kind === nd.kind &&
    pd.title === nd.title &&
    pd.status === nd.status &&
    pd.error === nd.error &&
    pd.payload === nd.payload &&
    pd.width === nd.width &&
    pd.height === nd.height
  );
}

export const ToivNodeComponent = memo(
  ToivNodeComponentImpl,
  toivNodePropsAreEqual,
);
