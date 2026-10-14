import { beforeEach, describe, expect, test } from "bun:test";

import {
    CREATION_VIEW_PRESETS_LIMIT,
    CREATION_VIEW_PRESET_NAME_LIMIT,
    normalizeCreationViewPresets,
    useCreationViewPresetsStore,
    type CreationViewPresetDraft,
} from "@/stores/use-creation-view-presets-store";

const videoDraft: CreationViewPresetDraft = {
    mode: "video",
    model: "h3",
    ratio: "16:9",
    seconds: "10",
    quality: "auto",
    videoQuality: "1080",
    count: "1",
};

const imageDraft: CreationViewPresetDraft = {
    mode: "image",
    ratio: "3:4",
    seconds: "6",
    quality: "2k",
    videoQuality: "720",
    count: "4",
};

function resetStore() {
    useCreationViewPresetsStore.setState({ presets: [] });
}

describe("creation view presets store (F10 保存视图)", () => {
    beforeEach(resetStore);

    test("savePreset stores a named snapshot of current engine params", () => {
        const saved = useCreationViewPresetsStore.getState().savePreset("竖屏 1080 快出", videoDraft);
        expect(saved).not.toBeNull();
        expect(saved?.name).toBe("竖屏 1080 快出");
        expect(saved?.mode).toBe("video");
        expect(saved?.videoQuality).toBe("1080");
        expect(useCreationViewPresetsStore.getState().presets).toHaveLength(1);
    });

    test("blank names and invalid drafts are rejected", () => {
        expect(useCreationViewPresetsStore.getState().savePreset("   ", videoDraft)).toBeNull();
        expect(useCreationViewPresetsStore.getState().savePreset("ok", { ...videoDraft, mode: "text" as never, ratio: "" })).toBeNull();
        expect(useCreationViewPresetsStore.getState().presets).toHaveLength(0);
    });

    test("same name + mode replaces the previous preset instead of duplicating", () => {
        const { savePreset } = useCreationViewPresetsStore.getState();
        savePreset("my view", videoDraft);
        savePreset("my view", { ...videoDraft, seconds: "15" });
        const presets = useCreationViewPresetsStore.getState().presets;
        expect(presets).toHaveLength(1);
        expect(presets[0].seconds).toBe("15");
    });

    test("image and video presets with the same name coexist", () => {
        const { savePreset } = useCreationViewPresetsStore.getState();
        savePreset("同名", videoDraft);
        savePreset("同名", imageDraft);
        expect(useCreationViewPresetsStore.getState().presets).toHaveLength(2);
    });

    test("deletePreset removes by id", () => {
        const saved = useCreationViewPresetsStore.getState().savePreset("to delete", imageDraft)!;
        useCreationViewPresetsStore.getState().deletePreset(saved.id);
        expect(useCreationViewPresetsStore.getState().presets).toHaveLength(0);
    });

    test("preset count is capped, newest kept first", () => {
        for (let index = 0; index < CREATION_VIEW_PRESETS_LIMIT + 5; index += 1) {
            useCreationViewPresetsStore.getState().savePreset(`view-${index}`, { ...videoDraft, ratio: `1:${index + 1}` });
        }
        const presets = useCreationViewPresetsStore.getState().presets;
        expect(presets.length).toBeLessThanOrEqual(CREATION_VIEW_PRESETS_LIMIT);
        expect(presets[0].name).toBe(`view-${CREATION_VIEW_PRESETS_LIMIT + 4}`);
    });

    test("normalizeCreationViewPresets drops malformed persisted rows and trims names", () => {
        const longName = "x".repeat(CREATION_VIEW_PRESET_NAME_LIMIT + 20);
        const normalized = normalizeCreationViewPresets([
            { id: "a", name: longName, mode: "image", ratio: "1:1", createdAt: "2026-10-15T00:00:00.000Z" },
            { id: "b", name: "", mode: "video", ratio: "16:9" },
            { id: "c", name: "no ratio", mode: "video" },
            null,
            "junk",
            { name: "missing id", mode: "image", ratio: "1:1" },
        ]);
        expect(normalized).toHaveLength(1);
        expect(normalized[0].id).toBe("a");
        expect(normalized[0].name).toHaveLength(CREATION_VIEW_PRESET_NAME_LIMIT);
        // 缺省槽位补齐默认值,套用端不需要判空
        expect(normalized[0].quality).toBe("auto");
        expect(normalized[0].count).toBe("1");
        expect(normalizeCreationViewPresets(undefined)).toEqual([]);
    });
});
