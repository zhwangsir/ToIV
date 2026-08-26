"use client";

/**
 * H3 多镜头单次生成(对标 Vidu Q3 单 prompt 多镜头 / PixVerse MultiShot)——
 * 纯函数层 + 提交链路。
 *
 * 后端契约(POST /api/h3/multishot,h3_studio.py):
 * 2-4 个镜头(各 prompt 必填,时长 2-8s,总长 ≤15s H3 单段上限)→
 * 「镜头一…镜头二…」协议组装单 prompt → 复用 t2v 提交链路单段成片(音画同发)。
 * 返回标准 GenerateResponse(prompt_id);产物 Job kind=h3_multishot。
 */
import { apiFetch, authHeaders } from "./api";
import type { GenerateResponse } from "./types";

export const MULTISHOT_MIN_SHOTS = 2;
export const MULTISHOT_MAX_SHOTS = 4;
export const MULTISHOT_MIN_SHOT_SEC = 2;
export const MULTISHOT_MAX_SHOT_SEC = 8;
export const MULTISHOT_MAX_TOTAL_SEC = 15;
/** 新镜头默认时长(均分语义由后端在 duration_sec 全空时提供,编辑器恒显式给值)。 */
export const MULTISHOT_DEFAULT_SHOT_SEC = 4;

/** 运镜提示选项(可选;白名单与后端 services/multishot_protocol.CAMERA_HINTS 一致)。 */
export const MULTISHOT_CAMERA_OPTIONS = ["推", "拉", "摇", "移", "跟", "固定"] as const;
/** 转场提示选项(可选,挂在被进入的镜头上;白名单与后端 TRANSITION_HINTS 一致)。 */
export const MULTISHOT_TRANSITION_OPTIONS = ["硬切", "淡入淡出", "匹配切口"] as const;

/** 镜头编辑态(提交前;duration_sec 编辑器内恒有值)。 */
export interface ShotDraft {
  prompt: string;
  durationSec: number;
  cameraHint: string;
  transitionHint: string;
}

/** 逐镜头时长 → 总时长(实时预览;两位小数截断浮点噪声)。 */
export function multishotTotalDuration(durations: number[]): number {
  return Math.round(durations.reduce((acc, d) => acc + d, 0) * 100) / 100;
}

/** 拖拽排序:把 from 位置镜头移到 to(原位/越界 → 原样返回,不抛错)。 */
export function reorderShots<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list;
  }
  const out = [...list];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** 提交门控输入(与编辑器状态同构)。 */
export interface MultiShotSubmittableInput {
  shots: ShotDraft[];
  busy: boolean;
}

/** 提交门控:镜头数/逐镜头时长/总时长/提示词/busy 全过才可提交(后端仍有同源校验兜底)。 */
export function multishotSubmittable(input: MultiShotSubmittableInput): boolean {
  if (input.busy) return false;
  const n = input.shots.length;
  if (n < MULTISHOT_MIN_SHOTS || n > MULTISHOT_MAX_SHOTS) return false;
  if (input.shots.some((s) => !s.prompt.trim())) return false;
  if (
    input.shots.some(
      (s) => s.durationSec < MULTISHOT_MIN_SHOT_SEC || s.durationSec > MULTISHOT_MAX_SHOT_SEC,
    )
  ) {
    return false;
  }
  if (multishotTotalDuration(input.shots.map((s) => s.durationSec)) > MULTISHOT_MAX_TOTAL_SEC) {
    return false;
  }
  return true;
}

export interface MultiShotSubmitInput {
  shots: ShotDraft[];
  width?: number;
  height?: number;
  steps?: number;
  seed?: number | null;
}

/** 提交多镜头生成:POST /api/h3/multishot(与 _postH3 同模式,422 展开首条校验信息)。 */
export async function submitMultiShot(input: MultiShotSubmitInput): Promise<GenerateResponse> {
  const { shots } = input;
  if (shots.length < MULTISHOT_MIN_SHOTS || shots.length > MULTISHOT_MAX_SHOTS) {
    throw new Error(
      `镜头数须为 ${MULTISHOT_MIN_SHOTS}-${MULTISHOT_MAX_SHOTS} 个(当前 ${shots.length} 个)`,
    );
  }
  if (shots.some((s) => !s.prompt.trim())) throw new Error("每镜头提示词不能为空");
  const body: Record<string, unknown> = {
    shots: shots.map((s) => ({
      prompt: s.prompt.trim(),
      duration_sec: s.durationSec,
      ...(s.cameraHint ? { camera_hint: s.cameraHint } : {}),
      ...(s.transitionHint ? { transition_hint: s.transitionHint } : {}),
    })),
    width: input.width ?? 1344,
    height: input.height ?? 768,
    steps: input.steps ?? 20,
  };
  if (typeof input.seed === "number" && Number.isInteger(input.seed) && input.seed >= 0) {
    body.seed = input.seed;
  }
  const res = await apiFetch("/api/h3/multishot", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const msg = Array.isArray(detail?.detail)
      ? ((detail.detail[0] as { msg?: string } | undefined)?.msg ?? "多镜头请求参数校验失败")
      : typeof detail?.detail === "string"
        ? detail.detail
        : `多镜头提交失败 (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}
