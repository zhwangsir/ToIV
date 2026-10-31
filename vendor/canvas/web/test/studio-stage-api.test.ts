import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// C1c 阶段轨道真实 HTTP 契约测试:不经任何 stub client 导出 —— 用 Bun.serve 起真实 HTTP 服务器,
// 把 toivHttp(真实 axios 实例)的 baseURL 指过去,走真实 axios 传输 + 真实 client 封装,
// 断言 stage-transition / stages/history 的 URL / 请求体 / 响应解包 / 409 错误传播。
// 契约来源(后端真值,不改后端):
//   GET  /api/studio/projects/{pid}            → 已含 stage_states + stage_revision
//   POST /api/studio/projects/{pid}/stage-transition  body {stage, action: confirm|skip|reopen, note?, expected_stage_revision?}
//                                              → {project_id, stage, stage_states, stage_revision};CAS 失败保持 HTTP 409 detail
//   GET  /api/studio/projects/{pid}/stages/history?stage=  → {history:[{id,stage,from_state,to_state,source,note,created_by,created_at}]} 新到旧
import {
    fetchDramaProject,
    fetchStageHistory,
    toivHttp,
    transitionProjectStage,
} from "../src/services/toiv/client";

type Captured = { method: string; path: string; query: string; body: unknown };

const captured: Captured[] = [];
let serverStageRevision = 7;
let serverScriptState = "pending_confirmation";

const STAGE_STATES = {
    script: { state: "pending_confirmation", ready: true, blockers: [] },
    assets: { state: "draft", ready: false, blockers: ["角色定妆未完成"] },
    storyboard: { state: "draft", ready: false, blockers: [] },
    generate: { state: "draft", ready: false, blockers: [] },
    voice: { state: "draft", ready: false, blockers: [] },
    timeline: { state: "draft", ready: false, blockers: [] },
} as const;

const HISTORY = [
    { id: "h3", stage: "script", from_state: "draft", to_state: "pending_confirmation", source: "agent", note: null, created_by: "agent-1", created_at: "2026-10-27T09:12:00" },
    { id: "h2", stage: "script", from_state: "confirmed", to_state: "draft", source: "manual", note: "台词还要改", created_by: "u1", created_at: "2026-10-27T08:40:00" },
    { id: "h1", stage: "assets", from_state: "draft", to_state: "skipped", source: "manual", note: "复用旧项目资产", created_by: "u1", created_at: "2026-10-26T18:02:00" },
];

const server = Bun.serve({
    port: 0,
    async fetch(request) {
        const url = new URL(request.url);
        captured.push({ method: request.method, path: url.pathname, query: url.search, body: null });
        const index = captured.length - 1;
        if (url.pathname === "/api/studio/projects/p1" && request.method === "GET") {
            return Response.json({
                id: "p1",
                title: "雨夜",
                status: "draft",
                stage_revision: serverStageRevision,
                stage_states: { ...STAGE_STATES, script: { ...STAGE_STATES.script, state: serverScriptState } },
            });
        }
        if (url.pathname === "/api/studio/projects/p1/stage-transition" && request.method === "POST") {
            const body = await request.json().catch(() => null) as {
                stage?: string;
                action?: string;
                note?: string;
                expected_stage_revision?: number;
            } | null;
            captured[index].body = body;
            // CAS:expected_stage_revision 与服务端不符 → 409(与后端契约一致,保持 HTTP 409 detail)
            if (body?.expected_stage_revision != null && body.expected_stage_revision !== serverStageRevision) {
                return Response.json(
                    { detail: `阶段已被其他操作更新(stage_revision=${serverStageRevision})` },
                    { status: 409 },
                );
            }
            if (body?.action === "skip" && !(body.note ?? "").trim()) {
                // 与后端真实契约一致:跳过缺说明 → HTTP 409
                return Response.json({ detail: "跳过必须填写说明" }, { status: 409 });
            }
            serverStageRevision += 1;
            if (body?.stage === "script" && body.action === "confirm") serverScriptState = "confirmed";
            if (body?.stage === "script" && body.action === "reopen") serverScriptState = "draft";
            return Response.json({
                project_id: "p1",
                stage: body?.stage ?? "script",
                stage_revision: serverStageRevision,
                stage_states: { ...STAGE_STATES, script: { ...STAGE_STATES.script, state: serverScriptState } },
            });
        }
        if (url.pathname === "/api/studio/projects/p1/stages/history" && request.method === "GET") {
            const stage = url.searchParams.get("stage");
            const history = stage ? HISTORY.filter((h) => h.stage === stage) : HISTORY;
            return Response.json({ history });
        }
        return new Response("not found", { status: 404 });
    },
});

