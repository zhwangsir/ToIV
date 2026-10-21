/**
 * F4：剪映草稿导出 — 前端契约与下载辅助（结构校验 / 触发 ZIP）。
 * 协议实现在后端 `jianying_draft.py`；此处不嵌入 AGPL/GPL 草稿库。
 */

export const JIANYING_DRAFT_FORMAT = "toiv_jianying_draft_v1" as const;

export const JIANYING_EXPORT_LABEL = "导出剪映草稿";

export const JIANYING_EXPORT_HINT =
    "下载 ZIP 后解压到本机剪映草稿目录（见包内 IMPORT.md）。best-effort 明文草稿，非官方 SDK。";

export type JianyingExportShotLike = {
    final_clip_url?: string | null;
    video_url?: string | null;
};

/** 至少一镜有成片 URL 才允许点导出。 */
export function canExportJianyingDraft(shots: readonly JianyingExportShotLike[]): boolean {
    return shots.some((s) => Boolean((s.final_clip_url || s.video_url || "").trim()));
}

export function jianyingExportFilename(title: string, draftId: string): string {
    const base = (title || "toiv-draft").trim() || "toiv-draft";
    const cleaned = base
        .replace(/[^\w\u4e00-\u9fff.-]+/g, "_")
        .replace(/^[\s._]+|[\s._]+$/g, "")
        .slice(0, 48) || "toiv-draft";
    const short = draftId.replace(/-/g, "").slice(0, 8) || "draft";
    return `${cleaned}_${short}.zip`;
}

export function parseContentDispositionFilename(cd: string, fallback: string): string {
    const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd || "");
    if (!m) return fallback;
    const raw = (m[1] || m[2] || "").trim();
    if (!raw) return fallback;
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
