import { appHref } from "@/lib/app-routing";

/** Canonical product sections + legacy aliases kept for old deep links. */
export type SettingsSection =
    | "common"
    | "compute"
    | "advanced"
    | "channels"
    | "models"
    | "preferences"
    | "prompts"
    | "storage"
    | "runninghub"
    | "diagnostics";

const LEGACY_TO_CANONICAL: Record<string, "common" | "compute" | "advanced"> = {
    channels: "compute",
    models: "common",
    preferences: "advanced",
    prompts: "advanced",
    storage: "advanced",
    runninghub: "advanced",
    diagnostics: "advanced",
};

export type SettingsFocus = "r18";

/** Prefer canonical IA keys in new links; legacy values still accepted by SettingsPage. */
export function settingsPath(section: SettingsSection = "common", continueCreation = false, focus?: SettingsFocus) {
    const canonical = (LEGACY_TO_CANONICAL[section] || section) as string;
    const params = new URLSearchParams({ section: canonical });
    // Preserve expert deep-links that need a specific advanced panel open.
    if (section === "runninghub" || section === "diagnostics" || section === "prompts" || section === "preferences") {
        params.set("section", section);
    }
    if (continueCreation) params.set("continue", "1");
    if (focus === "r18") params.set("focus", "r18");
    return `/settings?${params.toString()}`;
}

/**
 * 画布深层组件没有路由上下文出口时统一跳转到正式设置页，避免重新引入全局配置弹窗。
 * focus=r18：打开常用段并滚动到 R18SettingsPane，触发既有两步确认（不另起对话框）。
 */
export function navigateToSettings(options?: { section?: SettingsSection; continueCreation?: boolean; focus?: SettingsFocus }) {
    const to = settingsPath(options?.section, options?.continueCreation, options?.focus);
    const event = new CustomEvent<{ to: string }>("workspace:navigate", { detail: { to }, cancelable: true });
    if (window.dispatchEvent(event)) window.location.assign(appHref(to));
}

/** 失败卡主 CTA：跳设置 R18 两步闸。 */
export function navigateToR18SettingsGate() {
    navigateToSettings({ section: "common", focus: "r18" });
}
