/**
 * 普通/成人红线 —— canvas 前端唯一 UX 决策面（2026-10-26 死令修订）。
 *
 * 产品：
 * - 成人态 = **账号全局**；前端只展示 + 携带 X-NSFW；后端账号字段为唯一判据（403 不看请求头放行）
 * - localStorage 仅乐观缓存，非真相源；真源：GET/PATCH /api/me/mode → { content_mode: ordinary|adult, updated_at }；/auth/me 亦可读
 * - 他端 ≤30s 轮询刷新；切模式不 abort/cancel 在途任务（仅新请求走闸）
 * - 拦截在路由守卫（本文件 + RequireR18）；Settings 两步闸仍用 R18SettingsPane
 * - NSFW 列表：已知 NSFW → 普通态灰化+锁+「NSFW」可见不可点；未知元数据 → 普通藏/成人显
 * - 显式元数据优先（is_nsfw / nsfw / content_rating），文件名仅兜底
 * - 软化仅普通路径；成人路径代码层不进 softening
 */
import { CLASSIC_NSFW_TO_MARKET } from "@/services/toiv/content-mode";

export const POLICY_ID = "D-U1=B-frontend-guard";
/** @deprecated 仅作乐观缓存键；真相源为账号 content_mode */
export const R18_STORAGE_KEY = "toiv_r18_mode";
export const BIRTHDATE_STORAGE_KEY = "toiv_birthdate";
export const REQUEST_HEADER = "X-NSFW";
export const REQUEST_HEADER_VALUE = "1";
export const R18_SETTINGS_GATE_PATH = "/settings?section=common&focus=r18";

/** 账号模式轮询间隔（他端生效 ≤30s）。 */
export const ACCOUNT_MODE_POLL_MS = 30_000;

/** 切回普通时图/视频回落目标（死令）。 */
export const FALLBACK_IMAGE_BASENAME = "Qwen-Rapid-AIO-SFW-v23.safetensors";
export const FALLBACK_VIDEO_MODEL = "local-wan";

/** 用户可见文案（Wire 契约）；技术键仍用 r18 / X-NSFW / content_mode。 */
export const COPY_MODE_NORMAL = "普通";
export const COPY_MODE_ADULT = "成人";
export const COPY_GUARD_REASON = "当前为普通模式，此页需切换到成人模式";
export const COPY_SWITCH_TO_ADULT = "切换到成人模式";
export const COPY_STAY_NORMAL = "留在普通内容";
export const COPY_CONFIRM_SWITCH = "确认切换？将对你账号下所有设备生效。";
export const COPY_SLOT_ADULT = "需成人";
export const COPY_NSFW_LOCK_LABEL = "NSFW";
export const COPY_NSFW_LOCKED_HINT = "当前为普通模式，成人模型已锁定";
export const COPY_NSFW_MODELS_HIDDEN_EMPTY = "当前为普通模式，成人模型已锁定（灰化不可选）";
export const COPY_NSFW_APPS_HIDDEN_EMPTY = "当前为普通模式，纯成人应用已隐藏";
export const COPY_ACCOUNT_GLOBAL = "对此账号所有设备生效";
export const COPY_ACCOUNT_SYNC_HINT = "切换后其他已登录设备通常在 30 秒内同步";
export const COPY_FALLBACK_TIP = "已回落普通默认模型（出图 Qwen-Rapid-AIO-SFW-v23 / 出视频 local-wan）";
export const COPY_IN_FLIGHT_SAFE = "切换不会中断已提交的在途任务；仅新请求受内容模式约束";
export const SAFE_HOME_PATH = "/";

/** 同页切换成人模式时通知订阅方（storage 事件跨页才触发）。 */
export const R18_MODE_EVENT = "toiv-r18-mode";
/** 切回普通并完成回落后，一次性徽标提示。 */
export const R18_FALLBACK_TIP_EVENT = "toiv-r18-fallback-tip";

/** 纯路径前缀（命中即视为 NSFW 专属面）。 */
export const NSFW_GATED_PATH_PREFIXES: readonly string[] = ["/nsfw"];

/**
 * 查询参数：未开成人时命中则拦到设置闸。
 * 覆盖：市场 R18 分类、content_mode=nsfw、显式 nsfw 标记。
 */
export const NSFW_GATED_QUERY: Readonly<Record<string, readonly string[]>> = {
    category: ["r18", "nsfw"],
    content_mode: ["nsfw"],
    nsfw: ["1", "true", "yes"],
    mode: ["nsfw", "r18"],
    filter: ["r18", "nsfw"],
};

