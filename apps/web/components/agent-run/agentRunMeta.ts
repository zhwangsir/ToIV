/**
 * Agent Team 展示元数据与纯函数工具:
 * 状态徽章(图标一律经 ui/Icon 键)、kind 中文名、产物/文案/时长提取(对后端字段防御)。
 */
import type { IconName } from "@/components/ui/Icon";
import type { AgentRunTask, AgentTaskStatus } from "@/lib/api";

export type StatusTone = "neutral" | "accent" | "ok" | "warn" | "err";

export interface TaskStatusMeta {
  label: string;
  icon: IconName;
  tone: StatusTone;
  /** 进行态(图标旋转) */
  spin?: boolean;
}

/** 任务状态 → 徽章(图标按 R3.1 约定:pending=clock/queued=list-ordered/running=loading/
 *  done=success/error=x-circle/approved=badge-check;verifying/rejected 本期预留)。 */
export const TASK_STATUS_META: Record<AgentTaskStatus, TaskStatusMeta> = {
  pending: { label: "排队中", icon: "clock", tone: "neutral" },
  queued: { label: "已入队", icon: "list-ordered", tone: "neutral" },
  running: { label: "生成中", icon: "loading", tone: "accent", spin: true },
  verifying: { label: "验收中", icon: "shield-check", tone: "warn" },
  rejected: { label: "被打回", icon: "undo", tone: "err" },
  approved: { label: "已通过", icon: "badge-check", tone: "ok" },
  done: { label: "完成", icon: "success", tone: "ok" },
  error: { label: "失败", icon: "x-circle", tone: "err" },
};

export function taskStatusMeta(status: string): TaskStatusMeta {
  return TASK_STATUS_META[status as AgentTaskStatus] ?? {
    label: status || "未知",
    icon: "clock",
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

/** verdict 渲染守卫:契约是 string,但存量/异常数据可能是对象
 *  (后端曾把 {"error": msg} 直出,React #31 整页崩溃根因)。
 *  对象时提取 summary/reason/text/error/message 首个非空文本,都没有则 JSON 展开。 */
export function verdictText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of ["summary", "reason", "text", "error", "message"]) {
      const s = (v as Record<string, unknown>)[k];
      if (typeof s === "string" && s.trim()) return s;
    }
    if (Object.keys(v).length === 0) return ""; // 空对象归空(历史默认 {} 崩溃根因)
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
}

/** goal 轻量 markdown 剥离(列表/详情直渲用):
 *  去粗体/斜体/行内码/行首 # 标题/链接语法,保持可读纯文本;压平空白成单行。 */
export function stripMarkdown(text: unknown): string {
  if (typeof text !== "string") return "";
  return (
    text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [文本](链接) → 文本
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // **粗体** / *斜体* / _强调_
      .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // `代码` / ```片段```
      .replace(/^\s{0,3}#{1,6}\s+/gm, "") // 行首 # 标题标记
      .replace(/\s+/g, " ") // 多行/多余空白压平(卡片单行展示)
      .trim()
  );
}
