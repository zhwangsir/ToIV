import type { StoryboardShot } from "@/lib/api";

/** 每镜出图/转视频的运行态(M1:出图为主,视频按需)。 */
export type ShotStatus = "idle" | "imaging" | "image" | "video" | "error";

/** 分镜卡片在前端的完整态:LLM 分镜 + 本地产物/状态。 */
export interface ShotCard extends StoryboardShot {
  status: ShotStatus;
  /** AI 润色产出的负向提示词,出图时叠加到 NEGATIVE 之上。 */
  negative?: string;
  imageUrl?: string;
  /** 出图后图片所在 worker + 文件名,转视频时复用为关键帧。 */
  imageWorker?: string;
  imageFile?: string;
  videoUrl?: string;
  error?: string;
}

export function toShotCards(shots: StoryboardShot[]): ShotCard[] {
  return shots.map((s) => ({ ...s, status: "idle" }));
}
