/** 画布模块类型定义 —— 与后端 models.py 的 Canvas/CanvasNode/CanvasEdge 对齐。
 *
 * 节点统一 10 种 kind,与后端 payload 结构一一对应(见 models.py 注释)。
 * ToivNode 直接对齐 @xyflow/react 的 Node<CanvasNodeData> 类型,无需转换。
 */

// ---------- 节点 kind 枚举 ----------
export type CanvasNodeKind =
  | "text" // 纯文本笔记
  | "prompt" // 提示词输入
  | "image" // 图片产物
  | "video" // 视频产物
  | "audio" // 音频产物
  | "model3d" // 3D 模型产物
  | "llm" // LLM 对话节点
  | "comfy_workflow" // ComfyUI 工作流
  | "tts" // TTS 合成节点
  | "asr"; // ASR 听写节点

// ---------- 节点执行态 ----------
export type CanvasNodeStatus = "idle" | "running" | "done" | "error";

// ---------- payload 联合类型(按 kind 不同结构不同) ----------
export interface TextPayload {
  text: string;
}
export interface PromptPayload {
  text: string;
  negative?: string;
}
export interface MediaPayload {
  urls: string[];
}
export interface LLMPayload {
  text: string; // 用户输入
  response?: string; // LLM 回复
}
export interface ComfyWorkflowPayload {
  graph: Record<string, { class_type: string; inputs?: Record<string, unknown> }>;
  summary?: string;
}
export interface TTSPayload {
  text: string;
  ref_audio?: string;
  emo_text?: string;
  emo_alpha?: number;
  url?: string; // 合成后的音频 URL
}
export interface ASRPayload {
  audio_url?: string;
  text?: string; // 听写结果
}

export type CanvasNodePayload =
  | TextPayload
  | PromptPayload
  | MediaPayload
  | LLMPayload
  | ComfyWorkflowPayload
  | TTSPayload
  | ASRPayload;

// ---------- @xyflow/react 节点数据 ----------
// 注:索引签名 [key: string]: unknown 是 @xyflow/react v12 的 Node<T> 约束
// (T 必须满足 Record<string, unknown>)。这里不改变任何已有字段的语义,
// 仅追加索引签名以让 ToivFlowNode = Node<CanvasNodeData, "toiv"> 通过类型检查。
export interface CanvasNodeData {
  kind: CanvasNodeKind;
  title: string;
  status: CanvasNodeStatus;
  error?: string;
  payload: CanvasNodePayload;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

// ---------- 后端模型(Python SQLModel 的 TS 镜像) ----------
export interface Canvas {
  id: string;
  name: string;
  voice_active: boolean;
  default_ref_audio: string;
  created_at: string;
  updated_at: string;
}

export interface CanvasNode {
  id: string;
  canvas_id: string;
  kind: CanvasNodeKind;
  title: string;
  position_x: number;
  position_y: number;
  width?: number | null;
  height?: number | null;
  payload: string; // JSON 串,前端解析为 CanvasNodePayload
  status: CanvasNodeStatus;
  error: string;
  parent_ids: string; // JSON 数组串
  created_at: string;
  updated_at: string;
}

export interface CanvasEdge {
  id: string;
  canvas_id: string;
  source: string;
  target: string;
  source_handle: string;
  target_handle: string;
  label: string;
}

// ---------- API 响应(含节点和边的画布完整快照) ----------
export interface CanvasSnapshot {
  canvas: Canvas;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

// ---------- 前端 @xyflow/react 节点/边类型 ----------
import type { Edge, Node } from "@xyflow/react";

export type ToivFlowNode = Node<CanvasNodeData, "toiv">;
export type ToivFlowEdge = Edge<{ label?: string }>;

// ---------- 转换工具:后端 CanvasNode → 前端 ToivFlowNode ----------
export function toFlowNode(n: CanvasNode): ToivFlowNode {
  let payload: CanvasNodePayload;
  try {
    payload = JSON.parse(n.payload) as CanvasNodePayload;
  } catch {
    payload = { text: "" } as TextPayload;
  }
  return {
    id: n.id,
    type: "toiv",
    position: { x: n.position_x, y: n.position_y },
    data: {
      kind: n.kind as CanvasNodeKind,
      title: n.title,
      status: n.status as CanvasNodeStatus,
      error: n.error || undefined,
      payload,
      width: n.width ?? undefined,
      height: n.height ?? undefined,
    },
    width: n.width ?? undefined,
    height: n.height ?? undefined,
  };
}

export function toFlowEdge(e: CanvasEdge): ToivFlowEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.source_handle || undefined,
    targetHandle: e.target_handle || undefined,
    label: e.label || undefined,
    data: { label: e.label },
  };
}

// ---------- 节点默认尺寸(前端渲染用) ----------
export const NODE_DEFAULT_SIZE: Record<CanvasNodeKind, { width: number; height: number }> = {
  text: { width: 280, height: 160 },
  prompt: { width: 320, height: 200 },
  image: { width: 320, height: 320 },
  video: { width: 360, height: 280 },
  audio: { width: 280, height: 120 },
  model3d: { width: 320, height: 280 },
  llm: { width: 360, height: 240 },
  comfy_workflow: { width: 400, height: 280 },
  tts: { width: 320, height: 180 },
  asr: { width: 320, height: 160 },
};
