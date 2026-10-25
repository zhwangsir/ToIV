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

/** Prefer canonical IA keys in new links; legacy values still accepted by SettingsPage. */
export function settingsPath(section: SettingsSection = "common", continueCreation = false) {
    const canonical = (LEGACY_TO_CANONICAL[section] || section) as string;
    const params = new URLSearchParams({ section: canonical });
    // Preserve expert deep-links that need a specific advanced panel open.
    if (section === "runninghub" || section === "diagnostics" || section === "prompts" || section === "preferences") {
        params.set("section", section);
    }
    if (continueCreation) params.set("continue", "1");
    return `/settings?${params.toString()}`;
}

/**
 * 画布深层组件没有路由上下文出口时统一跳转到正式设置页，避免重新引入全局配置弹窗。
 */
export function navigateToSettings(options?: { section?: SettingsSection; continueCreation?: boolean }) {
    const to = settingsPath(options?.section, options?.continueCreation);
    const event = new CustomEvent<{ to: string }>("workspace:navigate", { detail: { to }, cancelable: true });
    if (window.dispatchEvent(event)) window.location.assign(appHref(to));
}