const originalBaseURL = toivHttp.defaults.baseURL;

beforeAll(() => {
    toivHttp.defaults.baseURL = `${server.url.origin}/api`;
    captured.length = 0;
});

afterAll(() => {
    toivHttp.defaults.baseURL = originalBaseURL;
    server.stop(true);
});

describe("C1c 阶段 API 真实 HTTP 契约", () => {
    test("GET project → stage_states 六阶段 + stage_revision 透传(扩展现有 ToivDramaDetail,不另造类型)", async () => {
        const detail = await fetchDramaProject("p1");
        expect(captured.at(-1)).toMatchObject({ method: "GET", path: "/api/studio/projects/p1" });
        expect(detail.stage_revision).toBe(7);
        expect(Object.keys(detail.stage_states ?? {}).sort()).toEqual(
            ["assets", "generate", "script", "storyboard", "timeline", "voice"].sort(),
        );
        expect(detail.stage_states?.script).toEqual({ state: "pending_confirmation", ready: true, blockers: [] });
        expect(detail.stage_states?.assets).toEqual({ state: "draft", ready: false, blockers: ["角色定妆未完成"] });
    });

    test("POST stage-transition(confirm)→ 路径/body(stage+action+expected_stage_revision)/响应解包", async () => {
        const r = await transitionProjectStage("p1", { stage: "script", action: "confirm", expected_stage_revision: 7 });
        const last = captured.at(-1);
        expect(last).toMatchObject({ method: "POST", path: "/api/studio/projects/p1/stage-transition" });
        expect(last?.body).toEqual({ stage: "script", action: "confirm", expected_stage_revision: 7 });
        expect(r.project_id).toBe("p1");
        expect(r.stage).toBe("script");
        expect(r.stage_revision).toBe(8);
        expect(r.stage_states.script?.state).toBe("confirmed");
    });

    test("POST stage-transition(skip)→ note 原样进请求体", async () => {
        const r = await transitionProjectStage("p1", {
            stage: "assets",
            action: "skip",
            note: "复用旧项目资产",
            expected_stage_revision: 8,
        });
        const last = captured.at(-1);
        expect(last?.body).toEqual({ stage: "assets", action: "skip", note: "复用旧项目资产", expected_stage_revision: 8 });
        expect(r.stage_revision).toBe(9);
    });

    test("POST stage-transition(reopen)→ action 透传", async () => {
        await transitionProjectStage("p1", { stage: "script", action: "reopen", expected_stage_revision: 9 });
        expect(captured.at(-1)?.body).toMatchObject({ stage: "script", action: "reopen", expected_stage_revision: 9 });
    });

    test("CAS 不符 → HTTP 409 + detail 错误传播到调用方(前端据此提示并刷新真源)", async () => {
        let thrown: unknown = null;
        try {
            await transitionProjectStage("p1", { stage: "script", action: "confirm", expected_stage_revision: 1 });
        } catch (e) {
            thrown = e;
        }
        expect(thrown).not.toBeNull();
        const resp = (thrown as { response?: { status?: number; data?: { detail?: string } } })?.response;
        expect(resp?.status).toBe(409);
        expect(resp?.data?.detail).toContain("阶段已被其他操作更新");
        // 服务端 revision 未被旧基线覆盖
        const detail = await fetchDramaProject("p1");
        expect(detail.stage_revision).toBe(10);
    });

    test("GET stages/history → 带 ?stage= 过滤,新到旧解包", async () => {
        const all = await fetchStageHistory("p1");
        expect(captured.at(-1)).toMatchObject({
            method: "GET",
            path: "/api/studio/projects/p1/stages/history",
        });
        expect(all.history).toHaveLength(3);
        expect(all.history[0].id).toBe("h3");
        const filtered = await fetchStageHistory("p1", "script");
        expect(captured.at(-1)?.query).toBe("?stage=script");
        expect(filtered.history.map((h) => h.id)).toEqual(["h3", "h2"]);
        expect(filtered.history[0]).toMatchObject({
            stage: "script",
            from_state: "draft",
            to_state: "pending_confirmation",
            source: "agent",
            created_by: "agent-1",
            created_at: "2026-10-27T09:12:00",
        });
    });
});
