/**
 * Agent Team 展示元数据与纯函数工具:
 * 状态徽章(图标一律 lucide-react)、kind 中文名、产物/文案/时长提取(对后端字段防御)。
 */
import {
  BadgeCheck,
  CheckCircle2,
  Clock,
  ListOrdered,
  Loader2,
  ShieldCheck,
  Undo2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { AgentRunTask, AgentTaskStatus } from "@/lib/api";

export type StatusTone = "neutral" | "accent" | "ok" | "warn" | "err";

export interface TaskStatusMeta {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
  /** 进行态(图标旋转) */
  spin?: boolean;
}

/** 任务状态 → 徽章(图标按 R3.1 约定:pending=Clock/queued=ListOrdered/running=Loader2/
 *  done=CheckCircle2/error=XCircle/approved=BadgeCheck;verifying/rejected 本期预留)。 */
export const TASK_STATUS_META: Record<AgentTaskStatus, TaskStatusMeta> = {
  pending: { label: "排队中", icon: Clock, tone: "neutral" },
  queued: { label: "已入队", icon: ListOrdered, tone: "neutral" },
  running: { label: "生成中", icon: Loader2, tone: "accent", spin: true },
  verifying: { label: "验收中", icon: ShieldCheck, tone: "warn" },
  rejected: { label: "被打回", icon: Undo2, tone: "err" },
  approved: { label: "已通过", icon: BadgeCheck, tone: "ok" },
  done: { label: "完成", icon: CheckCircle2, tone: "ok" },
  error: { label: "失败", icon: XCircle, tone: "err" },
};

export function taskStatusMeta(status: string): TaskStatusMeta {
  return TASK_STATUS_META[status as AgentTaskStatus] ?? {
    label: status || "未知",
    icon: Clock,
    tone: "neutral",
  };
}

/** run 状态 → 徽章。 */
export const RUN_STATUS_META: Record<string, { label: string; tone: StatusTone }> = {
  planning: { label: "规划中", tone: "accent" },
  awaiting_confirm: { label: "待确认计划", tone: "warn" },
  running: { label: "执行中", tone: "accent" },
  awaiting_assembly: { label: "待确认合成", tone: "warn" },
  done: { label: "已完成", tone: "ok" },
  error: { label: "出错", tone: "err" },
  canceled: { label: "已取消", tone: "neutral" },
};

export function runStatusMeta(status: string): { label: string; tone: StatusTone } {
  return RUN_STATUS_META[status] ?? { label: status || "未知", tone: "neutral" };
}

/** run 终态集合(终态后不再轮询/重连)。 */
export const RUN_TERMINAL = new Set(["done", "error", "canceled"]);

/** kind → 中文名。 */
export const TASK_KIND_LABEL: Record<string, string> = {
  script: "剧本",
  storyboard: "分镜",
  image: "图像",
  video: "视频",
  audio: "音频",
  subtitle: "字幕",
  verify: "验收",
  assemble: "合成",
};

export function taskKindLabel(kind: string): string {
  return TASK_KIND_LABEL[kind] ?? kind;
}

/** 泳道定义(流水线形态):按模态分泳道;未知 kind 落「其他」。 */
export const SWIMLANES: { key: string; label: string; kinds: string[] }[] = [
  { key: "plan", label: "策划", kinds: ["script", "storyboard"] },
  { key: "image", label: "图像", kinds: ["image"] },
  { key: "video", label: "视频", kinds: ["video"] },
  { key: "audio", label: "音频", kinds: ["audio"] },
  { key: "subtitle", label: "字幕", kinds: ["subtitle"] },
  { key: "assemble", label: "合成", kinds: ["verify", "assemble"] },
];

/** kind → 泳道下标(先精确,后包含式匹配如 image_gen;都不中返回 -1 由调用方落「其他」)。 */
export function swimlaneIndex(kind: string): number {
  const exact = SWIMLANES.findIndex((l) => l.kinds.includes(kind));
  if (exact >= 0) return exact;
  return SWIMLANES.findIndex((l) => l.kinds.some((k) => kind.includes(k)));
}

/** 产物提取:对 output 的字段布局做防御(url/video_url/image_url/audio_url/urls[]/text)。 */
export interface TaskMedia {
  kind: "video" | "image" | "audio" | "text" | "none";
  src: string;
  text: string;
}

export function extractTaskMedia(output: Record<string, unknown> | null | undefined): TaskMedia {
  if (!output || typeof output !== "object") return { kind: "none", src: "", text: "" };
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = output[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const video = pick("video_url", "video");
  if (video) return { kind: "video", src: video, text: "" };
  const image = pick("image_url", "image", "thumbnail");
  if (image) return { kind: "image", src: image, text: "" };
  const audio = pick("audio_url", "audio", "voice_url");
  if (audio) return { kind: "audio", src: audio, text: "" };
  const url = pick("url");
  if (url) {
    // 按扩展名粗判媒体类型
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return { kind: "video", src: url, text: "" };
    if (/\.(wav|mp3|flac|ogg|m4a)(\?|$)/i.test(url)) return { kind: "audio", src: url, text: "" };
    return { kind: "image", src: url, text: "" };
  }
  const urls = output.urls;
  if (Array.isArray(urls) && urls.length > 0 && typeof urls[0] === "string") {
    return extractTaskMedia({ url: urls[0] });
  }
  const text = pick("text", "content", "script");
  if (text) return { kind: "text", src: "", text };
  return { kind: "none", src: "", text: "" };
}

/** 任务主文案键(input 文案编辑的绑定字段):优先已知键,否则 prompt。 */
export function primaryInputText(input: Record<string, unknown> | null | undefined): {
  key: string;
  value: string;
} {
  if (input && typeof input === "object") {
    for (const k of ["prompt", "text", "script", "description", "content"]) {
      const v = input[k];
      if (typeof v === "string") return { key: k, value: v };
    }
  }
  return { key: "prompt", value: "" };
}

/** 任务时长(合成门时间线合计用):读 input.duration_sec,非法值归 0。 */
export function taskDurationSec(task: AgentRunTask): number {
  const v = task.input?.duration_sec;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
