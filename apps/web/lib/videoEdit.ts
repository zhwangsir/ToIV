"use client";

/**
 * VACE 视频到视频编辑(Runway Aleph 式 in-context 编辑)—— 纯函数层 + 提交链路。
 *
 * 后端契约(POST /api/generate/video-edit,wan_studio.py):
 * 源视频(上传句柄,≤10s)+ 英文编辑指令 + 编辑模式 → :8197 VACE in-context 编辑;
 * 可选 ≤5 关键帧锚点(0 基帧索引,锚点帧整帧保留,内容向全片传播)与区域保留 mask
 * (白色区域保留;与源视频同 worker 互钉,提交时由后端转运)。
 * 返回 prompt_id,前端据此轮询作业(editJobProgress),成片 done 内联播放。
 */
import { apiFetch, authHeaders } from "./api";
import type { JobItem } from "./types";

/** 编辑模式(与后端 workflows/wan_vace.EDIT_MODES 一一对应)。 */
export const EDIT_MODES = [
  {
    value: "object_replace",
    label: "对象替换",
    hint: "把画面中的某个对象换成另一个,其余保持不变",
    placeholder:
      "replace the red car with a white bicycle, keep everything else unchanged",
  },
  {
    value: "object_remove",
    label: "对象移除",
    hint: "抹掉画面中的某个对象,背景自然补全",
    placeholder: "remove the person in the background, fill the scene naturally",
  },
  {
    value: "style_transfer",
    label: "风格迁移",
    hint: "整片换成目标风格(动漫/油画/赛博朋克等),内容构图不变",
    placeholder: "turn the footage into watercolor anime style, same composition",
  },
  {
    value: "relight",
    label: "重打光",
    hint: "改变光照氛围(黄昏/夜晚/霓虹),场景与动作不变",
    placeholder: "relight the scene to a rainy neon night, keep the action identical",
  },
  {
    value: "camera_change",
    label: "相机变换",
    hint: "改变机位/视角(俯视/环绕/特写),主体与动作不变",
    placeholder: "same scene from a top-down aerial view, keep the subject motion",
  },
] as const;

export type EditMode = (typeof EDIT_MODES)[number]["value"];

/** 关键帧锚点上限(对标 Aleph 2.0 ≤5;后端同源约束)。 */
export const EDIT_MAX_KEYFRAMES = 5;
/** 源视频/输出时长上限(秒;编辑链路全帧上下文,显存压力大)。 */
export const EDIT_MAX_DURATION_SEC = 10;

export function isEditMode(v: string): v is EditMode {
  return (EDIT_MODES as readonly { value: string }[]).some((m) => m.value === v);
}

/** 播放时刻(秒)→ 输出帧索引(0 基;与后端 force_rate 重采样后的帧空间一致)。 */
export function timeToFrameIndex(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.floor(seconds * fps);
}

/** 关键帧锚点切换:已存在则移除,否则升序插入;超过上限原样返回(调用方给提示)。 */
export function toggleKeyframe(list: number[], idx: number, max: number = EDIT_MAX_KEYFRAMES): number[] {
  if (list.includes(idx)) return list.filter((k) => k !== idx);
  if (list.length >= max) return list;
  return [...list, idx].sort((a, b) => a - b);
}

/** 手工输入帧索引("0, 40, 80")→ 排序去重数组;非法/超上限抛错(提交门控兜底)。 */
export function parseKeyframeIndices(text: string): number[] {
  const raw = text.trim();
  if (!raw) return [];
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`帧索引「${p}」须为非负整数`);
    }
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > EDIT_MAX_KEYFRAMES) {
    throw new Error(`关键帧锚点最多 ${EDIT_MAX_KEYFRAMES} 个(当前 ${out.length} 个)`);
  }
  return out.sort((a, b) => a - b);
}

/** 提交门控输入(与编辑器状态同构)。 */
export interface EditSubmittableInput {
  /** 源视频已就绪(上传/作品库句柄)。 */
  hasVideo: boolean;
  /** 编辑指令(英文;trim 后非空)。 */
  editPrompt: string;
  /** 输出时长(秒,≤10)。 */
  durationSec: number;
  /** 关键帧锚点(0 基帧索引)。 */
  keyframes: number[];
  busy: boolean;
}

