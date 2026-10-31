import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { scopedLocalStorage } from "@/lib/user-scope";

/**
 * F10 保存视图:创作工作区的引擎参数命名预设。
 * 把当前参数(模式/模型/画幅/时长/质量/张数)存成命名预设,可套用/删除。
 * 与 use-creation-preferences-store 同一持久化范式(zustand persist +
 * 用户 scope 隔离的 localStorage);预设是小型配置,不进 localforage。
 */
export type CreationViewPresetMode = "image" | "video";

export type CreationViewPresetDraft = {
    mode: CreationViewPresetMode;
    model?: string;
    ratio: string;
    seconds: string;
    quality: string;
    videoQuality: string;
    count: string;
};

export type CreationViewPreset = CreationViewPresetDraft & {
    id: string;
    name: string;
    createdAt: string;
};

type CreationViewPresetsStore = {
    hydrated: boolean;
    presets: CreationViewPreset[];
    savePreset: (name: string, draft: CreationViewPresetDraft) => CreationViewPreset | null;
    deletePreset: (id: string) => void;
};

export const CREATION_VIEW_PRESETS_STORE_KEY = "open_ai_canvas:creation_view_presets";
export const CREATION_VIEW_PRESETS_LIMIT = 24;
export const CREATION_VIEW_PRESET_NAME_LIMIT = 40;

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && Boolean(value.trim());
}

function normalizeDraft(value: unknown): CreationViewPresetDraft | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (raw.mode !== "image" && raw.mode !== "video") return undefined;
    if (!nonEmptyString(raw.ratio)) return undefined;
    return {
        mode: raw.mode,
        ...(nonEmptyString(raw.model) ? { model: raw.model } : {}),
        ratio: raw.ratio,
        seconds: nonEmptyString(raw.seconds) ? raw.seconds : "6",
        quality: nonEmptyString(raw.quality) ? raw.quality : "auto",
        videoQuality: nonEmptyString(raw.videoQuality) ? raw.videoQuality : "720",
        count: nonEmptyString(raw.count) ? raw.count : "1",
    };
}

export function normalizeCreationViewPresets(value: unknown): CreationViewPreset[] {
    if (!Array.isArray(value)) return [];
    const out: CreationViewPreset[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const raw = item as Record<string, unknown>;
        const draft = normalizeDraft(raw);
        if (!draft || !nonEmptyString(raw.name) || !nonEmptyString(raw.id)) continue;
        out.push({
            ...draft,
            id: raw.id,
            name: raw.name.trim().slice(0, CREATION_VIEW_PRESET_NAME_LIMIT),
            createdAt: nonEmptyString(raw.createdAt) ? raw.createdAt : new Date(0).toISOString(),
        });
        if (out.length >= CREATION_VIEW_PRESETS_LIMIT) break;
    }
    return out;
}

export const useCreationViewPresetsStore = create<CreationViewPresetsStore>()(
    persist(
        (set) => ({
            hydrated: false,
            presets: [],
            savePreset: (name, draft) => {
                const trimmed = name.trim().slice(0, CREATION_VIEW_PRESET_NAME_LIMIT);
                const normalized = normalizeDraft(draft);
                if (!trimmed || !normalized) return null;
                const preset: CreationViewPreset = {
                    ...normalized,
                    id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    name: trimmed,
                    createdAt: new Date().toISOString(),
                };
                set((state) => ({
                    // 同名同模式=覆盖更新(保最新参数),其余前插;超上限淘汰最旧。
                    presets: [preset, ...state.presets.filter((item) => !(item.mode === preset.mode && item.name === preset.name))].slice(0, CREATION_VIEW_PRESETS_LIMIT),
                }));
                return preset;
            },
            deletePreset: (id) => set((state) => ({ presets: state.presets.filter((item) => item.id !== id) })),
        }),
        {
            name: CREATION_VIEW_PRESETS_STORE_KEY,
            storage: createJSONStorage(() => scopedLocalStorage),
            partialize: (state) => ({ presets: state.presets }),
            merge: (persisted, current) => {
                const stored = (persisted || {}) as Partial<CreationViewPresetsStore>;
                return { ...current, presets: normalizeCreationViewPresets(stored.presets) };
            },
            onRehydrateStorage: () => () => {
                useCreationViewPresetsStore.setState({ hydrated: true });
            },
        },
    ),
);
