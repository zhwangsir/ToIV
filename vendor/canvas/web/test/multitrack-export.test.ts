import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// P2-9 多轨导出客户端契约:不经 stub —— Bun.serve 起本地 mock API,把 toivHttp(真实 axios
// 实例)的 baseURL 指过去,走真实 client 封装断言 URL / Content-Disposition 文件名 /
// X-Toiv-* 计数头 / JSON 错误体透出;下拉动作文案与禁用条件走纯模型。
import { toivHttp } from "../src/services/toiv/client";
import {
    STUDIO_EXPORT_ACTION_LABELS,
    STUDIO_EXPORT_NO_CLIPS_HINT,
    exportStudioMultitrackBundle,
    exportStudioTimelineEdl,
    exportStudioTimelineFcpxml,
    parseExportIssueCounts,
    studioExportMenuModel,
} from "../src/services/toiv/multitrack-export";

type Captured = { method: string; path: string };

const captured: Captured[] = [];
const originalBaseURL = toivHttp.defaults.baseURL;

const EDL_BODY = "TITLE: 雨夜\nFCM: NON-DROP FRAME\n";
const FCPXML_BODY = '<?xml version="1.0"?><xmeml version="1.9"/>';
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const url = new URL(request.url);
        captured.push({ method: request.method, path: url.pathname });
        const match = /^\/api\/studio\/projects\/([^/]+)\/export\/([^/]+)$/.exec(url.pathname);
        if (!match) return new Response("not found", { status: 404 });
        const [, pid, kind] = match;
        const json = (detail: string, status: number) =>
            new Response(JSON.stringify({ detail }), {
                status,
                headers: { "Content-Type": "application/json" },
            });
        if (pid === "p-err") return json("缺少成片片段，无法导出", 422);
        if (pid === "p-json") return json("导出内部错误", 200);
        if (pid === "p-nohdr") {
            return new Response(EDL_BODY, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        const commonHeaders = {
            "X-Toiv-Export-Format": "toiv_multitrack_export_v1",
            "X-Toiv-Missing-Assets": "2",
            "X-Toiv-Duration-Issues": "1",
        };
        if (kind === "edl") {
            return new Response(EDL_BODY, {
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Content-Disposition": "attachment; filename*=UTF-8''%E9%9B%A8%E5%A4%9C.edl",
                    ...commonHeaders,
                },
            });
        }
        if (kind === "fcpxml") {
            return new Response(FCPXML_BODY, {
                headers: {
                    "Content-Type": "application/x-fcpxml",
                    "Content-Disposition": 'attachment; filename="p-ok.fcpxml"',
                    "X-Toiv-Export-Format": "toiv_multitrack_export_v1",
                    "X-Toiv-Missing-Assets": "0",
                    "X-Toiv-Duration-Issues": "0",
                },
            });
        }
        return new Response(ZIP_BYTES, {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": "attachment; filename*=UTF-8''%E9%9B%A8%E5%A4%9C_multitrack.zip",
                ...commonHeaders,
                "X-Toiv-Video-Clips": "3",
            },
        });
    },
});

beforeAll(() => {
    toivHttp.defaults.baseURL = `${server.url.origin}/api`;
});

afterAll(() => {
    toivHttp.defaults.baseURL = originalBaseURL;
    server.stop(true);
});

describe("multitrack-export P2-9 URL 契约", () => {
    test("三种导出命中各自 /export/* 端点", async () => {
        captured.length = 0;
        await exportStudioTimelineEdl("p-ok");
        await exportStudioTimelineFcpxml("p-ok");
        await exportStudioMultitrackBundle("p-ok");
        expect(captured.map((c) => c.path)).toEqual([
            "/api/studio/projects/p-ok/export/edl",
            "/api/studio/projects/p-ok/export/fcpxml",
            "/api/studio/projects/p-ok/export/multitrack",
        ]);
    });
});