/** 纯 R18 市场应用（via=is_nsfw_app）；深链 ?app= 命中且未开成人 → 守卫。 */
export const NSFW_ONLY_APP_IDS: readonly string[] = CLASSIC_NSFW_TO_MARKET.filter((x) => x.via === "is_nsfw_app").map(
    (x) => x.marketAppId,
);

/** 账号 content_mode 契约（对齐后端 GET me/mode）。 */
export type AccountContentMode = "ordinary" | "adult";

export type AccountModePayload = {
    /** 真值 ordinary|adult；读入时亦接受 sfw|nsfw|r18 别名并由 normalize 收口。 */
    content_mode: AccountContentMode | string;
    updated_at?: string | null;
};

/** 内存态：账号模式真源缓存（localStorage 仅乐观）。 */
let accountModeCache: AccountContentMode | null = null;
let accountModeUpdatedAt: string | null = null;
let accountPollTimer: ReturnType<typeof setInterval> | null = null;
let fallbackTipPending = false;
/** 防止切模式时任何调用方误把「模式变更」当成 abort 信号。 */
export const MODE_SWITCH_DOES_NOT_ABORT_INFLIGHT = true as const;

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

function applyDataset(on: boolean): void {
    if (typeof document === "undefined") return;
    if (on) document.documentElement.dataset.r18 = "1";
    else delete document.documentElement.dataset.r18;
}

function notifyR18Listeners(): void {
    if (typeof window === "undefined") return;
    try {
        if (typeof window.dispatchEvent === "function") {
            window.dispatchEvent(new Event(R18_MODE_EVENT));
        }
    } catch {
        /* ignore */
    }
}

function notifyFallbackTip(): void {
    fallbackTipPending = true;
    if (typeof window === "undefined") return;
    try {
        if (typeof window.dispatchEvent === "function") {
            window.dispatchEvent(new Event(R18_FALLBACK_TIP_EVENT));
        }
    } catch {
        /* ignore */
    }
}

export function consumeFallbackTip(): boolean {
    if (!fallbackTipPending) return false;
    fallbackTipPending = false;
    return true;
}

export function peekFallbackTip(): boolean {
    return fallbackTipPending;
}

/**
 * 规范化账号 content_mode。
 * 真值 ordinary|adult；写入别名 sfw→ordinary、nsfw|r18→adult（后端已兼容）。
 */
export function normalizeAccountContentMode(raw: unknown): AccountContentMode {
    const v = String(raw ?? "").trim().toLowerCase();
    if (v === "adult" || v === "nsfw" || v === "r18") return "adult";
    return "ordinary";
}

type ToivHttpLike = {
    get: (url: string, config?: object) => Promise<{ data: unknown }>;
    patch: (url: string, body?: object, config?: object) => Promise<{ data: unknown }>;
};

async function loadToivHttp(): Promise<ToivHttpLike | null> {
    try {
        // 动态导入避免与 toiv/client → r18-mode → redline 成环
        const mod = await import("@/services/toiv/client");
        return mod.toivHttp as ToivHttpLike;
    } catch {
        return null;
    }
}

function payloadFromMeMode(data: unknown): AccountModePayload | null {
    if (!data || typeof data !== "object") return null;
    const row = data as Record<string, unknown>;
    if (!("content_mode" in row)) return null;
    const updated = row.updated_at;
    return {
        content_mode: normalizeAccountContentMode(row.content_mode),
        updated_at: typeof updated === "string" ? updated : updated == null ? null : String(updated),
    };
}

function payloadFromAuthMe(data: unknown): AccountModePayload | null {
    if (!data || typeof data !== "object") return null;
    const root = data as Record<string, unknown>;
    const user = (root.user && typeof root.user === "object" ? root.user : root) as Record<string, unknown>;
    if (!("content_mode" in user)) return null;
    const updated = user.content_mode_updated_at ?? user.updated_at;
    return {
        content_mode: normalizeAccountContentMode(user.content_mode),
        updated_at: typeof updated === "string" ? updated : updated == null ? null : String(updated),
    };
}

/**
 * GET /api/me/mode → { content_mode, updated_at }。
 * 失败时回退 GET /api/auth/me 的 content_mode + content_mode_updated_at。
 * 403 以账号态为准；X-NSFW 仅携带不作放行判据。
 */
