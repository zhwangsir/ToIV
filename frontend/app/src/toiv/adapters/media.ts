export type PrimeMediaKind = "image" | "video" | "audio";

function mediaUrl(path: unknown): URL | undefined {
    if (typeof path !== "string" || !path.trim() || path.includes("\\")) return;
    if ([...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return;
    try {
        const origin = typeof window === "undefined" ? "https://toiv.invalid" : window.location.origin;
        const url = new URL(path.trim(), `${origin}/`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
        return url;
    } catch { return; }
}

/** Inspect the file, never the job kind or an upstream worker URL. */
export function primeMediaKind(path: unknown): PrimeMediaKind | undefined {
    const url = mediaUrl(path);
    if (!url) return;
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return; }
    // filename is used by /api/images and extensionless download endpoints only.
    const name = /\.[^/]+$/.test(pathname) ? pathname : url.searchParams.get("filename") ?? pathname;
    const ext = name.split(".").pop()?.toLowerCase();
    if (ext && ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg"].includes(ext)) return "image";
    if (ext && ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
    if (ext && ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"].includes(ext)) return "audio";
}

/** Media elements cannot send Authorization. Sign only this origin's API, never an external URL. */
export function toivMediaUrl(path: unknown): string {
    const url = mediaUrl(path);
    if (!url) return "";
    const sameOrigin = typeof window !== "undefined" && url.origin === window.location.origin;
    if (sameOrigin && url.pathname.startsWith("/api/")) {
        // Replace stale signatures; do not keep an old login's token if storage is unavailable.
        url.searchParams.delete("token");
        try {
            const token = window.localStorage.getItem("toiv_token");
            if (token) url.searchParams.set("token", token);
        } catch { /* The endpoint will surface an auth failure through the media error UI. */ }
    }
    return url.href;
}
