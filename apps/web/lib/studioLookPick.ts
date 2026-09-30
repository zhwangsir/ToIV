/**
 * Batch3:出图卡 → 短剧角色一键定妆桥。
 * 生图完成点「定妆」暂存 URL;资产步消费后写入角色三视图。
 */
export const LOOK_PICK_KEY = "toiv_studio_look_pick";

export interface StudioLookPick {
  url: string;
  /** 可选句柄(作品库/转运产物) */
  filename?: string;
  worker?: string;
}

export function saveLookPick(pick: StudioLookPick): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOOK_PICK_KEY, JSON.stringify(pick));
  } catch {
    /* ignore */
  }
}

export function peekLookPick(): StudioLookPick | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOOK_PICK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudioLookPick>;
    if (typeof parsed.url !== "string" || !parsed.url.trim()) {
      window.localStorage.removeItem(LOOK_PICK_KEY);
      return null;
    }
    return parsed as StudioLookPick;
  } catch {
    return null;
  }
}

export function consumeLookPick(): StudioLookPick | null {
  const pick = peekLookPick();
  if (!pick) return null;
  clearLookPick();
  return pick;
}

export function clearLookPick(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LOOK_PICK_KEY);
  } catch {
    /* ignore */
  }
}

/** 将 1~3 张图填入正/侧/全身槽(不足补空串保序)。 */
export function fillThreeViewSlots(urls: string[]): string[] {
  const cleaned = urls.map((u) => (u || "").trim()).filter(Boolean).slice(0, 3);
  return [cleaned[0] || "", cleaned[1] || "", cleaned[2] || ""];
}
