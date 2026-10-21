import { describe, expect, test } from "bun:test";

import {
    DEFAULT_BGM_VOLUME,
    bgmActive,
    bgmBedLabel,
    isAllowedBgmUrl,
    normalizeBgmDuck,
    normalizeBgmVolume,
    parseBgmFromProject,
} from "../src/services/toiv/bgm-bed";

describe("bgm-bed F3", () => {
    test("normalizes volume/duck and allowlist", () => {
        expect(normalizeBgmVolume(null)).toBe(DEFAULT_BGM_VOLUME);
        expect(normalizeBgmVolume(2)).toBe(1);
        expect(normalizeBgmDuck("off")).toBe(false);
        expect(isAllowedBgmUrl("/api/studio/files/a.mp3")).toBe(true);
        expect(isAllowedBgmUrl("https://evil.test/a.mp3")).toBe(false);
        expect(bgmActive("")).toBe(false);
    });

    test("parse and label", () => {
        const cfg = parseBgmFromProject({
            bgm_url: "/api/studio/files/rain.mp3",
            bgm_volume: 0.4,
            bgm_duck: true,
        });
        expect(cfg.bgm_volume).toBe(0.4);
        expect(bgmBedLabel(cfg)).toContain("rain.mp3");
        expect(bgmBedLabel(cfg)).toContain("40%");
        expect(bgmBedLabel({ bgm_url: "", bgm_volume: 0.3, bgm_duck: true })).toBe("未挂声床");
    });
});
