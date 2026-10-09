/**
 * M2 /toiv/library/:id 作品库详情：变体折叠 + 页面/客户端契约表面。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    canvasAddPathForMedia,
    classifyMediaUrl,
    filenameFromMediaUrl,
    formatRetention,
    groupBoardEntries,
    listJobMedia,
    primaryMedia,
    variantKeyOf,
    type BoardEntry,
} from "../src/services/toiv/library-group";
import type { ToivBoardItem } from "../src/services/toiv/client";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

function item(partial: {
    id: number;
    sort?: number;
    job?: ToivBoardItem["job"];
}): ToivBoardItem {
    return {
        id: partial.id,
        sort_order: partial.sort ?? partial.id,
        shot_text: "",
        shot_meta: "",
        job: partial.job ?? null,
    };
}

describe("library-group variant/batch fold", () => {
    test("variantKeyOf skips null seed and system kinds", () => {
        expect(variantKeyOf({ id: "a", status: "done", created_at: "", seed: null, kind: "t2v", prompt: "x" })).toBe("");
        expect(variantKeyOf({ id: "b", status: "done", created_at: "", seed: 1, kind: "app_cover_demo", prompt: "x" })).toBe("");
        expect(variantKeyOf({ id: "c", status: "done", created_at: "", seed: 7, kind: "t2v", prompt: " hi " })).toBe("v:t2v:7:hi");
    });

    test("groupBoardEntries folds batch_id and variant groups when enabled", () => {
        const items = [
            item({ id: 1, job: { id: "j1", status: "done", created_at: "", kind: "t2v", seed: 1, prompt: "same", results: ["/a.png"] } }),
            item({ id: 2, job: { id: "j2", status: "done", created_at: "", kind: "t2v", seed: 1, prompt: "same", results: ["/b.png"] } }),
            item({ id: 3, job: { id: "j3", status: "done", created_at: "", kind: "orbit", batch_id: "b1", results: ["/c.png"] } }),
            item({ id: 4, job: { id: "j4", status: "done", created_at: "", kind: "orbit", batch_id: "b1", results: ["/d.png"] } }),
            item({ id: 5, job: null }),
        ];
        const folded = groupBoardEntries(items, { groupVariants: true });
        const types = folded.map((e: BoardEntry) => e.type);
        expect(types.filter((t) => t === "folder").length).toBe(2);
        expect(types.filter((t) => t === "item").length).toBe(1);
        const flat = groupBoardEntries(items, { groupVariants: false });
        // batch still folds; variants become plain items → 1 folder + 3 items
        expect(flat.filter((e) => e.type === "folder").length).toBe(1);
        expect(flat.filter((e) => e.type === "item").length).toBe(3);
    });

    test("formatRetention Chinese remaining", () => {
        expect(formatRetention(0)).toBe("已到期");
        expect(formatRetention(90)).toContain("分钟");
        expect(formatRetention(7200)).toContain("小时");
        expect(formatRetention(90000)).toContain("天");
    });
});

describe("library-detail page + client surface", () => {
    test("client exports board/trash APIs and richer job fields", () => {
        const src = read("src/services/toiv/client.ts");
        for (const name of [
            "fetchBoardItems",
            "deleteBoard",
            "putBoardItems",
            "deleteJob",
            "undoDeleteJob",
            "fetchTrash",
            "restoreJob",
            "permanentDeleteJob",
            "bulkDeleteJobs",
            "ToivBoardItemJob",
            "batch_id",
            "seed",
        ]) {
            expect(src).toContain(name);
        }
    });

    test("detail page wires preview/recycle/variant/trash/delete-board", () => {
        const src = read("src/pages/toiv/library-detail.tsx");
        expect(src).toContain("groupBoardEntries");
        expect(src).toContain("fetchTrash");
        expect(src).toContain("deleteBoard");
        expect(src).toContain("bulkDeleteJobs");
        expect(src).toContain("变体已折叠");
        expect(src).toContain("移入回收站");
        expect(src).toContain("从作品集移除");
        expect(src).toContain("/library?source=works");
    });

    test("detail deepen: rename/export/download/canvas/audio preview/metadata", () => {
        const src = read("src/pages/toiv/library-detail.tsx");
        expect(src).toContain("patchBoard");
        expect(src).toContain("exportBoardJson");
        expect(src).toContain("listJobMedia");
        expect(src).toContain("primaryMedia");
        expect(src).toContain("canvasAddPathForMedia");
        expect(src).toContain("改名作品集");
        expect(src).toContain("导出 JSON");
        expect(src).toContain("在画布打开");
        expect(src).toContain("<audio");
        expect(src).toContain("作业 id");
        expect(src).toContain("triggerBrowserDownload");
    });

    test("client exports patchBoard and exportBoardJson", () => {
        const src = read("src/services/toiv/client.ts");
        expect(src).toContain("export async function patchBoard");
        expect(src).toContain("export async function exportBoardJson");
        expect(src).toContain("/boards/${boardId}/export");
    });

    test("router keeps /library/works/:id and legacy /toiv/library/:id redirect", () => {
        const src = read("src/router.tsx");
        expect(src).toContain('path: "/library/works/:id"');
        expect(src).toContain('path: "/toiv/library/:id"');
        expect(src).toContain("library-detail");
        expect(src).toContain("ToivLibraryDetailRedirect");
    });
});

describe("library media classify / canvas path", () => {
    test("classifyMediaUrl by extension and kind", () => {
        expect(classifyMediaUrl("https://x/a.mp4")).toBe("video");
        expect(classifyMediaUrl("https://x/a.wav")).toBe("audio");
        expect(classifyMediaUrl("https://x/a.png")).toBe("image");
        expect(classifyMediaUrl("/api/jobs/1/result", "t2v")).toBe("video");
        expect(classifyMediaUrl("/api/jobs/1/result", "tts")).toBe("audio");
        expect(classifyMediaUrl("/api/jobs/1/result", "t2i")).toBe("image");
        expect(classifyMediaUrl("")).toBe("unknown");
    });

    test("listJobMedia dedupes and primaryMedia picks first", () => {
        const medias = listJobMedia({
            kind: "t2v",
            results: ["https://x/a.mp4", "https://x/a.mp4", "https://x/b.png"],
        });
        expect(medias).toHaveLength(2);
        expect(medias[0]?.kind).toBe("video");
        expect(medias[1]?.kind).toBe("image");
        expect(primaryMedia({ results: [], kind: "t2v" })).toBeNull();
        expect(primaryMedia({ results: ["https://x/c.wav"], kind: "tts" })?.kind).toBe("audio");
    });

    test("canvasAddPathForMedia and filenameFromMediaUrl", () => {
        expect(canvasAddPathForMedia("image")).toBe("/canvas?mode=new&add=image");
        expect(canvasAddPathForMedia("video")).toBe("/canvas?mode=new&add=video");
        expect(canvasAddPathForMedia("audio")).toBe("/canvas?mode=new&add=audio");
        expect(filenameFromMediaUrl("https://cdn/x/foo.mp4?sig=1")).toBe("foo.mp4");
        expect(filenameFromMediaUrl("/api/noext", "fallback.bin")).toBe("fallback.bin");
    });
});
