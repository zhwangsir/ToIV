/** 创作画布:高层节点的数据模型与共享常量。
 *  理念:用"创作级"节点(文本/图片/视频/音频)代替 ComfyUI 底层技术节点。
 *  数据流靠端口连线:text → image → video,音频独立。 */

import type { Node, Edge } from "@xyflow/react";

/** 节点类型(同时也是 React Flow nodeType 注册键)。
 *  v2 新增结构化高层节点:
 *   - storyboard 分镜:剧情 → 多镜剧本(接漫剧线,复用 /api/manju/storyboard)
 *   - character  角色三视图:一句设定 → 正/侧/背 turnaround 提示词 + 出图
 *   - lighting   打光预设:选光型 → 光照提示词片段叠到下游图像
 *   - threed     图→3D:复用 generate3D */
export type CanvasNodeType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "storyboard"
  | "character"
  | "lighting"
  | "threed"
  // v3 图像处理节点(接已有后端能力,均需上游 image 输入,产 image)
  | "img2img" // 重绘:上游图 + 提示词 + denoise → 图
  | "controlnet" // 构图控制:上游图作控制图 + 提示词 + 控制类型 → 图
  | "ipadapter"; // 角色一致:上游图作参考 + 提示词 → 人物一致图

/** 端口的数据语义:决定哪些口能连到哪些口。
 *  storyboard / lighting 产出 text 语义(剧本 / 光照片段),可灌入下游图像与视频;
 *  threed 仅做终点(产 glb,无下游连线语义)。 */
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
  /** NSFW 档:开启后模型下拉只列 nsfw 标记的底模(后端字段缺失则回退全部)。 */
  nsfw: boolean;
  run: NodeRunState;
}

export interface VideoNodeData extends BaseNodeData {
  prompt: string;
  width: number;
  height: number;
  length: number;
  fps: number;
  /** NSFW 档(视频底模目前后端只读,开关仅作意图标记 + 未来筛选)。 */
  nsfw: boolean;
  run: NodeRunState;
}

export interface AudioNodeData extends BaseNodeData {
  prompt: string;
  seconds: number;
  run: NodeRunState;
}

// ── v2 结构化高层节点 data ───────────────────────────────────

/** 分镜节点产出的单镜(精简自 lib/api StoryboardShot,仅留画布需要的字段)。 */
export interface StoryboardShotData {
  id: string;
  scene: string;
  description: string;
  camera: string;
  dialogue: string;
}

/** 📋 分镜节点:剧情 premise → 多镜剧本。输出口 text(把分镜文本灌入下游)。 */
export interface StoryboardNodeData extends BaseNodeData {
  premise: string;
  numShots: number;
  style: string;
  /** 已生成的分镜(持久化展示;运行态进度走 run)。 */
  shots: StoryboardShotData[];
  run: NodeRunState;
}

/** 角色三视图朝向预设(turnaround)。 */
export type CharacterView = "front" | "side" | "back";

/** 🧍 角色三视图节点:一句设定 → 正/侧/背 turnaround 提示词 + 出图。
 *  输出口 image(把选定视角出图灌入下游图生图/图生视频)。 */
export interface CharacterNodeData extends BaseNodeData {
  /** 角色设定(一句话)。 */
  brief: string;
  ckpt: string;
  /** 当前出图采用的视角(决定 turnaround 提示词与产物)。 */
  view: CharacterView;
  nsfw: boolean;
  run: NodeRunState;
}

/** 🔦 打光预设节点:选光型 → 输出光照提示词片段(text 语义,叠到下游图像)。 */
export interface LightingNodeData extends BaseNodeData {
  /** 选定的光型预设 key(见 LIGHTING_PRESETS)。 */
  preset: string;
  /** 强度档:微妙 / 标准 / 戏剧化。 */
  intensity: "subtle" | "standard" | "dramatic";
}

/** 🧊 3D 节点:入口 image(连图片/角色节点)→ glb。输出口无(终点)。 */
export interface ThreeDNodeData extends BaseNodeData {
  steps: number;
  octree: number;
  run: NodeRunState;
}

// ── v3 图像处理高层节点 data(均需上游 image 输入)──────────────

/** 🖌 重绘节点:上游图 + 提示词 + denoise(重绘强度)→ 图。接 /generate/img2img。 */
export interface Img2imgNodeData extends BaseNodeData {
  prompt: string;
  ckpt: string;
  /** 重绘强度 0-1:越高越偏离原图。 */
  denoise: number;
  nsfw: boolean;
  run: NodeRunState;
}

