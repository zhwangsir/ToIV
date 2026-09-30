/**
 * Batch2 视频步:从角色三视图(正/侧/全身)自动收集多参考图 URL。
 * 场景图由调用方追加(sceneImages)。上限 9(H3 Ref2VA)。
 */
import type { StudioCharacter } from "@/lib/api";

const SLOT = ["正", "侧", "全身"] as const;

export type StudioRefSlot = {
  url: string;
  label: string;
  kind: "character" | "scene";
};

export function collectAutoRefSlots(
  characters: StudioCharacter[],
  shotCharacterNames: string[],
  sceneImages: string[] = [],
  maxRefs = 9,
): StudioRefSlot[] {
  const nameSet = new Set(shotCharacterNames);
  const cast =
    nameSet.size > 0
      ? characters.filter((c) => nameSet.has(c.name))
      : characters;
  const out: StudioRefSlot[] = [];
  for (const c of cast) {
    const refs = c.reference_images || [];
    for (let i = 0; i < Math.min(3, refs.length); i++) {
      const url = (refs[i] || "").trim();
      if (!url) continue;
      out.push({
        url,
        label: `${c.name}·${SLOT[i] ?? i + 1}`,
        kind: "character",
      });
      if (out.length >= maxRefs) return out;
    }
  }
  for (let i = 0; i < sceneImages.length; i++) {
    const url = (sceneImages[i] || "").trim();
    if (!url) continue;
    out.push({ url, label: `场景${i + 1}`, kind: "scene" });
    if (out.length >= maxRefs) break;
  }
  return out;
}

export function slotsToUrls(slots: StudioRefSlot[]): string[] {
  return slots.map((s) => s.url).filter(Boolean);
}