export async function fetchAccountContentMode(): Promise<AccountModePayload | null> {
    const http = await loadToivHttp();
    if (!http) return null;
    try {
        const { data } = await http.get("/me/mode", { timeout: 10_000 });
        const fromMode = payloadFromMeMode(data);
        if (fromMode) return fromMode;
    } catch {
        /* fall through to /auth/me */
    }
    try {
        const { data } = await http.get("/auth/me", { timeout: 10_000 });
        return payloadFromAuthMe(data);
    } catch {
        return null;
    }
}

/**
 * PATCH /api/me/mode { content_mode: ordinary|adult }。
 * 成功则用响应刷新本地；失败返回 false（调用方应 refresh）。
 */
export async function pushAccountContentMode(mode: AccountContentMode): Promise<boolean> {
    const http = await loadToivHttp();
    if (!http) return false;
    const normalized = normalizeAccountContentMode(mode);
    try {
        const { data } = await http.patch("/me/mode", { content_mode: normalized }, { timeout: 10_000 });
        const payload = payloadFromMeMode(data) ?? { content_mode: normalized, updated_at: null };
        applyAccountModePayload(payload);
        return true;
    } catch {
        return false;
    }
}

function optimisticAdult(): boolean {
    if (accountModeCache != null) return accountModeCache === "adult";
    return storageGet(R18_STORAGE_KEY) === "1";
}

export function isR18Mode(): boolean {
    if (isUnderage()) return false;
    return optimisticAdult();
}

/** 当前账号 content_mode（ordinary|adult）。 */
export function getAccountContentMode(): AccountContentMode {
    return isR18Mode() ? "adult" : "ordinary";
}

export function getAccountModeUpdatedAt(): string | null {
    return accountModeUpdatedAt;
}

/**
 * 用账号载荷刷新本地展示态。不 abort 在途。
 * 返回是否相对刷新前发生了变化。
 */
export function applyAccountModePayload(payload: AccountModePayload | null | undefined): boolean {
    if (!payload) return false;
    const mode = normalizeAccountContentMode(payload.content_mode);
    const nextUpdated = payload.updated_at ?? null;

    if (isUnderage()) {
        const changed = accountModeCache !== "ordinary" || isR18Mode();
        accountModeCache = "ordinary";
        accountModeUpdatedAt = nextUpdated ?? accountModeUpdatedAt;
        storageSet(R18_STORAGE_KEY, null);
        applyDataset(false);
        if (changed) notifyR18Listeners();
        return changed;
    }

    if (accountModeCache === mode && accountModeUpdatedAt === nextUpdated) return false;

    const prev = isR18Mode();
    const nextAdult = mode === "adult";
    accountModeCache = mode;
    accountModeUpdatedAt = nextUpdated ?? accountModeUpdatedAt;
    storageSet(R18_STORAGE_KEY, nextAdult ? "1" : null);
    applyDataset(nextAdult);
    if (prev !== nextAdult) {
        if (prev && !nextAdult) notifyFallbackTip();
        notifyR18Listeners();
        return true;
    }
    return false;
}

/** 启动：用 localStorage 乐观缓存恢复展示，再拉账号 + ≤30s 轮询覆盖。切模式永不 abort 在途。 */
export function initR18Mode(): void {
    if (isUnderage()) {
        accountModeCache = "ordinary";
        storageSet(R18_STORAGE_KEY, null);
        applyDataset(false);
    } else {
        // 启动瞬间以存储恢复；随即被 /me/mode 覆盖（存储非真相源）
        const fromStore = storageGet(R18_STORAGE_KEY) === "1";
        accountModeCache = fromStore ? "adult" : "ordinary";
        applyDataset(fromStore);
    }
    void refreshAccountContentMode();
    startAccountModePolling();
}

export async function refreshAccountContentMode(): Promise<void> {
    try {
        const payload = await fetchAccountContentMode();
        if (payload) applyAccountModePayload(payload);
    } catch {
        /* 网络失败时继续用内存/乐观缓存；不以 localStorage 覆盖 API */
    }
}

export function startAccountModePolling(): void {
    if (typeof window === "undefined") return;
    if (accountPollTimer != null) return;
    accountPollTimer = setInterval(() => {
        void refreshAccountContentMode();
    }, ACCOUNT_MODE_POLL_MS);
}

export function stopAccountModePolling(): void {
    if (accountPollTimer != null) {
        clearInterval(accountPollTimer);
        accountPollTimer = null;
    }
}

/**
 * 开启/关闭成人。未成年 → false。
 * 写乐观缓存 + 尝试推账号；**不** abort/cancel 任何在途任务。
 */
