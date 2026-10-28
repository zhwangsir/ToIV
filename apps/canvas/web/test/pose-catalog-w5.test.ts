import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
    filterPoseGroups,
    listPoseEntries,
    listPoseSystems,
    poseImgUrl,
    poseThumbUrl,
    visiblePoseSystems,
} from "../src/lib/pose-catalog";
import {
    isPoseSystemAdultOnly,
    isPoseSystemVisible,
    POSE_ADULT_ONLY_SYSTEMS,
} from "../src/redline";
import { POSE_GALLERY_IMG_PATH, POSE_GALLERY_THUMB_PATH } from "../src/lib/media-library-routes";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("W5 pose-catalog loader", () => {
    test("JSON index lives under lib/pose-catalog (not ignored data/)", () => {
        expect(existsSync(join(root, "src/lib/pose-catalog/pose-zh.json"))).toBe(true);
        expect(existsSync(join(root, "src/lib/pose-catalog/meta-zh.json"))).toBe(true);
        expect(listPoseEntries().length).toBeGreaterThan(1000);
        expect(listPoseSystems()).toEqual([
            "全身单人・性感系",
            "全身单人・标准系",
            "上半身单人",
            "双人缠绵",
        ]);
    });

    test("URL builders use POSE_GALLERY_* and never /static", () => {
        const entry = listPoseEntries()[0]!;
        const thumb = poseThumbUrl(entry);
        const img = poseImgUrl(entry);
        expect(thumb.startsWith(POSE_GALLERY_THUMB_PATH + "/")).toBe(true);
        expect(img.startsWith(POSE_GALLERY_IMG_PATH + "/")).toBe(true);
        expect(thumb.includes("/static")).toBe(false);
        expect(img.includes("/static")).toBe(false);
        // path is /api/pose-gallery/thumbs|{img}/{file} — file itself must be basename only
        expect(thumb.split("/").pop()!.includes("/")).toBe(false);
        expect(img.split("/").pop()!.includes("/")).toBe(false);
        expect(thumb.split("/").pop()!).not.toMatch(/^(thumbs|img)$/);
        expect(listPoseEntries()[0]!.缩略图.startsWith("thumbs/")).toBe(true); // source field still relative
    });

    test("filterPoseGroups: adult systems hidden when adultOn=false", () => {
        const sfw = filterPoseGroups({ adultOn: false });
        expect(sfw.every((g) => !isPoseSystemAdultOnly(g.体系))).toBe(true);
        expect(sfw.some((g) => g.体系 === "全身单人・标准系")).toBe(true);
        expect(sfw.some((g) => g.体系 === "上半身单人")).toBe(true);

        const adult = filterPoseGroups({ adultOn: true });
        expect(adult.some((g) => g.体系 === "全身单人・性感系")).toBe(true);
        expect(adult.some((g) => g.体系 === "双人缠绵")).toBe(true);
        expect(adult.length).toBeGreaterThan(sfw.length);
    });

    test("filterPoseGroups: system + category + query", () => {
        const rows = filterPoseGroups({
            adultOn: false,
            system: "全身单人・标准系",
            category: "站姿",
            query: "站姿",
        });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((g) => g.体系 === "全身单人・标准系" && g.分类 === "站姿")).toBe(true);
        const byId = filterPoseGroups({ adultOn: false, query: listPoseEntries().find((e) => e.体系 === "全身单人・标准系")!.姿势编号.toLowerCase() });
        expect(byId.length).toBeGreaterThan(0);
    });
});

describe("W5 pose redline gate", () => {
    test("adult-only systems are exactly 性感系 + 双人缠绵", () => {
        expect([...POSE_ADULT_ONLY_SYSTEMS]).toEqual(["全身单人・性感系", "双人缠绵"]);
        expect(isPoseSystemAdultOnly("全身单人・性感系")).toBe(true);
        expect(isPoseSystemAdultOnly("双人缠绵")).toBe(true);
        expect(isPoseSystemAdultOnly("全身单人・标准系")).toBe(false);
        expect(isPoseSystemAdultOnly("上半身单人")).toBe(false);
    });

    test("isPoseSystemVisible respects adultOn (underage closed via isR18Mode callers)", () => {
        expect(isPoseSystemVisible("全身单人・标准系", false)).toBe(true);
        expect(isPoseSystemVisible("上半身单人", false)).toBe(true);
        expect(isPoseSystemVisible("全身单人・性感系", false)).toBe(false);
        expect(isPoseSystemVisible("双人缠绵", false)).toBe(false);
        expect(isPoseSystemVisible("全身单人・性感系", true)).toBe(true);
        expect(isPoseSystemVisible("双人缠绵", true)).toBe(true);
        expect(visiblePoseSystems(false)).not.toContain("双人缠绵");
        expect(visiblePoseSystems(true)).toContain("双人缠绵");
    });
});

describe("W5 pose mounts (source smoke)", () => {
    test("ToolsIntentGrid mounts pose-ref → PoseBrowser modal", () => {
        const src = read("src/components/toiv/tools-intent-grid.tsx");
        expect(src).toContain('data-intent="pose-ref"');
        expect(src).toContain("PoseBrowser");
        expect(src).toContain("tools-intent-pose-ref");
        expect(src).not.toContain("/static");
    });

    test("create mounts PosePicker + creationAttachmentFromPose", () => {
        const index = read("src/pages/create/index.tsx");
        const assets = read("src/pages/create/creation-assets.ts");
        const workspace = read("src/pages/create/creation-workspace.tsx");
        expect(index).toContain("PosePicker");
        expect(index).toContain("posePickerOpen");
        expect(index).toContain("creationAttachmentFromPose");
        expect(assets).toContain("creationAttachmentFromPose");
        expect(assets).toContain("poseImgUrl");
        expect(workspace).toContain("create-open-pose-picker");
        expect(workspace).toContain("从姿势库选");
    });

    test("library poses track uses PoseBrowser inside MediaLibraryPage shell", () => {
        const shell = read("src/pages/library/media-library-page.tsx");
        expect(shell).toContain("PosesTrack");
        expect(shell).toContain("PoseBrowser");
        expect(shell).toContain("media-library-poses-track");
        expect(shell).not.toContain("PosesComingSoonTrack");
        expect(shell).not.toContain("姿势库即将接入");
        expect(shell).toContain("never /static"); // comment redline
        expect(shell).not.toContain('href="/static');
        expect(shell).not.toContain('"/static/');
    });
});
