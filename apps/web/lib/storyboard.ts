/**
 * 分镜板 v2(M1,2026-09-21)——画板分镜视图的纯函数助手。
 * rowsToPutPayload:整组 PUT 载荷(占位行 job_id="";shot_meta 必须回带防丢);
 * moveRow:上移/下移重排;parseShotMeta:shot_meta JSON 容错解析;triggerDownload:导出下载。
 */
import type { BoardItemOut } from "./api";

/** 整组 PUT 载荷:job 为 null 的占位行写空串;shot_meta/note/shot_text 全量回带。 */
export function rowsToPutPayload(
  rows: BoardItemOut[],
): { job_id: string; note: string; shot_text: string; shot_meta: string }[] {
  return rows.map((it) => ({
    job_id: it.job?.id ?? "",
    note: it.note ?? "",
    shot_text: it.shot_text ?? "",
    shot_meta: it.shot_meta ?? "",
  }));
}

/** 把 from 索引的行移动到 to 索引(越界钳制;from===to 原样返回新数组)。 */
export function moveRow<T>(rows: T[], from: number, to: number): T[] {
  const n = rows.length;
  if (n === 0 || from < 0 || from >= n) return rows.slice();
  const clamped = Math.max(0, Math.min(n - 1, to));
  const next = rows.slice();
  const [row] = next.splice(from, 1);
  next.splice(clamped, 0, row);
  return next;
}

export interface ShotMeta {
  scene?: string;
  prompt?: string;
  negative?: string;
  camera?: string;
  dialogue?: string;
  speaker?: string;
  duration_sec?: number;
  characters?: string[];
  /** M2:角色实体 id(与 characters 同序,rename-safe) */
  entity_ids?: string[];
  render_mode?: string;
}

/** shot_meta JSON 容错解析(空串/坏串 → null)。 */
export function parseShotMeta(shotMeta: string | null | undefined): ShotMeta | null {
  if (!shotMeta) return null;
  try {
    const obj = JSON.parse(shotMeta) as unknown;
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as ShotMeta) : null;
  } catch {
    return null;
  }
}

// ---------- M2 角色一致性:角色条聚合 / 生成引擎 ----------

export interface BoardCharacter {
  /** 去重键:id:<entity_id> 或 name:<角色名> */
  key: string;
  name: string;
  entity_id?: string;
}

/** 聚合整板角色(entity_ids 优先 key,characters 名下放;首现序去重)。 */
export function collectBoardCharacters(items: BoardItemOut[]): BoardCharacter[] {
  const out: BoardCharacter[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const meta = parseShotMeta(it.shot_meta);
    if (!meta) continue;
    const names = (meta.characters ?? []).map((n) => String(n).trim()).filter(Boolean);
    const ids = (meta.entity_ids ?? []).map((i) => String(i).trim()).filter(Boolean);
    const n = Math.max(names.length, ids.length);
    for (let i = 0; i < n; i++) {
      const name = names[i] ?? "";
      const eid = ids[i] ?? "";
      const key = eid ? `id:${eid}` : name ? `name:${name}` : "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, name: name || "(未命名)", entity_id: eid || undefined });
    }
  }
  return out;
}

/** 分镜单镜生成引擎(M2):角色锁定推荐 / 多参考 / 快速兜底。 */
export const GEN_ENGINES = [
  { id: "phantom-s2v", label: "角色锁定", blurb: "Phantom:定妆照参考,跨镜一致性最强(需角色有定妆照)" },
  { id: "h3-r2v", label: "H3 多参考", blurb: "Ref2VA 多图参考(需角色有定妆照)" },
  { id: "h3-t2v", label: "H3 快速", blurb: "无角色也能跑;有定妆照自动带首帧" },
] as const;
export type GenEngineId = (typeof GEN_ENGINES)[number]["id"];

/** localStorage 读/写板级生成引擎选择(非法值回退默认)。 */
export const GEN_ENGINE_KEY = "toiv_board_gen_engine";
export function readGenEngine(): GenEngineId {
  try {
    const v = localStorage.getItem(GEN_ENGINE_KEY);
    const hit = GEN_ENGINES.find((e) => e.id === v);
    return hit ? hit.id : "phantom-s2v";
  } catch {
    return "phantom-s2v";
  }
}

// ---------- M3 一键成片:阶段标签 / 进度推导 ----------

const FILM_STAGE_LABELS: Record<string, string> = {
  videos: "逐镜生成视频",
  voices: "逐镜配音",
  words: "词锚定字幕",
  assemble: "ffmpeg 拼接",
  done: "已完成",
};

export function filmStageLabel(stage: string | null | undefined): string {
  if (!stage) return "排队中";
  return FILM_STAGE_LABELS[stage] ?? stage;
}

/** 进度百分比(0-100;无 progress 或 total=0 → null 显示不定态)。 */
export function filmProgressPct(progress: { done: number; total: number } | null | undefined): number | null {
  if (!progress || !progress.total) return null;
  return Math.round((progress.done / progress.total) * 100);
}

/** 导出文档 Blob 下载(文件名含中文时浏览器自行处理)。 */
export function triggerDownload(filename: string, doc: unknown): void {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
