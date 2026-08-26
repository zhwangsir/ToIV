/**
 * 数字人视频生成(AvatarGenPanel)提交载荷构建 —— 纯函数,与 UI 解耦便于单测。
 *
 * 驱动源二选一(后端契约:audio 与 drive_text 互斥,都给或都不给 → 400):
 * - audio:已上传音频句柄(现有路径);
 * - text:drive_text(≤2000 字)经 IndexTTS 合成驱动音频,voice 音色(空=默认)、
 *   speed 语速(0.5-2.0,默认 1.0)。
 * 互斥由本模块保证:按 mode 只产出对应字段,另一组字段绝不出现。
 */
import type { AvatarTalkParams } from "./api";

export type AvatarDriveMode = "audio" | "text";

export const DRIVE_TEXT_MAX = 2000;
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.0;
export const SPEED_DEFAULT = 1.0;

/** 语速夹取到 0.5-2.0(0.05 粒度);非法值回退默认 1.0。 */
export function clampSpeed(n: number): number {
  if (!Number.isFinite(n)) return SPEED_DEFAULT;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n * 20) / 20));
}

/** 驱动源之外的公共字段(与后端 AvatarTalkRequest 对齐)。 */
export interface AvatarTalkBaseArgs {
  image: string;
  worker: string;
  positive: string;
  negative?: string;
  width: number;
  height: number;
  duration_sec: number;
  fps: number;
  steps: number;
  shift: number;
  cfg: number;
  dmd_lora_strength: number;
  seed: number | null;
}

export type AvatarDriveArgs =
  | { mode: "audio"; audio: string }
  | { mode: "text"; driveText: string; voice: string; speed: number };

/** 文本模式可提交判定:非空且 ≤2000 字(UI maxLength 已硬限,此处兜 trim 后为空)。 */
export function driveTextReady(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= DRIVE_TEXT_MAX;
}

/** 组装提交载荷:音频模式字段与历史完全一致;文本模式带 drive_text/voice/speed、无 audio。 */
export function buildAvatarTalkPayload(
  base: AvatarTalkBaseArgs,
  drive: AvatarDriveArgs,
): AvatarTalkParams {
  const negative = base.negative?.trim();
  const payload: AvatarTalkParams = {
    image: base.image,
    worker: base.worker,
    positive: base.positive.trim(),
    ...(negative ? { negative } : {}),
    width: base.width,
    height: base.height,
    duration_sec: base.duration_sec,
    fps: base.fps,
    steps: base.steps,
    shift: base.shift,
    cfg: base.cfg,
    dmd_lora_strength: base.dmd_lora_strength,
    seed: base.seed,
  };
  if (drive.mode === "audio") {
    return { ...payload, audio: drive.audio };
  }
  return {
    ...payload,
    drive_text: drive.driveText.trim(),
    voice: drive.voice.trim(),
    speed: clampSpeed(drive.speed),
  };
}
