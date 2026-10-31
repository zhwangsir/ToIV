/**
 * F3 / P4：短剧合成声床（BGM）——产品路径最小挂载，非完整 DAW。
 */
export const DEFAULT_BGM_VOLUME = 0.35;

export const ALLOWED_BGM_PREFIXES = [
    "/api/studio/files/",
    "/api/manju/output/",
    "/api/manju/voice/",
    "/api/audio/files/",
    "/api/images/",
] as const;

export type BgmBedConfig = {
    bgm_url: string;
    bgm_volume: number;
    bgm_duck: boolean;
};

export function normalizeBgmVolume(raw: unknown): number {
    if (raw == null || raw === "") return DEFAULT_BGM_VOLUME;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_BGM_VOLUME;
    return Math.min(1, Math.max(0, n));
}

export function normalizeBgmDuck(raw: unknown): boolean {
    if (typeof raw === "boolean") return raw;
    if (raw == null) return true;
    const s = String(raw).trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(s)) return false;
    if (["1", "true", "yes", "on"].includes(s)) return true;
    return true;
}

export function normalizeBgmUrl(raw: unknown): string {
    if (raw == null) return "";
    return String(raw).trim();
}

export function isAllowedBgmUrl(url: string): boolean {
    const u = normalizeBgmUrl(url);
    if (!u) return true;
    if (u.startsWith("http://") || u.startsWith("https://")) {
        try {
            const path = new URL(u).pathname;
            return ALLOWED_BGM_PREFIXES.some((p) => path.startsWith(p));
        } catch {
            return false;
        }
    }
    if (!u.startsWith("/")) return false;
    return ALLOWED_BGM_PREFIXES.some((p) => u.startsWith(p));
}

export function bgmActive(url: string): boolean {
    return Boolean(normalizeBgmUrl(url));
}

export function bgmBedLabel(cfg: Pick<BgmBedConfig, "bgm_url" | "bgm_volume" | "bgm_duck">): string {
    if (!bgmActive(cfg.bgm_url)) return "未挂声床";
    const name = cfg.bgm_url.split("/").pop() || "音频";
    const vol = Math.round(normalizeBgmVolume(cfg.bgm_volume) * 100);
    return `${name} · ${vol}%${cfg.bgm_duck ? " · 对白闪避" : ""}`;
}

export function parseBgmFromProject(p: {
    bgm_url?: string | null;
    bgm_volume?: number | null;
    bgm_duck?: boolean | null;
} | null | undefined): BgmBedConfig {
    return {
        bgm_url: normalizeBgmUrl(p?.bgm_url),
        bgm_volume: normalizeBgmVolume(p?.bgm_volume ?? DEFAULT_BGM_VOLUME),
        bgm_duck: normalizeBgmDuck(p?.bgm_duck ?? true),
    };
}
