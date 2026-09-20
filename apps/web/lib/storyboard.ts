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
