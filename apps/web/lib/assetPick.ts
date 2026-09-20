/**
 * 资产即输入(2026-09-21 作品库 P3):作品库 → 生成台的媒体直填桥。
 *
 * 作品产物本来就以 {filename, worker} 落在某台 worker 上——与其让用户重新下载
 * 再上传,不如把句柄直接带给引擎台:目标引擎有匹配的媒体参数(image/images/audio/video)
 * 时自动填入(提交链路 filename+worker 直传,免二次上传,天然同 worker 互钉)。
 */
import type { JobItem } from "./types";

export const ASSET_PICK_KEY = "toiv_asset_pick";

export interface AssetPick {
  kind: "image" | "video" | "audio";
  filename: string;
  worker: string;
  /** 原始 /api/images?... 产物 URL(展示/回溯/续写 text 槽直填用)。 */
  url: string;
  /** 来源作品 Job.id(2026-09-21 续写链:longcat-continue 落 continued_from)。 */
  job_id?: string;
}

/** 从作品首个产物解析媒体类型 + 句柄;解析不出返回 null。 */
export function pickFromJob(job: JobItem): AssetPick | null {
  const url = job.results?.[0];
  if (!url || typeof url !== "string") return null;
  const q = new URLSearchParams(url.split("?")[1] ?? "");
  const filename = (q.get("filename") ?? "").trim();
  const worker = (q.get("worker") ?? "").trim();
  if (!filename || !worker) return null;
  const lower = filename.toLowerCase();
  const kind = lower.endsWith(".mp3") || lower.endsWith(".wav") || lower.endsWith(".flac") || lower.endsWith(".ogg")
    ? "audio"
    : lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov") || lower.endsWith(".mkv")
      ? "video"
      : "image";
  return { kind, filename, worker, url, job_id: job.id };
}

export function saveAssetPick(pick: AssetPick): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ASSET_PICK_KEY, JSON.stringify(pick));
  } catch {
    /* 同收藏:写不进就算了 */
  }
}

/**
 * 消费资产暂存:expectedKind 不匹配时返回 null 且【保留】暂存,
 * 让用户换引擎后仍可用;匹配或不限定 kind 时读取并清除。
 */
export function consumeAssetPick(expectedKind?: AssetPick["kind"]): AssetPick | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ASSET_PICK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AssetPick>;
    if (
      typeof parsed.kind !== "string" ||
      typeof parsed.filename !== "string" ||
      typeof parsed.worker !== "string"
    ) {
      window.localStorage.removeItem(ASSET_PICK_KEY);
      return null;
    }
    if (expectedKind && parsed.kind !== expectedKind) return null;
    window.localStorage.removeItem(ASSET_PICK_KEY);
    return parsed as AssetPick;
  } catch {
    return null;
  }
}

/** 丢弃暂存(用户取消/覆盖时)。 */
export function clearAssetPick(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ASSET_PICK_KEY);
  } catch {
    /* ignore */
  }
}
