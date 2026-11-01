import type {
    CapabilityEngine, CapabilityIssue, CapabilityParam, CapabilitySlot, ToolCapabilities,
} from "./capabilities";

export type SettingsSectionId = "appearance" | "colors" | "layout" | "models";

export type SettingsSection = {
    id: SettingsSectionId;
    label: string;
    hint: string;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
    { id: "appearance", label: "外观", hint: "主题预设与我的主题" },
    { id: "colors", label: "颜色", hint: "色板与对比度" },
    { id: "layout", label: "排版", hint: "密度、圆角与内容宽度" },
    { id: "models", label: "模型与渠道", hint: "能力、槽位与端点状态" },
];

export const LOCAL_PRICING = {
    label: "本地算力 · 免费",
    note: "自有集群 GPU，不按次计费；消耗本机算力与排队时间。",
};

export type ModelSheetParam = { key: string; label: string; summary: string };

export type ModelSheetEngine = {
    id: string;
    label: string;
    kind: string;
    nsfw: boolean;
    available: boolean;
    reason: string;
    route: string;
    params: ModelSheetParam[];
    durations: string[];
};

export type ModelSheetIssue = { id: string; title: string; reason: string };

export type ModelSheetGroup = {
    id: string;
    label: string;
    available: boolean;
    reason: string;
    price: string;
    priceNote: string;
    coverage: string[];
    impact: string[];
    engines: ModelSheetEngine[];
    issues: ModelSheetIssue[];
};

export type ModelSheet = {
    groups: ModelSheetGroup[];
    issues: number;
    available: number;
    total: number;
};

function optionDefaultLabel(param: CapabilityParam): string {
    const selected = param.options.find((option) => String(option.value) === String(param.default));
    return selected?.label ?? "";
}

export function paramSummary(param: CapabilityParam): string {
    if (param.options.length) {
        const defaultLabel = optionDefaultLabel(param);
        if (defaultLabel) return `默认 ${defaultLabel} · 共 ${param.options.length} 档`;
        return `共 ${param.options.length} 档`;
    }
    if (param.min !== null || param.max !== null) {
        return `${param.min ?? "?"}–${param.max ?? "?"}`;
    }
    return param.default === undefined || param.default === null || param.default === "" ? "未声明" : String(param.default);
}

export function durationTiers(engine: CapabilityEngine): string[] {
    const param = engine.params.find((entry) => entry.key === "duration");
    return param ? param.options.map((option) => option.label) : [];
}

export function issuesForSlot(issue: CapabilityIssue, slot: CapabilitySlot): boolean {
    if (issue.id === `slot-${slot.id}-empty`) return true;
    if (slot.id === "image" && issue.id === "tool-image-unavailable") return true;
    if (slot.id === "video" && issue.id === "tool-video-unavailable") return true;
    return false;
}

export function buildModelSheet(caps: ToolCapabilities | null): ModelSheet {
    if (!caps) return { groups: [], issues: 0, available: 0, total: 0 };
    const groups = caps.slots.map((slot) => ({
        id: slot.id,
        label: slot.label,
        available: slot.available,
        reason: slot.unavailableReason,
        price: LOCAL_PRICING.label,
        priceNote: LOCAL_PRICING.note,
        coverage: [...slot.affects],
        impact: slot.available ? [] : [...slot.affects],
        engines: slot.engines.map((engine) => ({
            id: engine.id,
            label: engine.label,
            kind: engine.kind,
            nsfw: engine.nsfw,
            available: engine.available,
            reason: engine.unavailableReason,
            route: engine.route ?? "",
            params: engine.params.map((param) => ({
                key: param.key,
                label: param.label,
                summary: paramSummary(param),
            })),
            durations: durationTiers(engine),
        })),
        issues: caps.issues
            .filter((issue) => issuesForSlot(issue, slot))
            .map((issue) => ({ id: issue.id, title: issue.title, reason: issue.reason })),
    }));
    return {
        groups,
        issues: caps.issues.length,
        available: groups.filter((group) => group.available).length,
        total: groups.length,
    };
}

export function settingsIssueMarkers(
    caps: ToolCapabilities | null,
    options: { contrastOk: boolean; modelsError?: boolean },
): Record<SettingsSectionId, number> {
    return {
        appearance: 0,
        colors: options.contrastOk ? 0 : 1,
        layout: 0,
        models: caps ? caps.issues.length : options.modelsError ? 1 : 0,
    };
}
