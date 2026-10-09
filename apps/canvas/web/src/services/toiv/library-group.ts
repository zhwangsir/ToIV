/** 作品库详情：变体/批次折叠（对齐主站 libraryQuery.groupLibraryEntries）。 */
import type { ToivBoardItem } from "./client";

const SYSTEM_KIND_PREFIXES = ["app_cover", "app_smoke"];

export type BoardJob = NonNullable<ToivBoardItem["job"]>;

export type BoardFolder = {
    key: string;
    members: ToivBoardItem[];
    /** true = kind+seed+prompt 变体组；false = batch_id 内容组 */
    variant: boolean;
};

export type BoardEntry =
    | { type: "item"; item: ToivBoardItem }
    | { type: "folder"; folder: BoardFolder };

/** 变体组键：同 kind+seed+prompt；seed 空/系统 kind 不参与。 */
export function variantKeyOf(job: BoardJob): string {
    if (job.seed === null || job.seed === undefined) return "";
    const kind = job.kind ?? "";
    if (SYSTEM_KIND_PREFIXES.some((p) => kind.startsWith(p))) return "";
    const p = (job.prompt ?? "").trim();
    return `v:${kind}:${job.seed}:${p}`;
}

export function groupBoardEntries(
    items: readonly ToivBoardItem[],
    opts: { groupVariants?: boolean } = {},
): BoardEntry[] {
    const byBatch = new Map<string, ToivBoardItem[]>();
    for (const it of items) {
        const b = it.job?.batch_id;
        if (!b) continue;
        const g = byBatch.get(b);
        if (g) g.push(it);
        else byBatch.set(b, [it]);
    }

    const byVariant = new Map<string, ToivBoardItem[]>();
    if (opts.groupVariants) {
        for (const it of items) {
            if (it.job?.batch_id) continue;
            if (!it.job) continue;
            const vk = variantKeyOf(it.job);
            if (!vk) continue;
            const g = byVariant.get(vk);
            if (g) g.push(it);
            else byVariant.set(vk, [it]);
        }
    }

    const emitted = new Set<string>();
    const out: BoardEntry[] = [];
    for (const it of items) {
        const batchId = it.job?.batch_id;
        if (batchId) {
            if (emitted.has(batchId)) continue;
            emitted.add(batchId);
            const members = byBatch.get(batchId) ?? [it];
            if (members.length >= 2) {
                out.push({ type: "folder", folder: { key: batchId, members, variant: false } });
            } else {
                out.push({ type: "item", item: members[0]! });
            }
            continue;
        }
        if (opts.groupVariants && it.job) {
            const vk = variantKeyOf(it.job);
            if (vk) {
                const members = byVariant.get(vk) ?? [it];
                if (members.length >= 2) {
                    if (emitted.has(vk)) continue;
                    emitted.add(vk);
                    out.push({ type: "folder", folder: { key: vk, members, variant: true } });
                    continue;
                }
            }
        }
        out.push({ type: "item", item: it });
    }
    return out;
}

/** 回收站剩余保留期中文。 */
export function formatRetention(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "已到期";
    const min = 60;
    const hr = 3600;
    const day = 86400;
    if (seconds < hr) return `剩 ${Math.max(1, Math.ceil(seconds / min))} 分钟`;
    if (seconds < day) return `剩 ${Math.floor(seconds / hr)} 小时`;
    const d = Math.floor(seconds / day);
    const h = Math.floor((seconds % day) / hr);
    return h > 0 ? `剩 ${d} 天 ${h} 小时` : `剩 ${d} 天`;
}

export function folderCover(folder: BoardFolder): ToivBoardItem {
    return (
        folder.members.find((m) => m.job?.status === "done" && (m.job.results?.length ?? 0) > 0) ??
        folder.members[0]!
    );
}

/** 预览/动作用媒体类别。 */
export type LibraryMediaKind = "image" | "video" | "audio" | "unknown";

export type LibraryMedia = {
    url: string;
    kind: LibraryMediaKind;
};

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|flac|aac)(\?|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)(\?|$)/i;

const VIDEO_KINDS = new Set(["video", "t2v", "i2v", "orbit", "r2v", "s2v", "longcat", "vace", "animate", "continue", "avatar", "wan"]);
const AUDIO_KINDS = new Set(["audio", "tts", "music", "sfx", "voice"]);
const IMAGE_KINDS = new Set(["image", "t2i", "i2i", "inpaint", "upscale"]);

/** 由 URL 与可选 job.kind 判定媒体类别。 */
export function classifyMediaUrl(url: string, jobKind?: string | null): LibraryMediaKind {
    const u = (url || "").trim();
    if (!u) return "unknown";
    if (VIDEO_EXT.test(u)) return "video";
    if (AUDIO_EXT.test(u)) return "audio";
    if (IMAGE_EXT.test(u)) return "image";
    const k = (jobKind || "").toLowerCase();
    if (k) {
        if (VIDEO_KINDS.has(k) || k.includes("video") || k.endsWith("-t2v") || k.endsWith("-i2v")) return "video";
        if (AUDIO_KINDS.has(k) || k.includes("audio") || k.includes("tts")) return "audio";
        if (IMAGE_KINDS.has(k) || k.includes("image") || k.endsWith("-t2i")) return "image";
    }
    // data: / blob: 兜底
    if (/^data:video\//i.test(u)) return "video";
    if (/^data:audio\//i.test(u)) return "audio";
    if (/^data:image\//i.test(u)) return "image";
    return "unknown";
}

/** 列出作业全部可预览结果（去重保序）。 */
export function listJobMedia(job: { results?: string[]; kind?: string } | null | undefined): LibraryMedia[] {
    if (!job?.results?.length) return [];
    const seen = new Set<string>();
    const out: LibraryMedia[] = [];
    for (const raw of job.results) {
        const url = (raw || "").trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({ url, kind: classifyMediaUrl(url, job.kind) });
    }
    return out;
}

export function primaryMedia(job: { results?: string[]; kind?: string } | null | undefined): LibraryMedia | null {
    return listJobMedia(job)[0] ?? null;
}

/** 打开画布并预置对应类型空白节点（既有 mode=new&add= 契约）。 */
export function canvasAddPathForMedia(kind: LibraryMediaKind): string {
    if (kind === "video") return "/canvas?mode=new&add=video";
    if (kind === "audio") return "/canvas?mode=new&add=audio";
    return "/canvas?mode=new&add=image";
}

/** 下载文件名猜测。 */
export function filenameFromMediaUrl(url: string, fallback = "toiv-media"): string {
    try {
        const path = url.split("?")[0] || "";
        const base = path.split("/").pop() || "";
        if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
    } catch {
        /* ignore */
    }
    return fallback;
}

