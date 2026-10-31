/**
 * Positive outbound host allowlist for canvas web fetch/axios (frontend).
 * Keep DEFAULT_OUTBOUND_HOSTS in sync with
 * apps/canvas/backend/internal/outbound/host_allowlist.go defaultOutboundHosts.
 * Desktop toiv_gate uses the Go helper; custom channels stay on ValidateOutboundURL
 * and are intentionally not gated here.
 */

export const ENV_OUTBOUND_HOST_ALLOWLIST = "VITE_CANVAS_OUTBOUND_HOST_ALLOWLIST";

/** Mirrors Go defaultOutboundHosts: production API, desktop updater CDN, local loopback. */
export const DEFAULT_OUTBOUND_HOSTS = ["toiv.wineryz.top", "updates.beefapi.com", "localhost", "127.0.0.1", "::1"] as const;

let extraOutboundHosts: string[] = [];

function normalizeOutboundHost(host: string): string {
    return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function splitAllowlistEntry(raw: string): { host: string; port: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { host: "", port: "" };
    // [ipv6]:port
    if (trimmed.startsWith("[")) {
        const end = trimmed.indexOf("]");
        if (end > 0) {
            const host = normalizeOutboundHost(trimmed.slice(1, end));
            const rest = trimmed.slice(end + 1);
            if (rest.startsWith(":")) return { host, port: rest.slice(1).trim() };
            return { host, port: "" };
        }
    }
    // host:port (single colon, not bare ipv6)
    const colon = trimmed.lastIndexOf(":");
    if (colon > 0 && trimmed.indexOf(":") === colon && !trimmed.includes("::")) {
        return {
            host: normalizeOutboundHost(trimmed.slice(0, colon)),
            port: trimmed.slice(colon + 1).trim(),
        };
    }
    return { host: normalizeOutboundHost(trimmed), port: "" };
}

function matchOutboundAllowlistEntries(entries: Iterable<string>, host: string, port: string): boolean {
    for (const configured of entries) {
        const { host: entryHost, port: entryPort } = splitAllowlistEntry(configured);
        if (!entryHost || entryHost !== host) continue;
        if (!entryPort || entryPort === port) return true;
    }
    return false;
}

function envAllowlistEntries(): string[] {
    const raw =
        (typeof import.meta !== "undefined" && import.meta.env && (import.meta.env as Record<string, string | undefined>)[ENV_OUTBOUND_HOST_ALLOWLIST]) ||
        "";
    return String(raw)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

/** Register hosts for this page session (e.g. desktop apiBase). Empty / duplicates ignored. */
export function appendOutboundHostAllowlist(...hosts: string[]): void {
    for (const raw of hosts) {
        const { host, port } = splitAllowlistEntry(raw);
        if (!host) continue;
        const entry = port ? `${host.includes(":") ? `[${host}]` : host}:${port}` : host;
        if (!extraOutboundHosts.includes(entry)) extraOutboundHosts = [...extraOutboundHosts, entry];
    }
}

/** Clears process-local extras (tests only). */
export function resetOutboundHostAllowlistExtras(): void {
    extraOutboundHosts = [];
}

/** Whether host[:port] is on defaults, VITE_CANVAS_OUTBOUND_HOST_ALLOWLIST, or extras. No DNS. */
export function outboundHostAllowed(host: string, port = ""): boolean {
    const normalized = normalizeOutboundHost(host);
    const normalizedPort = port.trim();
    if (!normalized) return false;
    if (matchOutboundAllowlistEntries(DEFAULT_OUTBOUND_HOSTS, normalized, normalizedPort)) return true;
    if (matchOutboundAllowlistEntries(envAllowlistEntries(), normalized, normalizedPort)) return true;
    return matchOutboundAllowlistEntries(extraOutboundHosts, normalized, normalizedPort);
}

function effectivePort(url: URL): string {
    if (url.port) return url.port;
    if (url.protocol === "https:") return "443";
    if (url.protocol === "http:") return "80";
    return "";
}

function sameOriginAsPage(url: URL): boolean {
    if (typeof window === "undefined" || !window.location?.hostname) return false;
    try {
        const page = new URL(window.location.href);
        return normalizeOutboundHost(url.hostname) === normalizeOutboundHost(page.hostname);
    } catch {
        return false;
    }
}

export class OutboundAllowlistError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OutboundAllowlistError";
    }
}

/**
 * Fail-closed check for absolute http(s) outbound URLs.
 * Relative / blob / data / non-http URLs are not treated as outbound here.
 * Same-origin absolute URLs pass (hosted /studio on a non-default host).
 */
export function assertAllowlistedOutboundUrl(rawUrl: string): URL | null {
    const trimmed = rawUrl.trim();
    if (!trimmed) throw new OutboundAllowlistError("出站地址无效");

    // Path-only or scheme-relative without host resolution context: not outbound.
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return null;
    if (trimmed.startsWith("blob:") || trimmed.startsWith("data:") || trimmed.startsWith("about:")) return null;

    let parsed: URL;
    try {
        parsed = new URL(trimmed, typeof window !== "undefined" ? window.location?.href : "http://127.0.0.1/");
    } catch {
        throw new OutboundAllowlistError("出站地址无效");
    }

    // Relative resolution that stayed path-like against page origin is same-origin; allow.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith("//")) {
        return null;
    }

    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
        throw new OutboundAllowlistError("出站地址只支持 http/https");
    }
    if (parsed.username || parsed.password) {
        throw new OutboundAllowlistError("出站地址不允许包含认证信息");
    }
    if (!parsed.hostname) {
        throw new OutboundAllowlistError("出站地址无效");
    }
    if (sameOriginAsPage(parsed)) return parsed;
    if (!outboundHostAllowed(parsed.hostname, effectivePort(parsed))) {
        throw new OutboundAllowlistError("出站目标不在允许列表");
    }
    return parsed;
}

/** Register host from an absolute API base (desktop http://127.0.0.1:PORT/api). */
export function registerOutboundApiBase(apiBase: string): void {
    const trimmed = apiBase.trim();
    if (!trimmed || trimmed.startsWith("/")) return;
    try {
        const parsed = new URL(trimmed);
        if (!parsed.hostname) return;
        if (parsed.port) appendOutboundHostAllowlist(`${parsed.hostname}:${parsed.port}`);
        else appendOutboundHostAllowlist(parsed.hostname);
    } catch {
        // ignore malformed; request interceptor will reject later
    }
}

type AxiosLikeConfig = {
    baseURL?: string;
    url?: string;
};

/** Resolve axios URL and enforce allowlist when the result is absolute http(s). */
export function assertAxiosOutboundAllowed(config: AxiosLikeConfig): void {
    const base = (config.baseURL || "").trim();
    const path = (config.url || "").trim();
    let resolved: string;
    try {
        if (/^https?:\/\//i.test(path) || path.startsWith("//")) resolved = path;
        else if (/^https?:\/\//i.test(base)) resolved = new URL(path || "", base.endsWith("/") ? base : `${base}/`).toString();
        else return; // relative client: same-origin / vite proxy — not dialed as absolute outbound
    } catch {
        throw new OutboundAllowlistError("出站地址无效");
    }
    assertAllowlistedOutboundUrl(resolved);
}
