"use client";

/**
 * 关键帧链式转场(对标 Pika 2.5 Pikaframes)—— 纯函数层 + 提交链路。
 *
 * 后端契约(POST /api/generate/keyframe-chain,wan_studio.py):
 * 2-5 张关键帧(链序)→ N-1 段首尾帧转场(Wan2.1-VACE :8197,复用 transition 链路)
 * → 后台 ffmpeg 拼接整条视频(单段 1-10s,总长 ≤25s)。
 * 返回合并作业(chain-* 合成 prompt_id)+ 各段 transition 作业 prompt_id 序列,
 * 前端据此轮询段进度(chainProgress)。
 */
import { apiFetch, authHeaders } from "./api";
import type { JobItem } from "./types";

export const CHAIN_MIN_FRAMES = 2;
export const CHAIN_MAX_FRAMES = 5;
export const CHAIN_MIN_SEG_SEC = 1;
export const CHAIN_MAX_SEG_SEC = 10;
export const CHAIN_MAX_TOTAL_SEC = 25;
/** durations 缺省时后端按每段 5s 均分(与 transition 默认一致)。 */
export const CHAIN_DEFAULT_SEG_SEC = 5;

/** 关键帧句柄(经 /api/upload 或作品库转运得到,与上传组件句柄同构)。 */
export interface ChainFrameHandle {
  filename: string;
  worker: string;
}

/** 段时长列表 → 总时长(实时预览;两位小数截断浮点噪声)。 */
export function chainTotalDuration(durations: number[]): number {
  return Math.round(durations.reduce((acc, d) => acc + d, 0) * 100) / 100;
}

/** 拖拽排序:把 from 位置元素移到 to(原位/越界 → 原样返回,不抛错)。 */
export function reorderSlots<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list;
  }
  const out = [...list];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** 段提示词组装:逐段覆盖全空 → 单 string 全段共用;否则逐段(空段回退共享)。 */
export function buildChainPrompts(shared: string, segPrompts: string[]): string | string[] {
  const base = shared.trim();
  const segs = segPrompts.map((p) => p.trim());
  if (segs.every((p) => !p)) return base;
  return segs.map((p) => p || base);
}

/** 提交门控输入(与编辑器状态同构)。 */
export interface ChainSubmittableInput {
  /** 已填关键帧数(2-5)。 */
  frames: number;
  /** 共享提示词(全段共用)。 */
  sharedPrompt: string;
  /** 逐段提示词覆盖(长度 = frames - 1,可空)。 */
  segPrompts: string[];
  /** 逐段时长(长度 = frames - 1,每段 1-10s,总长 ≤25s)。 */
  durations: number[];
  busy: boolean;
}

/** 提交门控:帧数/段时长/总时长/提示词/busy 全过才可提交(后端仍有同源校验兜底)。 */
export function chainSubmittable(input: ChainSubmittableInput): boolean {
  if (input.busy) return false;
  if (input.frames < CHAIN_MIN_FRAMES || input.frames > CHAIN_MAX_FRAMES) return false;
  if (input.durations.some((d) => d < CHAIN_MIN_SEG_SEC || d > CHAIN_MAX_SEG_SEC)) return false;
  if (chainTotalDuration(input.durations) > CHAIN_MAX_TOTAL_SEC) return false;
  if (input.sharedPrompt.trim()) return true;
  const segs = input.segPrompts.map((p) => p.trim());
  return segs.length > 0 && segs.every((p) => p.length > 0);
}

export interface KeyframeChainSubmitInput {
  /** 关键帧(链序,全部互钉同 worker)。 */
  keyframes: ChainFrameHandle[];
  /** 单 string 全段共用 / list 逐段(空段回退共享,组装见 buildChainPrompts)。 */
  prompts: string | string[];
  /** 逐段时长(缺省后端每段 5s 均分)。 */
  durations?: number[];
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number | null;
}

