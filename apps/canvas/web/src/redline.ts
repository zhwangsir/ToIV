/**
 * R18/未成年红线 —— canvas 前端唯一控制文件（2026-10-26 口径）。
 *
 * 产品：
 * - 默认 SFW；本机开启 R18 后请求附 X-NSFW、dataset.r18、可进 NSFW 路由/面板
 * - 拦截在**路由守卫**（本文件 + RequireR18），不靠后端 403
 * - 未成年硬阻断在此判定（birthdate 空=成年兼容）；后端可被 API 直调绕过（本地自用接受）
 * - Settings 两步闸仍用 R18SettingsPane；开关真源为本文件
 */
import { CLASSIC_NSFW_TO_MARKET } from "@/services/toiv/content-mode";

export const POLICY_ID = "D-U1=B-frontend-guard";
export const R18_STORAGE_KEY = "toiv_r18_mode";
export const BIRTHDATE_STORAGE_KEY = "toiv_birthdate";
export const REQUEST_HEADER = "X-NSFW";
export const REQUEST_HEADER_VALUE = "1";
export const R18_SETTINGS_GATE_PATH = "/settings?section=common&focus=r18";

/** 纯路径前缀（命中即视为 NSFW 专属面）。 */
export const NSFW_GATED_PATH_PREFIXES: readonly string[] = ["/nsfw"];

/**
 * 查询参数：未开 R18 时命中则拦到设置闸。
 * 覆盖：市场 R18 分类、content_mode=nsfw、显式 nsfw 标记。
 */
export const NSFW_GATED_QUERY: Readonly<Record<string, readonly string[]>> = {
    category: ["r18", "nsfw"],
    content_mode: ["nsfw"],
    nsfw: ["1", "true", "yes"],
    mode: ["nsfw", "r18"],
    filter: ["r18", "nsfw"],
};

/** 纯 R18 市场应用（via=is_nsfw_app）；深链 ?app= 命中且未开 R18 → 守卫。 */
export const NSFW_ONLY_APP_IDS: readonly string[] = CLASSIC_NSFW_TO_MARKET.filter((x) => x.via === "is_nsfw_app").map(
    (x) => x.marketAppId,
);

function storageGet(key: string): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function storageSet(key: string, value: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (value == null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
    } catch {
        /* ignore quota */
    }
}

/** birthdate 空视为成年（兼容老数据）；ISO `YYYY-MM-DD`。 */
export function isUnderage(birthdateIso?: string | null): boolean {
    const raw = (birthdateIso ?? storageGet(BIRTHDATE_STORAGE_KEY) ?? "").trim();
    if (!raw) return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (!m) return false;
    const birth = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(birth.getTime())) return false;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const beforeBirthday =
        today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
    if (beforeBirthday) age -= 1;
    return age < 18;
}

export function setStoredBirthdate(iso: string | null): void {
    storageSet(BIRTHDATE_STORAGE_KEY, iso && iso.trim() ? iso.trim() : null);
}

export function isR18Mode(): boolean {
    if (isUnderage()) return false;
    return storageGet(R18_STORAGE_KEY) === "1";
}

function applyDataset(on: boolean): void {
    if (typeof document === "undefined") return;
    if (on) document.documentElement.dataset.r18 = "1";
    else delete document.documentElement.dataset.r18;
}

/** 启动恢复 dataset；未成年强制关。 */
export function initR18Mode(): void {
    if (isUnderage()) {
        storageSet(R18_STORAGE_KEY, null);
        applyDataset(false);
        return;
    }
    applyDataset(storageGet(R18_STORAGE_KEY) === "1");
}

/**
 * 开启 R18。未成年 → false 且不写库。
 * 返回是否已处于开启态。
 */
export function setR18Mode(on: boolean): boolean {
    if (typeof window === "undefined") return false;
    if (on && isUnderage()) {
        storageSet(R18_STORAGE_KEY, null);
        applyDataset(false);
        return false;
    }
    storageSet(R18_STORAGE_KEY, on ? "1" : null);
    applyDataset(on);
    return on;
}

/** client 拦截器：是否附 X-NSFW。 */
export function nsfwHeaderEnabled(): boolean {
    return isR18Mode();
}

export function nsfwAllowed(): boolean {
    return isR18Mode();
}

export type LocationLike = { pathname?: string; search?: string };

function normalizePath(pathname: string): string {
    if (!pathname) return "/";
    const p = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function queryHitsNsfwGate(search: string): boolean {
    const q = search.startsWith("?") ? search.slice(1) : search;
    if (!q) return false;
    const params = new URLSearchParams(q);
    for (const [key, values] of Object.entries(NSFW_GATED_QUERY)) {
        const raw = (params.get(key) || "").trim().toLowerCase();
        if (raw && values.includes(raw)) return true;
    }
    const appId = (params.get("app") || "").trim();
    if (appId && NSFW_ONLY_APP_IDS.includes(appId)) return true;
    return false;
}

/** 该 location 是否属 NSFW 专属面（需 R18 才进）。设置闸本身永不算 gated。 */
export function isNsfwGatedLocation(loc: LocationLike): boolean {
    const pathname = normalizePath(loc.pathname || "/");
    const search = loc.search || "";
    if (pathname === "/settings") {
        // focus=r18 是开启入口，必须放行
        return false;
    }
    if (NSFW_GATED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        return true;
    }
    return queryHitsNsfwGate(search);
}

/**
 * 守卫判定：未开 R18 且目标为 NSFW 专属 → 应重定向到设置闸。
 * 返回 null 表示放行。
 */
export function r18GuardRedirect(loc: LocationLike): string | null {
    if (!isNsfwGatedLocation(loc)) return null;
    if (nsfwAllowed()) return null;
    return R18_SETTINGS_GATE_PATH;
}

/** 纯函数：当前是否可进入给定 NSFW 面。 */
export function canEnterNsfwRoute(loc: LocationLike): boolean {
    return r18GuardRedirect(loc) == null;
}

/** 守卫覆盖清单（文档/TEST_LOG 引用）。 */
export const REDLINE_GUARD_COVERAGE = [
    "path /nsfw 及子路径",
    "query category=r18|nsfw（市场 R18 分类）",
    "query content_mode=nsfw|mode=nsfw|nsfw=1|filter=r18",
    "query app= 纯 R18 市场应用（CLASSIC via=is_nsfw_app）",
    "未开 R18 → /settings?section=common&focus=r18（两步闸）",
    "/settings 含 focus=r18 永不拦截（开启入口）",
] as const;