/** 提交门控:源视频/指令/时长/关键帧上限/busy 全过才可提交(后端仍有同源校验兜底)。 */
export function editSubmittable(input: EditSubmittableInput): boolean {
  if (input.busy || !input.hasVideo) return false;
  if (!input.editPrompt.trim()) return false;
  if (!(input.durationSec > 0) || input.durationSec > EDIT_MAX_DURATION_SEC) return false;
  if (input.keyframes.length > EDIT_MAX_KEYFRAMES) return false;
  return true;
}

/** 上传/作品库句柄(与 RefVideoUpload 的 UploadedVideo 同构)。 */
export interface VideoHandle {
  filename: string;
  worker: string;
}

export interface VideoEditSubmitInput {
  /** 源视频(与区域 mask 互钉同 worker)。 */
  sourceVideo: VideoHandle;
  /** 英文编辑指令(只描述要改的内容)。 */
  editPrompt: string;
  editMode: EditMode;
  /** 关键帧锚点(0 基,≤5;缺省不传)。 */
  keyframeIndices?: number[];
  /** 区域保留 mask(白色区域保留;与源视频同 worker;缺省不传)。 */
  preserveMask?: VideoHandle | null;
  width?: number;
  height?: number;
  durationSec?: number;
  steps?: number;
  cfg?: number;
  fps?: number;
  seed?: number | null;
}

export interface VideoEditSubmitResponse {
  prompt_id: string;
  worker: string;
  seed: number | null;
  held?: boolean;
  hold_reason?: string;
  duration_notice?: string;
}

/** 提交视频编辑:POST /api/generate/video-edit(与 _postWan 同模式,422 展开首条校验信息)。 */
export async function submitVideoEdit(
  input: VideoEditSubmitInput,
): Promise<VideoEditSubmitResponse> {
  const { sourceVideo, editPrompt, editMode, preserveMask } = input;
  if (!sourceVideo.filename) throw new Error("请先上传或选择源视频");
  if (!editPrompt.trim()) throw new Error("请填写编辑指令(英文,只描述要改的内容)");
  if (!isEditMode(editMode)) throw new Error("未知编辑模式");
  const kfs = input.keyframeIndices ?? [];
  if (kfs.length > EDIT_MAX_KEYFRAMES) {
    throw new Error(`关键帧锚点最多 ${EDIT_MAX_KEYFRAMES} 个`);
  }
  if (preserveMask && preserveMask.worker !== sourceVideo.worker) {
    throw new Error("区域保留 mask 须与源视频在同一 worker(请移除后重传)");
  }
  const body: Record<string, unknown> = {
    source_video: sourceVideo.filename,
    edit_prompt: editPrompt.trim(),
    edit_mode: editMode,
    worker: sourceVideo.worker,
    width: input.width ?? 832,
    height: input.height ?? 480,
    steps: input.steps ?? 20,
    cfg: input.cfg ?? 5,
    fps: input.fps ?? 16,
  };
  if (typeof input.durationSec === "number" && input.durationSec > 0) {
    body.duration_sec = input.durationSec;
  }
  if (kfs.length > 0) body.keyframe_indices = kfs;
  if (preserveMask) body.preserve_mask = preserveMask.filename;
  if (typeof input.seed === "number" && Number.isInteger(input.seed) && input.seed >= 0) {
    body.seed = input.seed;
  }
  const res = await apiFetch("/api/generate/video-edit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = Array.isArray(detail?.detail)
      ? ((detail.detail[0] as { msg?: string } | undefined)?.msg ?? "视频编辑请求参数校验失败")
      : typeof detail?.detail === "string"
        ? detail.detail
        : `视频编辑提交失败 (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

export interface EditProgressInfo {
  /** held=资源排队;running=生成中;done=成片就绪;error=失败;pending=作业未入列表。 */
  status: "pending" | "running" | "done" | "error" | "held";
  resultUrl: string | null;
}

/** 编辑作业进度解析:按 prompt_id 从作业列表推导(busy 态轮询显示用,纯函数)。 */
export function editJobProgress(jobs: JobItem[], promptId: string): EditProgressInfo {
  const job = jobs.find((j) => j.prompt_id === promptId);
  if (!job) return { status: "pending", resultUrl: null };
  if (job.status === "done") {
    return { status: "done", resultUrl: job.results[0] ?? null };
  }
  if (job.status === "error") return { status: "error", resultUrl: null };
  if (job.status === "held") return { status: "held", resultUrl: null };
  return { status: "running", resultUrl: null };
}
