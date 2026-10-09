// Mount prefix for browser deployments under a sub-path (toiv.wineryz.top/studio/).
// The default build has base "/" and API "/api", and every helper here is then a no-op,
// so desktop, staging and existing data are unchanged.
//
// Canonical (stored) form is always the root form: "/api/…" for backend URLs and
// "/short-drama-styles/…" style paths for bundled public files. Only the browser sees the
// prefixed form; requests are mapped back before they reach the backend.

const PUBLIC_DIRS = ["short-drama-styles", "lighting-presets", "images", "canvas/models", "three", "mediapipe", "icons", "welcome"];
const PUBLIC_FILES = ["logo.svg", "favicon.svg", "toiv-logo.svg", "toiv-mark.svg"];

function normalizeBase(raw: string | undefined) {
    const value = String(raw || "/").trim();
    if (!value.startsWith("/")) return ""; // relative bases ("./") are the desktop build
    return value.replace(/\/+$/, "");
}

/** "" for root deployments, "/studio" for the sub-path deployment. */
export const APP_BASE = normalizeBase(import.meta.env.BASE_URL);

function isPublicPath(path: string) {
    return PUBLIC_DIRS.some((dir) => path.startsWith(`/${dir}/`)) || PUBLIC_FILES.some((file) => path === `/${file}`);
}

/** Bundled public file URL ("/short-drama-styles/x.jpg" → "/studio/short-drama-styles/x.jpg"). */
export function publicAsset(path: string, base = APP_BASE) {
    if (!base || !path.startsWith("/") || path.startsWith(`${base}/`)) return path;
    return `${base}${path}`;
}

/** Gate-owned path (/auth/*, /login …) under the mount prefix. */
export function gatePath(path: string, base = APP_BASE) {
    return base ? `${base}${path}` : path;
}

function trimSlash(value: string) {
    return String(value || "").replace(/\/+$/, "");
}

/** Canonical → browser form. Only root-relative strings are touched. */
export function toClientUrl(value: string, apiBase: string, base = APP_BASE) {
    if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || value.startsWith("//")) return value;
    const api = trimSlash(apiBase);
    if (value.startsWith("/api/") && api && api !== "/api" && api.startsWith("/")) return `${api}${value.slice(4)}`;
    if (base && isPublicPath(value)) return `${base}${value}`;
    return value;
}

/** Browser → canonical form (inverse of toClientUrl). */
export function toCanonicalUrl(value: string, apiBase: string, base = APP_BASE) {
    if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/")) return value;
    const api = trimSlash(apiBase);
    if (api && api !== "/api" && api.startsWith("/") && value.startsWith(`${api}/`)) return `/api${value.slice(api.length)}`;
    if (base && value.startsWith(`${base}/`) && isPublicPath(value.slice(base.length))) return value.slice(base.length);
    return value;
}

export function urlMappingActive(apiBase: string, base = APP_BASE) {
    const api = trimSlash(apiBase);
    return Boolean(base) || (api !== "/api" && api.startsWith("/"));
}

/**
 * Deep-map string values in JSON-like data. Returns the same reference when nothing changed,
 * never mutates the input, and leaves non-plain objects (Blob, FormData, ArrayBuffer …) alone.
 */
export function mapUrlStrings<T>(input: T, map: (value: string) => string, depth = 0): T {
    if (typeof input === "string") return map(input) as T;
    if (depth > 64 || input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) {
        let changed = false;
        const out = input.map((item) => { const next = mapUrlStrings(item, map, depth + 1); if (next !== item) changed = true; return next; });
        return (changed ? out : input) as T;
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return input;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        const next = mapUrlStrings(value, map, depth + 1);
        if (next !== value) changed = true;
        out[key] = next;
    }
    return (changed ? out : input) as T;
}

let gateLoginRedirected = false;
const LOGIN_REDIRECT_KEY = "toiv_studio_login_redirect_at";
const UNAUTHENTICATED_REASONS = new Set(["toiv_identity_required", "gate_identity_required", "gate_identity_invalid", "gate_identity_expired"]);

function isUnauthenticatedBody(body: unknown, base: string) {
    if (!body || typeof body !== "object") return false;
    const { error, reason } = body as { error?: unknown; reason?: unknown };
    if (error === "unauthenticated") return true; // staging gate
    // /studio (gate retired): canvas-api itself rejects a missing/expired ToIV token. On the staging
    // gate a gate_identity_* 401 means a gate fault, not a dead session, so it does not redirect there.
    return Boolean(base) && typeof reason === "string" && UNAUTHENTICATED_REASONS.has(reason);
}

/** Where a signed-out browser goes: the gate's login form (staging) or the ToIV login entry (/studio). */
export function loginEntryUrl(next: string, base = APP_BASE) {
    return base ? `/?view=home&next=${encodeURIComponent(next)}` : `/login?next=${encodeURIComponent(next)}`;
}

/**
 * The backend (or the staging gate) answers 401 once the ToIV token behind the session is gone or
 * expired: gate {"error":"unauthenticated"}, canvas-api {"reason":"toiv_identity_required" | "gate_identity_*"}.
 * Send the page to the login entry once per page load, and at most once a minute across reloads
 * so a backend that keeps rejecting a still-valid ToIV token cannot bounce the user in a loop.
 */
export function redirectToGateLogin(status: number | undefined, body: unknown, base = APP_BASE) {
    if (gateLoginRedirected || status !== 401 || typeof window === "undefined") return false;
    if (!isUnauthenticatedBody(body, base)) return false;
    try {
        const last = Number(window.sessionStorage.getItem(LOGIN_REDIRECT_KEY) || 0);
        if (Date.now() - last < 60_000) return false;
        window.sessionStorage.setItem(LOGIN_REDIRECT_KEY, String(Date.now()));
    } catch { /* storage blocked: the per-page flag still applies */ }
    gateLoginRedirected = true;
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.replace(loginEntryUrl(here, base));
    return true;
}