export interface KeyframeChainSubmitResponse {
  /** 合并作业 id(chain-* 合成占位,拼接完成后回写整条成片)。 */
  prompt_id: string;
  worker: string;
  seed: number | null;
  /** 各段 transition 作业 prompt_id(链序;held 时为 hold-* 占位)。 */
  segments: string[];
  total_duration: number;
  held?: boolean;
  hold_reason?: string;
}

/** 提交关键帧链:POST /api/generate/keyframe-chain(与 _postWan 同模式,422 展开首条校验信息)。 */
export async function submitKeyframeChain(
  input: KeyframeChainSubmitInput,
): Promise<KeyframeChainSubmitResponse> {
  const { keyframes, prompts } = input;
  if (keyframes.length < CHAIN_MIN_FRAMES || keyframes.length > CHAIN_MAX_FRAMES) {
    throw new Error(`关键帧须为 ${CHAIN_MIN_FRAMES}-${CHAIN_MAX_FRAMES} 张(当前 ${keyframes.length} 张)`);
  }
  const promptOk =
    typeof prompts === "string"
      ? prompts.trim().length > 0
      : prompts.some((p) => p.trim().length > 0);
  if (!promptOk) throw new Error("请填写转场提示词(共享或逐段)");
  const worker = keyframes[0].worker;
  if (!keyframes.every((k) => k.worker === worker)) {
    throw new Error("全部关键帧须在同一 worker(请移除跨机帧后重传)");
  }
  const body: Record<string, unknown> = {
    keyframes: keyframes.map((k) => k.filename),
    prompts: typeof prompts === "string" ? prompts.trim() : prompts.map((p) => p.trim()),
    worker,
    width: input.width ?? 832,
    height: input.height ?? 480,
    steps: input.steps ?? 20,
    cfg: input.cfg ?? 5,
  };
  if (input.durations && input.durations.length > 0) body.durations = input.durations;
  if (typeof input.seed === "number" && Number.isInteger(input.seed) && input.seed >= 0) {
    body.seed = input.seed;
  }
  const res = await apiFetch("/api/generate/keyframe-chain", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = Array.isArray(detail?.detail)
      ? ((detail.detail[0] as { msg?: string } | undefined)?.msg ?? "关键帧链请求参数校验失败")
      : typeof detail?.detail === "string"
        ? detail.detail
        : `关键帧链提交失败 (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

export interface ChainProgressInfo {
  /** 已完成段数(段作业 status=done 计数)。 */
  segDone: number;
  segTotal: number;
  /** held=资源排队;running=生成/拼接中;done=成片就绪;error=任一段或合并失败。 */
  status: "running" | "done" | "error" | "held";
  resultUrl: string | null;
}

/** 段进度解析:按段 prompt_id + 合并 id 从作业列表推导(busy 态轮询显示用,纯函数)。 */
export function chainProgress(
  jobs: JobItem[],
  segmentIds: string[],
  mergedId: string,
): ChainProgressInfo {
  const byId = new Map(jobs.map((j) => [j.prompt_id, j]));
  const segJobs = segmentIds
    .map((id) => byId.get(id))
    .filter((j): j is JobItem => j !== undefined);
  const segDone = segJobs.filter((j) => j.status === "done").length;
  const merged = byId.get(mergedId);
  if (merged?.status === "done") {
    return {
      segDone,
      segTotal: segmentIds.length,
      status: "done",
      resultUrl: merged.results[0] ?? null,
    };
  }
  if (merged?.status === "error" || segJobs.some((j) => j.status === "error")) {
    return { segDone, segTotal: segmentIds.length, status: "error", resultUrl: null };
  }
  if (merged?.status === "held" || segJobs.some((j) => j.status === "held")) {
    return { segDone, segTotal: segmentIds.length, status: "held", resultUrl: null };
  }
  return { segDone, segTotal: segmentIds.length, status: "running", resultUrl: null };
}
