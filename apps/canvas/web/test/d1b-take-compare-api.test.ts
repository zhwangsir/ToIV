import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { pickShotCandidate, toivHttp } from "../src/services/toiv/client";

type Captured = { method: string; path: string; body: unknown };

const captured: Captured[] = [];
let acceptedDigest = "digest-1";
let pickedId = "cand-a";

const server = Bun.serve({
    port: 0,
    async fetch(request) {
        const url = new URL(request.url);
        captured.push({ method: request.method, path: url.pathname, body: null });
        const index = captured.length - 1;
        const match = /^\/api\/studio\/shots\/([^/]+)\/candidates\/([^/]+)\/pick$/.exec(url.pathname);
        if (!match || request.method !== "POST") return new Response("not found", { status: 404 });
        const body = await request.json().catch(() => null) as { expected_candidates_digest?: string } | null;
        captured[index].body = body;
        if (body?.expected_candidates_digest !== undefined && body.expected_candidates_digest !== acceptedDigest) {
            return Response.json({ detail: "候选列表已变化，请刷新后重试" }, { status: 409 });
        }
        pickedId = decodeURIComponent(match[2]);
        acceptedDigest = "digest-2";
        return Response.json({
            id: decodeURIComponent(match[1]),
            idx: 1,
            status: "rendered",
            candidates_digest: acceptedDigest,
            candidates: [
                { id: "cand-a", url: "/a.mp4", status: "done", is_picked: pickedId === "cand-a" },
                { id: "cand-b", url: "/b.mp4", status: "done", is_picked: pickedId === "cand-b" },
            ],
        });
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

describe("D1b pick 真实 HTTP 契约", () => {
    test("POST 编码后的 shot/candidate path，digest 进 body，返回完整 shot 真值", async () => {
        const shot = await pickShotCandidate("shot/1", "cand-a", "digest-1");
        expect(captured.at(-1)).toMatchObject({
            method: "POST",
            path: "/api/studio/shots/shot%2F1/candidates/cand-a/pick",
            body: { expected_candidates_digest: "digest-1" },
        });
        expect(shot.candidates_digest).toBe("digest-2");
        expect(shot.candidates?.filter((candidate) => candidate.is_picked)).toHaveLength(1);
        expect(shot.candidates?.[0].is_picked).toBe(true);
    });

    test("并发拍板 409 保留 axios response，且服务端当前采用不被覆盖", async () => {
        let thrown: unknown = null;
        try {
            await pickShotCandidate("shot-1", "cand-b", "stale-digest");
        } catch (error) {
            thrown = error;
        }
        const response = (thrown as { response?: { status?: number; data?: { detail?: string } } } | null)?.response;
        expect(response?.status).toBe(409);
        expect(response?.data?.detail).toContain("候选列表已变化");
        expect(pickedId).toBe("cand-a");
    });

    test("旧调用不传 digest 保持兼容，仍返回 shot", async () => {
        acceptedDigest = "digest-legacy";
        const shot = await pickShotCandidate("shot-1", "cand-b");
        expect(captured.at(-1)?.body).toEqual({});
        expect(shot.id).toBe("shot-1");
        expect(shot.candidates?.find((candidate) => candidate.id === "cand-b")?.is_picked).toBe(true);
    });
});