export function setR18Mode(on: boolean): boolean {
    if (typeof window === "undefined") return false;
    if (on && isUnderage()) {
        accountModeCache = "ordinary";
        storageSet(R18_STORAGE_KEY, null);
        applyDataset(false);
        notifyR18Listeners();
        return false;
    }
    const prev = isR18Mode();
    const mode: AccountContentMode = on ? "adult" : "ordinary";
    accountModeCache = mode;
    storageSet(R18_STORAGE_KEY, on ? "1" : null);
    applyDataset(on);
    // 不触碰 AbortController / cancelJob —— 在途按提交快照继续
    void MODE_SWITCH_DOES_NOT_ABORT_INFLIGHT;
    void pushAccountContentMode(mode).then((ok) => {
        if (!ok) void refreshAccountContentMode();
    });
    if (prev && !on) notifyFallbackTip();
    notifyR18Listeners();
    return on;
}

/** useSyncExternalStore 订阅：同页事件 + storage + focus。 */
export function subscribeR18Mode(onStoreChange: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    const handler = () => onStoreChange();
    window.addEventListener(R18_MODE_EVENT, handler);
    window.addEventListener("storage", handler);
    window.addEventListener("focus", handler);
    return () => {
        window.removeEventListener(R18_MODE_EVENT, handler);
        window.removeEventListener("storage", handler);
        window.removeEventListener("focus", handler);
    };
}

export function subscribeFallbackTip(onStoreChange: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    const handler = () => onStoreChange();
    window.addEventListener(R18_FALLBACK_TIP_EVENT, handler);
    return () => window.removeEventListener(R18_FALLBACK_TIP_EVENT, handler);
}

export function getR18ModeSnapshot(): boolean {
    return isR18Mode();
}

export function getServerR18ModeSnapshot(): boolean {
    return false;
}

/** client 拦截器：是否附 X-NSFW（仅携带；403 以账号态为准）。 */
export function nsfwHeaderEnabled(): boolean {
    return isR18Mode();
}

export function nsfwAllowed(): boolean {
    return isR18Mode();
}

/**
 * 软化门：仅普通模式可进 softening 代码路径；成人模式必须短路。
 */
