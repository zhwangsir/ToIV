/**
 * 画布市场封面 <img> URL 解析（与 apps/web/lib/api.ts coverImageUrl 对齐）。
 * 自托管相对路径拼 ?token=（img 不能带 Authorization）；外链不加 JWT；RH COS 视频封面截帧。
 */
const TOKEN_KEY = "toiv_token";
const VIDEO_COVER_PATH_RE = /\.(mp4|webm|mov|m4v)$/i;
const RH_COS_HOST_RE = /^rh-[a-z0-9-]*images\.xiaoyaoyou\.com$/i;

function splitCoverUrlPath(url: string): { base: string; path: string; host: string } {
    const base = url.split(/[?#]/, 1)[0] ?? url;
    const m = /^https?:\/\/([^/]+)(\/[^?#]*)?/i.exec(base);
    return { base, host: m ? m[1]! : "", path: m ? m[2] || "" : base };
}

function isOwnToivApiUrl(url: string): boolean {
    if (!/^https?:\/\//i.test(url)) return true;
    try {
        const u = new URL(url);
        if (typeof window !== "undefined" && u.origin === window.location.origin && u.pathname.startsWith("/api/")) {
            return true;
        }
    } catch {
        /* ignore */
    }
    return false;
}

function readToivToken(): string {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
}

function withToivImgToken(url: string): string {
    const token = readToivToken();
    if (!token || !isOwnToivApiUrl(url)) return url;
    return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
}

export function toivCoverImageUrl(path: string | null | undefined): string {
    if (!path) return "";
    const { base, host, path: urlPath } = splitCoverUrlPath(path);
    if (VIDEO_COVER_PATH_RE.test(urlPath) && RH_COS_HOST_RE.test(host)) {
        return `${base}?ci-process=snapshot&time=1&format=jpg&width=768`;
    }
    if (path.startsWith("http")) return withToivImgToken(path);
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const abs = normalized.startsWith("/api/")
        ? normalized
        : normalized.startsWith("/apps/")
          ? `/api${normalized}`
          : normalized;
    return withToivImgToken(abs);
}