describe("multitrack-export 文件名解析", () => {
    test("filename*=UTF-8'' 与普通 filename= 及兜底名", async () => {
        const edl = await exportStudioTimelineEdl("p-ok");
        expect(edl.fileName).toBe("雨夜.edl");
        const fcpxml = await exportStudioTimelineFcpxml("p-ok");
        expect(fcpxml.fileName).toBe("p-ok.fcpxml");
        const zip = await exportStudioMultitrackBundle("p-ok");
        expect(zip.fileName).toBe("雨夜_multitrack.zip");
    });

    test("无 Content-Disposition 时用兜底文件名", async () => {
        const edl = await exportStudioTimelineEdl("p-nohdr");
        expect(edl.fileName).toBe("timeline.edl");
    });
});

describe("multitrack-export X-Toiv 计数", () => {
    test("端到端解析缺素材/时长问题/视频片段计数", async () => {
        const edl = await exportStudioTimelineEdl("p-ok");
        expect(edl.format).toBe("toiv_multitrack_export_v1");
        expect(edl.missingAssets).toBe(2);
        expect(edl.durationIssues).toBe(1);
        expect(edl.videoClips).toBeNull();
        const zip = await exportStudioMultitrackBundle("p-ok");
        expect(zip.missingAssets).toBe(2);
        expect(zip.durationIssues).toBe(1);
        expect(zip.videoClips).toBe(3);
        const clean = await exportStudioTimelineFcpxml("p-ok");
        expect(clean.missingAssets).toBe(0);
        expect(clean.durationIssues).toBe(0);
    });

    test("parseExportIssueCounts 纯解析:缺项/非法计数归 0", () => {
        expect(
            parseExportIssueCounts({
                "X-Toiv-Export-Format": "toiv_multitrack_export_v1",
                "X-Toiv-Missing-Assets": "2",
                "X-Toiv-Duration-Issues": "1",
                "X-Toiv-Video-Clips": "3",
            }),
        ).toEqual({ format: "toiv_multitrack_export_v1", missingAssets: 2, durationIssues: 1, videoClips: 3 });
        expect(parseExportIssueCounts({})).toEqual({ format: "", missingAssets: 0, durationIssues: 0, videoClips: null });
        expect(
            parseExportIssueCounts({ "x-toiv-missing-assets": "abc", "x-toiv-duration-issues": "-2" }),
        ).toEqual({ format: "", missingAssets: 0, durationIssues: 0, videoClips: null });
    });
});

describe("multitrack-export JSON 错误", () => {
    test("422 JSON detail 透出为用户可读错误", async () => {
        await expect(exportStudioTimelineEdl("p-err")).rejects.toThrow("缺少成片片段，无法导出");
    });

    test("200 但 JSON 正文按错误处理(不吞成文件)", async () => {
        await expect(exportStudioTimelineEdl("p-json")).rejects.toThrow("导出内部错误");
    });
});

describe("导出下拉动作文案/禁用条件", () => {
    test("四个动作文案:剪映草稿 / EDL 剪辑表 / FCPXML 工程 / 多轨导出包", () => {
        expect(STUDIO_EXPORT_ACTION_LABELS).toEqual({
            jianying: "剪映草稿",
            edl: "EDL 剪辑表",
            fcpxml: "FCPXML 工程",
            multitrack: "多轨导出包",
        });
        const labels = studioExportMenuModel({ ready: true }).map((item) => item.label);
        expect(labels).toEqual(["剪映草稿", "EDL 剪辑表", "FCPXML 工程", "多轨导出包"]);
    });

    test("无成片片段全禁用并提示先完成 final_clip;导出中同样禁用", () => {
        const blocked = studioExportMenuModel({ ready: false });
        expect(blocked.every((item) => item.disabled)).toBe(true);
        expect(blocked.every((item) => item.hint === STUDIO_EXPORT_NO_CLIPS_HINT)).toBe(true);
        expect(STUDIO_EXPORT_NO_CLIPS_HINT).toContain("final_clip");
        const busy = studioExportMenuModel({ ready: true, busy: true });
        expect(busy.every((item) => item.disabled)).toBe(true);
        const ready = studioExportMenuModel({ ready: true });
        expect(ready.every((item) => !item.disabled)).toBe(true);
        expect(ready.every((item) => item.hint === undefined)).toBe(true);
    });
});
