import { appHref } from "@/lib/app-routing";

/** Canonical product sections (R10补) + legacy aliases kept for old deep links. */
export type SettingsSection =
    | "models"
    | "engines"
    | "storage"
    | "general"
    | "about"
    | "common"
    | "compute"
    | "advanced"
    | "channels"
    | "preferences"
    | "prompts"
    | "runninghub"
    | "diagnostics";

const LEGACY_TO_CANONICAL: Record<string, "models" | "engines" | "storage" | "general" | "about"> = {
    common: "models",
    compute: "engines",
    advanced: "general",
    channels: "general",
    models: "models",
    preferences: "general",
    prompts: "general",
    storage: "storage",
    runninghub: "general",
    diagnostics: "about",
    engines: "engines",
    general: "general",
    about: "about",
};

export type SettingsFocus = "r18";

/** Prefer canonical IA keys in new links; legacy values still accepted by SettingsPage. */
export function settingsPath(section: SettingsSection = "models", continueCreation = false, focus?: SettingsFocus) {
    const canonical = (LEGACY_TO_CANONICAL[section] || section) as string;
    const params = new URLSearchParams({ section: canonical });
    // Preserve expert deep-links that need a specific general panel open.
    if (section === "runninghub" || section === "prompts" || section === "preferences" || section === "channels") {
        params.set("section", section);
    }
    if (section === "diagnostics") {
        params.set("section", "about");
    }
    if (continueCreation) params.set("continue", "1");
    if (focus === "r18") params.set("focus", "r18");
    return `/settings?${params.toString()}`;
}

/**
 * 画布深层组件没有路由上下文出口时统一跳转到正式设置页，避免重新引入全局配置弹窗。
 * focus=r18：打开通用段并滚动到 R18SettingsPane，触发既有两步确认（不另起对话框；无主开关）。
 */
export function navigateToSettings(options?: { section?: SettingsSection; continueCreation?: boolean; focus?: SettingsFocus }) {
    const to = settingsPath(options?.section, options?.continueCreation, options?.focus);
    const event = new CustomEvent<{ to: string }>("workspace:navigate", { detail: { to }, cancelable: true });
    if (window.dispatchEvent(event)) window.location.assign(appHref(to));
}

/** 失败卡主 CTA：跳设置 R18 两步闸。 */
export function navigateToR18SettingsGate() {
    navigateToSettings({ section: "general", focus: "r18" });
}
