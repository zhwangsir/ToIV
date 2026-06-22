/** 创作画布:高层节点的数据模型与共享常量。
 *  理念:用"创作级"节点(文本/图片/视频/音频)代替 ComfyUI 底层技术节点。
 *  数据流靠端口连线:text → image → video,音频独立。 */

import type { Node, Edge } from "@xyflow/react";

/** 节点类型(同时也是 React Flow nodeType 注册键)。 */
export type CanvasNodeType = "text" | "image" | "video" | "audio";

/** 端口的数据语义:决定哪些口能连到哪些口。 */
export type PortKind = "text" | "image" | "video";

/** 单个节点的运行态(生成进度 / 产物)。 */
export interface NodeRunState {
  busy: boolean;
  stage: string;
  /** 真实采样进度 0-100;null = 不确定态(走动画进度条)。 */
  progress: number | null;
  error: string | null;
  /** 产物可访问 URL(图片/视频/音频);文本节点不产 URL。 */
  outputUrl: string | null;
  /** 产物画幅(供下游图生视频沿用比例)。 */
  outputWidth?: number;
  outputHeight?: number;
}

export const EMPTY_RUN: NodeRunState = {
  busy: false,
  stage: "",
  progress: null,
  error: null,
  outputUrl: null,
};

// ── 各节点的 data 形状 ──────────────────────────────────────
//   React Flow v12 要求节点 data 满足 Record<string, unknown>;
//   故各 data 接口带索引签名(BaseNodeData),保留具名字段的类型安全。

interface BaseNodeData {
  [key: string]: unknown;
}

export interface TextNodeData extends BaseNodeData {
  /** 提示词文本(也是该节点 text 输出口的值)。 */
  prompt: string;
}

export interface ImageNodeData extends BaseNodeData {
  /** 节点自带的本地提示词(无上游文本连线时使用)。 */
  prompt: string;
  ckpt: string;
  width: number;
  height: number;
  run: NodeRunState;
}

export interface VideoNodeData extends BaseNodeData {
  prompt: string;
  width: number;
  height: number;
  length: number;
  fps: number;
  run: NodeRunState;
}

export interface AudioNodeData extends BaseNodeData {
  prompt: string;
  seconds: number;
  run: NodeRunState;
}

export type AnyNodeData =
  | TextNodeData
  | ImageNodeData
  | VideoNodeData
  | AudioNodeData;

/** 画布持久化的轻量快照(localStorage)。 */
export interface CanvasDraft {
  nodes: Node[];
  edges: Edge[];
  version: 1;
}

// ── 默认值 ──────────────────────────────────────────────────

export function defaultData(type: CanvasNodeType): AnyNodeData {
  switch (type) {
    case "text":
      return { prompt: "" } satisfies TextNodeData;
    case "image":
      return {
        prompt: "",
        ckpt: "",
        width: 768,
        height: 768,
        run: { ...EMPTY_RUN },
      } satisfies ImageNodeData;
    case "video":
      return {
        prompt: "",
        width: 832,
        height: 480,
        length: 81,
        fps: 16,
        run: { ...EMPTY_RUN },
      } satisfies VideoNodeData;
    case "audio":
      return { prompt: "", seconds: 30, run: { ...EMPTY_RUN } } satisfies AudioNodeData;
  }
}

/** 节点输出口的数据语义(audio 无输出口)。 */
export const OUTPUT_KIND: Record<CanvasNodeType, PortKind | null> = {
  text: "text",
  image: "image",
  video: "video",
  audio: null,
};

/** 一条边是否合法:目标节点入口能否接受源节点输出。 */
export function canConnect(
  sourceType: CanvasNodeType,
  targetType: CanvasNodeType,
): boolean {
  const out = OUTPUT_KIND[sourceType];
  if (!out) return false;
  if (targetType === "image") return out === "text" || out === "image";
  if (targetType === "video") return out === "text" || out === "image";
  if (targetType === "audio") return out === "text";
  return false; // text 节点无入口
}

export const NODE_META: Record<
  CanvasNodeType,
  { icon: string; label: string; hint: string }
> = {
  text: { icon: "📝", label: "文本", hint: "提示词 → 下游" },
  image: { icon: "📷", label: "图片", hint: "文生图 / 图生图" },
  video: { icon: "🎬", label: "视频", hint: "图生视频 / 文生视频" },
  audio: { icon: "🎵", label: "音频", hint: "文生音乐" },
};

export const IMG_SIZES = [
  { key: "1:1", label: "1:1", w: 768, h: 768 },
  { key: "3:2", label: "横 3:2", w: 960, h: 640 },
  { key: "2:3", label: "竖 2:3", w: 640, h: 960 },
  { key: "16:9", label: "宽 16:9", w: 896, h: 512 },
] as const;

export const VID_SIZES = [
  { key: "16:9", label: "横 16:9", w: 832, h: 480 },
  { key: "1:1", label: "1:1", w: 480, h: 480 },
  { key: "9:16", label: "竖 9:16", w: 480, h: 832 },
] as const;

export const VID_LENGTHS = [
  { v: 49, label: "~3s" },
  { v: 81, label: "~5s" },
  { v: 121, label: "~7.5s" },
] as const;

export const AUDIO_SECONDS = [15, 30, 60, 120] as const;

export const DEFAULT_NEGATIVE =
  "blurry, lowres, deformed, watermark, text, extra limbs";

let _seq = 0;
export const nextNodeId = (): string =>
  `n-${Date.now().toString(36)}-${_seq++}`;
