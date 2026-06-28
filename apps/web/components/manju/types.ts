import type { StoryboardShot } from "@/lib/api";

/** 每镜出图/转视频的运行态(M1:出图为主,视频按需)。 */
export type ShotStatus = "idle" | "imaging" | "image" | "video" | "error";

/**
 * 角色登记行:名字 + 设定,可附一张参考图(走 IPAdapter 做人物一致性)。
 * refImage = 参考图文件名;refWorker = 该文件所在 worker(出图时一并传给 renderManjuShot)。
 */
export interface CharRow {
  name: string;
  desc: string;
  /** 参考图文件名(IPAdapter 人物一致性);缺省则该角色镜头走普通 txt2img。 */
  refImage?: string;
  /** 参考图所在 worker(与 refImage 成对,逐镜出图时复用)。 */
  refWorker?: string;
  /** 参考图生成中标记(纯视觉,不影响数据流)。 */
  refStatus?: "idle" | "imaging" | "error";
  /** 参考图生成失败信息。 */
  refError?: string;
}

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
  /** 逐镜配音(TTS 合成台词)的 wav URL;成片时按镜序对齐混入对白轨。 */
  voiceUrl?: string;
  /** 配音合成中标记(纯视觉,不影响数据流)。 */
  voicing?: boolean;
  error?: string;
}

export function toShotCards(shots: StoryboardShot[]): ShotCard[] {
  return shots.map((s) => ({ ...s, status: "idle" }));
}

/**
 * 资产 @引用 注入:把镜头出场角色的 danbooru 固定描述并入出图提示词,实现角色一致性。
 * 角色描述锚定在前(主体先定),镜头描述在后;danbooru 标签去重(保序,大小写不敏感)。
 * 无引用或角色无描述时,原样返回镜头描述。纯函数,无副作用。
 */
export function composeShotPrompt(
  description: string,
  shotCharacters: readonly string[],
  registry: readonly CharRow[],
): string {
  const names = new Set(shotCharacters.map((n) => n.trim()).filter(Boolean));
  const refDesc = registry
    .filter((c) => names.has(c.name.trim()) && c.desc.trim())
    .map((c) => c.desc.trim());
  if (refDesc.length === 0) return description;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of [...refDesc, description].join(", ").split(",")) {
    const tag = chunk.trim();
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out.join(", ");
}
