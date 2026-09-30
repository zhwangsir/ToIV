/**
 * Batch2/3 视频步:从角色三视图(正/侧/全身)自动收集多参考图 URL。
 * 项目绑定场景图 + 本镜追加场景图一并并入。上限 9(H3 Ref2VA)。
 */
import type { StudioCharacter } from "@/lib/api";

const SLOT = ["正", "侧", "全身"] as const;

export type StudioRefSlot = {
  url: string;
  label: string;
  kind: "character" | "scene";
};

/** 合并项目绑定场景图与本镜追加,去重保序,最多 maxScene 张。 */
export function mergeSceneImages(
  bound: string[] = [],
  extra: string[] = [],
  maxScene = 4,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of [...bound, ...extra]) {
    const url = (u || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= maxScene) break;
  }
  return out;
}

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