/** 🧭 构图控制节点:上游图作控制图 + 提示词 + 控制类型(canny/depth/lineart/openpose)
 *  + 强度 → 图。接 /generate/controlnet。 */
export interface ControlNetNodeData extends BaseNodeData {
  prompt: string;
  ckpt: string;
  controlType: string;
  /** 控制强度 0-2。 */
  strength: number;
  nsfw: boolean;
  run: NodeRunState;
}

/** 🪞 角色一致节点:上游图作参考(IPAdapter)+ 提示词 → 人物一致图。接 /manju/shot。 */
export interface IPAdapterNodeData extends BaseNodeData {
  prompt: string;
  ckpt: string;
  /** 参考强度 0-1。 */
  weight: number;
  nsfw: boolean;
  run: NodeRunState;
}

export type AnyNodeData =
  | TextNodeData
  | ImageNodeData
  | VideoNodeData
  | AudioNodeData
  | StoryboardNodeData
  | CharacterNodeData
  | LightingNodeData
  | ThreeDNodeData
  | Img2imgNodeData
  | ControlNetNodeData
  | IPAdapterNodeData;

/** ControlNet 控制类型(与后端 controlnet.py 枚举对齐)。 */
export const CONTROL_TYPES: { key: string; label: string }[] = [
  { key: "canny", label: "边缘 Canny" },
  { key: "depth", label: "深度 Depth" },
  { key: "lineart", label: "线稿 Lineart" },
  { key: "openpose", label: "姿态 Pose" },
];

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
        nsfw: false,
        run: { ...EMPTY_RUN },
      } satisfies ImageNodeData;
    case "video":
      return {
        prompt: "",
        width: 832,
        height: 480,
        length: 81,
        fps: 16,
        nsfw: false,
        run: { ...EMPTY_RUN },
      } satisfies VideoNodeData;
    case "audio":
      return { prompt: "", seconds: 30, run: { ...EMPTY_RUN } } satisfies AudioNodeData;
    case "storyboard":
      return {
        premise: "",
        numShots: 6,
        style: "电影感",
        shots: [],
        run: { ...EMPTY_RUN },
      } satisfies StoryboardNodeData;
    case "character":
      return {
        brief: "",
        ckpt: "",
        view: "front",
        nsfw: false,
        run: { ...EMPTY_RUN },
      } satisfies CharacterNodeData;
    case "lighting":
      return {
        preset: LIGHTING_PRESETS[0].key,
        intensity: "standard",
      } satisfies LightingNodeData;
    case "threed":
      return {
        steps: 30,
        octree: 256,
        run: { ...EMPTY_RUN },
      } satisfies ThreeDNodeData;
    case "img2img":
      return {
        prompt: "",
        ckpt: "",
        denoise: 0.55,
        nsfw: false,
        run: { ...EMPTY_RUN },
      } satisfies Img2imgNodeData;
    case "controlnet":
      return {
        prompt: "",
        ckpt: "",
        controlType: CONTROL_TYPES[0].key,
        strength: 1.0,
        nsfw: false,
        run: { ...EMPTY_RUN },
      } satisfies ControlNetNodeData;
    case "ipadapter":
      return {
        prompt: "",
        ckpt: "",
        weight: 0.8,
        nsfw: false,
        run: { ...EMPTY_RUN },
      } satisfies IPAdapterNodeData;
  }
}

/** 节点输出口的数据语义(audio / threed 无输出口)。
 *  storyboard / character / lighting 输出语义:
 *   - storyboard → text(分镜文本可灌入下游图像/视频)
 *   - character  → image(选定视角出图)
 *   - lighting   → text(光照提示词片段) */
export const OUTPUT_KIND: Record<CanvasNodeType, PortKind | null> = {
  text: "text",
  image: "image",
  video: "video",
  audio: null,
  storyboard: "text",
  character: "image",
  lighting: "text",
  threed: null,
  img2img: "image",
  controlnet: "image",
  ipadapter: "image",
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
  // v3 图像处理:需要 image 输入(源图/控制图/参考图),也可接 text 提示词。
  if (targetType === "img2img" || targetType === "controlnet" || targetType === "ipadapter") {
    return out === "text" || out === "image";
  }
  // 角色三视图入口:接 text(角色设定来自上游文本/分镜)。
  if (targetType === "character") return out === "text";
  // 3D 入口:接 image(图片/角色节点产物 → 三维)。
  if (targetType === "threed") return out === "image";
  // text / storyboard / lighting 无入口(管线起点)。
  return false;
}

export const NODE_META: Record<
  CanvasNodeType,
  { icon: string; label: string; hint: string }
