// 漫剧草稿箱:把未存盘的导演台工作态自动暂存到 localStorage,刷新/误关后可恢复。
// 与「项目库」(显式存后端)互补 —— 草稿只兜底临时工作,故仅在没有打开正式项目时启用。
import type { CharRow, ShotCard } from "./types";

const KEY = "manju.draft.v1";

export interface ManjuDraft {
  v: 1;
  savedAt: number;
  projectName: string;
  premise: string;
  style: string;
  ckpt: string;
  numShots: number;
  shots: ShotCard[];
  chars: CharRow[];
}

/** 草稿入参(不含版本/时间戳,由 saveDraft 补)。 */
export type ManjuDraftInput = Omit<ManjuDraft, "v" | "savedAt">;

// 运行态字段(出图/配音/进度等纯视觉态)不进草稿:恢复出"出图中"的僵死态没意义。
// 只留 LLM 分镜与已生成的产物 url。
const sanitizeShot = (s: ShotCard): ShotCard => ({
  ...s,
  status: s.imageUrl ? "image" : "idle",
  progress: null,
  runPhase: undefined,
  voicing: false,
  lipSyncing: false,
  error: undefined,
});

const sanitizeChar = (c: CharRow): CharRow => ({
  ...c,
  refStatus: undefined,
  refProgress: null,
  refError: undefined,
  voiceUploading: false,
});

export function loadDraft(): ManjuDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as ManjuDraft;
    return d?.v === 1 ? d : null;
  } catch {
    return null;
  }
}

/** 暂存草稿;空白(无梗概且无分镜)不存,避免覆盖已有草稿。 */
export function saveDraft(d: ManjuDraftInput): void {
  if (typeof window === "undefined") return;
  if (!d.premise.trim() && d.shots.length === 0) return;
  try {
    const payload: ManjuDraft = {
      v: 1,
      savedAt: Date.now(),
      ...d,
      shots: d.shots.map(sanitizeShot),
      chars: d.chars.map(sanitizeChar),
    };
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // 配额满 / 隐私模式禁写:草稿是兜底功能,静默忽略。
  }
}

export function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** 人类可读的"多久前"(草稿恢复条用)。 */
export function draftAge(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
