import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// C1a 真实 HTTP 契约测试:不经任何 stub client 导出 —— 用 Bun.serve 起真实 HTTP 服务器,
// 把 toivHttp(真实 axios 实例)的 baseURL 指过去,走真实 axios 传输 + 真实 client 封装,
// 断言 URL / 请求体 / 响应解包。证明浏览器组件消费的是真实 API 形状,不是 mock 函数。
import {
    fetchShotRevisionDiff,
    fetchShotRevisions,
    rollbackShotRevision,
    saveStudioShots,
    toivHttp,
} from "../src/services/toiv/client";

type Captured = { method: string; path: string; body: unknown };

// 服务端可变状态:rollback 仅在 expected_revision 匹配时落改,用于证明 409 不覆盖服务端内容
let serverCurrentRevision = "r9";
let serverPrompt = "服务端现行提示语";

const server = Bun.serve({
    port: 0,
    async fetch(request) {
        const url = new URL(request.url);
        captured.push({ method: request.method, path: url.pathname, body: null });
        const index = captured.length - 1;
        const reply = (data: unknown) => {
            captured[index].body = null;
            return Response.json(data);
        };
        if (url.pathname === "/api/studio/shots/s1/revisions" && request.method === "GET") {
            return reply({
                shot_id: "s1",
                revisions: [
                    {
                        id: "r9",
                        version: 2,
                        source: "manual-edit",
                        parent_id: "r8",
                        visual_fingerprint: "vf9",
                        audio_fingerprint: "af9",
                        created_by: "u1",
                        created_at: "2026-10-26T10:00:00",
                    },
                ],
            });
        }
        if (url.pathname === "/api/studio/shots/s1/revisions/r9/diff" && request.method === "GET") {
            return reply({
                revision_id: "r9",
                version: 2,
                source: "manual-edit",
                from_version: 1,
                from_unknown: false,
                fields: { prompt: { from: "旧", to: "新" } },
            });
        }
        if (url.pathname === "/api/studio/shots/s1/rollback" && request.method === "POST") {
            const body = await request.json().catch(() => null) as { revision_id?: string; expected_revision?: string } | null;
            captured[index].body = body;
            if (body?.expected_revision != null && body.expected_revision !== serverCurrentRevision) {
                return Response.json({ detail: `分镜已被其他修改更新(current=${serverCurrentRevision})` }, { status: 409 });
            }
            serverPrompt = "回滚后的提示语";
            return Response.json({
                id: "s1",
                idx: 1,
                status: "draft",
                prompt: serverPrompt,
                current_revision_id: "r10",
                visual_media_status: "current",
                audio_media_status: "stale",
                final_media_status: "stale",
            });
        }
        if (url.pathname === "/api/studio/projects/p1/shots" && request.method === "PUT") {
            captured[index].body = await request.json().catch(() => null);
            return Response.json({ shots: [] });
        }
        return new Response("not found", { status: 404 });
    },
});

const captured: Captured[] = [];
const originalBaseURL = toivHttp.defaults.baseURL;

beforeAll(() => {
    toivHttp.defaults.baseURL = `${server.url.origin}/api`;
    captured.length = 0;
});

afterAll(() => {
    toivHttp.defaults.baseURL = originalBaseURL;
    server.stop(true);
});

describe("C1a 修订 API 真实 HTTP 契约", () => {
    test("GET revisions → /studio/shots/:sid/revisions,响应解包修订列表", async () => {
        const list = await fetchShotRevisions("s1");
        expect(captured.at(-1)).toMatchObject({ method: "GET", path: "/api/studio/shots/s1/revisions" });
        expect(list.shot_id).toBe("s1");
        expect(list.revisions).toHaveLength(1);
        expect(list.revisions[0]).toMatchObject({
            id: "r9",
            version: 2,
            source: "manual-edit",
            parent_id: "r8",
            visual_fingerprint: "vf9",
            audio_fingerprint: "af9",
            created_by: "u1",
            created_at: "2026-10-26T10:00:00",
        });
    });

    test("GET diff → /studio/shots/:sid/revisions/:rid/diff,字段级 from/to 解包", async () => {
        const diff = await fetchShotRevisionDiff("s1", "r9");
        expect(captured.at(-1)).toMatchObject({ method: "GET", path: "/api/studio/shots/s1/revisions/r9/diff" });
        expect(diff).toMatchObject({
            revision_id: "r9",
            version: 2,
            source: "manual-edit",
            from_version: 1,
            from_unknown: false,
        });
        expect(diff.fields.prompt).toEqual({ from: "旧", to: "新" });
    });

    test("POST rollback → 请求体 {revision_id},返回 shot 全量投影(含 stale 投影)", async () => {
        const shot = await rollbackShotRevision("s1", "r9");
        const last = captured.at(-1);
        expect(last).toMatchObject({ method: "POST", path: "/api/studio/shots/s1/rollback" });
        expect(last?.body).toEqual({ revision_id: "r9" });
        expect(shot).toMatchObject({
            id: "s1",
            current_revision_id: "r10",
            visual_media_status: "current",
            audio_media_status: "stale",
        });
    });

    test("rollback 带 expected_revision → 请求体携带;匹配才落改并返回新投影(final_media_status 透传)", async () => {
        const shot = await rollbackShotRevision("s1", "r8", serverCurrentRevision);
        const last = captured.at(-1);
        expect(last).toMatchObject({ method: "POST", path: "/api/studio/shots/s1/rollback" });
        expect(last?.body).toEqual({ revision_id: "r8", expected_revision: "r9" });
        expect(shot.prompt).toBe("回滚后的提示语");
        expect(shot.current_revision_id).toBe("r10");
        expect(shot.final_media_status).toBe("stale");
    });

    test("rollback expected_revision 不符 → 409 拒绝且服务端内容不被覆盖", async () => {
        const before = serverPrompt;
        let thrown: unknown = null;
        try {
            await rollbackShotRevision("s1", "r8", "rev-outdated");
        } catch (e) {
            thrown = e;
        }
        expect(thrown).not.toBeNull();
        // axios 形态 409 可被冲突 helper 识别(前端据此走「丢弃+刷新」)
        const resp = (thrown as { response?: { status?: number; data?: { detail?: string } } })?.response;
        expect(resp?.status).toBe(409);
        expect(resp?.data?.detail).toContain("分镜已被其他修改更新");
        expect(captured.at(-1)?.body).toEqual({ revision_id: "r8", expected_revision: "rev-outdated" });
        expect(serverPrompt).toBe(before);
    });

    test("PUT shots → 全量路径 + expected_revision 原样进请求体", async () => {
        await saveStudioShots("p1", [
            { id: "s1", scene: "a", prompt: "p", expected_revision: "r10" },
            { id: "s2", scene: "b", prompt: "q", expected_revision: "" },
        ]);
        const last = captured.at(-1);
        expect(last).toMatchObject({ method: "PUT", path: "/api/studio/projects/p1/shots" });
        const body = last?.body as { shots: { id: string; expected_revision?: string }[] };
        expect(body.shots.map((x) => x.expected_revision)).toEqual(["r10", ""]);
    });
});