> = {
  text: { icon: "📝", label: "文本", hint: "提示词 → 下游" },
  image: { icon: "📷", label: "图片", hint: "文生图 / 图生图" },
  video: { icon: "🎬", label: "视频", hint: "图生视频 / 文生视频" },
  audio: { icon: "🎵", label: "音频", hint: "文生音乐" },
  storyboard: { icon: "📋", label: "分镜", hint: "剧情 → 多镜剧本" },
  character: { icon: "🧍", label: "角色三视图", hint: "设定 → 正/侧/背" },
  lighting: { icon: "🔦", label: "打光预设", hint: "光型 → 叠到下游图像" },
  threed: { icon: "🧊", label: "3D", hint: "图 → 三维网格" },
  img2img: { icon: "🖌", label: "重绘", hint: "上游图 + 提示词 → 重绘" },
  controlnet: { icon: "🧭", label: "构图控制", hint: "控制图 → 锁构图出图" },
  ipadapter: { icon: "🪞", label: "角色一致", hint: "参考图 → 人物一致" },
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

// ── v2 结构节点常量 ─────────────────────────────────────────

/** 分镜可选镜数。 */
export const STORYBOARD_SHOT_COUNTS = [4, 6, 8, 12] as const;

/** 角色三视图朝向预设:朝向 key + 中文标签 + turnaround 提示词片段。 */
export const CHARACTER_VIEWS: {
  key: CharacterView;
  label: string;
  prompt: string;
}[] = [
  { key: "front", label: "正视", prompt: "front view, facing camera, T-pose" },
  { key: "side", label: "侧视", prompt: "side view profile, full body turnaround" },
  { key: "back", label: "背视", prompt: "back view, rear turnaround, full body" },
];

/** 角色三视图通用约束(保证一致性、白底、全身)。 */
export const CHARACTER_BASE_PROMPT =
  "character sheet, model sheet, full body, consistent character design, " +
  "neutral background, clean lineart, reference turnaround";

/** 打光预设:光型 key + 中文标签 + 叠加到下游图像的提示词片段。 */
export const LIGHTING_PRESETS: {
  key: string;
  label: string;
  prompt: string;
}[] = [
  { key: "rembrandt", label: "伦勃朗光", prompt: "Rembrandt lighting, dramatic chiaroscuro, soft key light" },
  { key: "rim", label: "轮廓光", prompt: "rim light, backlight, glowing edge separation" },
  { key: "softbox", label: "柔光箱", prompt: "soft diffused studio softbox lighting, even illumination" },
  { key: "golden", label: "黄金时刻", prompt: "golden hour sunlight, warm directional light, long shadows" },
  { key: "neon", label: "霓虹", prompt: "neon cyberpunk lighting, magenta and cyan glow, moody" },
  { key: "cinematic", label: "电影感", prompt: "cinematic lighting, volumetric light, high contrast, teal and orange" },
];

/** 打光强度档:档位 → 叠加到提示词的修饰词。 */
export const LIGHTING_INTENSITY: Record<
  LightingNodeData["intensity"],
  { label: string; modifier: string }
> = {
  subtle: { label: "微妙", modifier: "subtle" },
  standard: { label: "标准", modifier: "" },
  dramatic: { label: "戏剧化", modifier: "highly dramatic, strong" },
};

/** 把打光节点的预设 + 强度合成成可叠加的提示词片段(空字符串表示无叠加)。 */
export function lightingFragment(data: LightingNodeData): string {
  const preset = LIGHTING_PRESETS.find((p) => p.key === data.preset);
  if (!preset) return "";
  const mod = LIGHTING_INTENSITY[data.intensity]?.modifier ?? "";
  return mod ? `${mod} ${preset.prompt}` : preset.prompt;
}

/** 把角色节点的设定 + 选定视角合成成 turnaround 出图提示词。 */
export function characterPrompt(data: CharacterNodeData): string {
  const view = CHARACTER_VIEWS.find((v) => v.key === data.view);
  const brief = data.brief.trim();
  const parts = [brief, view?.prompt ?? "", CHARACTER_BASE_PROMPT].filter(Boolean);
  return parts.join(", ");
}

export const THREED_STEPS = [20, 30, 50] as const;
export const THREED_OCTREE = [128, 256, 384] as const;

export const DEFAULT_NEGATIVE =
  "blurry, lowres, deformed, watermark, text, extra limbs";

let _seq = 0;
export const nextNodeId = (): string =>
  `n-${Date.now().toString(36)}-${_seq++}`;