export function shouldApplyContentSoftening(): boolean {
    return !isR18Mode();
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

/** 该 location 是否属 NSFW 专属面（需成人才进）。设置闸本身永不算 gated。 */
export function isNsfwGatedLocation(loc: LocationLike): boolean {
    const pathname = normalizePath(loc.pathname || "/");
    const search = loc.search || "";
    if (pathname === "/settings") {
        return false;
    }
    if (NSFW_GATED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        return true;
    }
    return queryHitsNsfwGate(search);
}

/**
 * 守卫判定：未开成人且目标为成人专属 → 拦截（CTA 指向设置两步闸）。
 * 返回 null 表示放行；非 null 为设置闸路径。
 */
export function r18GuardRedirect(loc: LocationLike): string | null {
    if (!isNsfwGatedLocation(loc)) return null;
    if (nsfwAllowed()) return null;
    return R18_SETTINGS_GATE_PATH;
}

export function canEnterNsfwRoute(loc: LocationLike): boolean {
    return r18GuardRedirect(loc) == null;
}

/**
 * NSFW 资产标记：文件名/路径含 nsfw（仅兜底）。
 * 覆盖双轨命名（Qwen/Wan Rapid NSFW、Remix NSFW、Mega …-nsfw-v12.2 等）。
 */
export function isNsfwAssetMarker(...parts: Array<string | null | undefined>): boolean {
    const blob = parts
        .map((p) => String(p || "").trim())
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
    if (!blob) return false;
    return blob.includes("nsfw");
}

export type NsfwAssetLike =
    | string
    | null
    | undefined
    | {
          nsfw?: boolean | null;
          is_nsfw?: boolean | null;
          content_rating?: string | null;
          content_mode?: string | null;
          rating?: string | null;
          basename?: string | null;
          label?: string | null;
          relPath?: string | null;
          rel_path?: string | null;
          id?: string | null;
          value?: string | null;
          purposeZh?: string | null;
          用途?: string | null;
      };

export type AssetContentClass = "sfw" | "nsfw" | "unknown";

function ratingToken(raw: unknown): string {
    return String(raw ?? "")
        .trim()
        .toLowerCase();
}

/**
 * 分类：显式元数据优先 → 文件名兜底 → 否则 sfw。
 * unknown：显式 content_rating/content_mode/rating = unknown|unrated|pending。
 */
export function classifyAssetContent(asset: NsfwAssetLike): AssetContentClass {
    if (asset == null) return "sfw";
    if (typeof asset === "string") {
        return isNsfwAssetMarker(asset) ? "nsfw" : "sfw";
    }
    // 1) 显式布尔
    if (asset.is_nsfw === true || asset.nsfw === true) return "nsfw";
    if (asset.is_nsfw === false || asset.nsfw === false) return "sfw";
    // 2) 显式评级字段
    for (const key of [asset.content_rating, asset.content_mode, asset.rating] as const) {
        const t = ratingToken(key);
        if (!t) continue;
        if (t === "nsfw" || t === "r18" || t === "adult") return "nsfw";
        if (t === "sfw" || t === "safe" || t === "normal") return "sfw";
        if (t === "unknown" || t === "unrated" || t === "pending" || t === "unset") return "unknown";
    }
    // 3) 文件名兜底
    if (
        isNsfwAssetMarker(
            asset.basename,
            asset.label,
            asset.relPath,
            asset.rel_path,
            asset.id,
            asset.value,
            asset.purposeZh,
            asset.用途,
        )
    ) {
        return "nsfw";
    }
    return "sfw";
}

/** 资产是否属 NSFW/成人专属条目（不论当前模式）。unknown 不算 NSFW。 */
export function assetLooksNsfw(asset: NsfwAssetLike): boolean {
    return classifyAssetContent(asset) === "nsfw";
}

/**
 * 列表是否展示该条目：
 * - sfw：始终
 * - nsfw（已知）：始终（普通态灰化锁定，由 UI 处理）
 * - unknown：普通藏 / 成人显
 */
export function isNsfwAssetListable(asset: NsfwAssetLike): boolean {
    const cls = classifyAssetContent(asset);
    if (cls === "unknown") return nsfwAllowed();
    return true;
}

/**
 * 是否可选中/点击：
 * - 成人：均可（listable 的）
 * - 普通：仅非 NSFW；已知 NSFW 可见不可点
 */
export function isNsfwAssetSelectable(asset: NsfwAssetLike): boolean {
    if (!isNsfwAssetListable(asset)) return false;
    if (classifyAssetContent(asset) === "nsfw") return nsfwAllowed();
    return true;
}

/**
 * @deprecated 语义改为「可选中」。列表请用 isNsfwAssetListable；
 * 保留别名以免旧调用把锁定项当可选。
 */
export function isNsfwAssetVisible(asset: NsfwAssetLike): boolean {
    return isNsfwAssetSelectable(asset);
}

/** 列表过滤：保留可展示项（含普通态锁定的已知 NSFW）。 */
export function filterNsfwListableAssets<T>(
    items: readonly T[],
    pick: (item: T) => NsfwAssetLike = (item) => item as unknown as NsfwAssetLike,
): T[] {
    return items.filter((item) => isNsfwAssetListable(pick(item)));
}

/**
 * @deprecated 现等于 filterNsfwListableAssets（含锁定 NSFW）。
 * 若只需可选中子集，请再 filter isNsfwAssetSelectable。
 */
export function filterNsfwVisibleAssets<T>(
    items: readonly T[],
    pick: (item: T) => NsfwAssetLike = (item) => item as unknown as NsfwAssetLike,
): T[] {
    return filterNsfwListableAssets(items, pick);
}

/**
 * 当前选中若为 NSFW 且处于普通模式 → 回落到 fallback（避免下拉空值崩）。
 * fallback 空串表示清空。
 */
export function visibleSelectionOrFallback(selected: string | null | undefined, fallback: string = ""): string {
    const s = String(selected || "").trim();
    if (!s) return fallback;
    if (isNsfwAssetSelectable(s)) return s;
    return fallback;
}

/** 守卫覆盖清单（文档/TEST_LOG 引用）。 */
export const REDLINE_GUARD_COVERAGE = [
    "path /nsfw 及子路径",
    "query category=r18|nsfw（市场 R18 分类）",
    "query content_mode=nsfw|mode=nsfw|nsfw=1|filter=r18",
    "query app= 纯 R18 市场应用（CLASSIC via=is_nsfw_app）",
    "普通模式拦成人资源 → 出卡「切换到成人模式」→ /settings?section=common&focus=r18（两步闸）",
    "/settings 含 focus=r18 永不拦截（开启入口）",
    "选型列表：已知 NSFW 普通态灰化+锁+NSFW 标签（可见不可点）；未知元数据普通藏/成人显",
    "显式 is_nsfw/nsfw/content_rating 优先；文件名仅兜底",
    "账号 content_mode(ordinary|adult) / me/mode 为真源；localStorage 仅乐观缓存；≤30s 轮询",
    "切模式不中断在途；软化仅普通路径",
] as const;
