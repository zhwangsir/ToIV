import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// C1b 配方 API 真实 HTTP 契约测试:不经 stub client —— Bun.serve 起真实 HTTP 服务器,
// 把 toivHttp(真实 axios 实例)的 baseURL 指过去,走真实 axios 传输 + 真实 client 封装,
// 断言 URL / 请求体 / 响应解包 / 409 不覆盖 / 422 校验错误透出。
import {
    applyRecipe,
    cloneRecipe,
    createRecipeFromShot,
    deleteRecipe,
    exportRecipe,
    fetchRecipe,
    fetchRecipeDiff,
    fetchRecipes,
    importRecipe,
    patchRecipe,
    renderShotAsync,
    setDefaultRecipe,
    toivHttp,
} from "../src/services/toiv/client";

type Captured = { method: string; path: string; query: string; body: unknown; status: number };

const captured: Captured[] = [];
const originalBaseURL = toivHttp.defaults.baseURL;

// 服务端可变状态:apply 仅在 expected_revision 匹配时落改(证明 409 不覆盖)
let shotCurrentRevision = "rev-9";
let shotPrompt = "服务端现行提示语";

const SNAPSHOT = {
    engine: "h3",
    render_mode: "video",
    pipeline: "ref2va",
    pick_strategy: "auto_best",
    prompt: "雨夜霓虹",
    negative: "低清",
    camera: "推近",
    duration_sec: 6,
    num_candidates: 2,
    seed: 42,
    ref_images: ["/refs/a.png"],
    scene_images: ["/scenes/b.png"],
    ref_style: "toon",
    accel: null,
    ref_epoch: 0,
    ref_epoch_note: null,
    scene_ref_json: null,
    width: 720,
    height: 1280,
    fps: 24,
    ckpt_name: "h3-v23",
};

function recipeRow(id: string, over: Record<string, unknown> = {}) {
    return {
        id,
        name: `配方 ${id}`,
        description: "描述",
        engine: "h3",
        render_mode: "video",
        pipeline: "ref2va",
        pick_strategy: "auto_best",
        snapshot: SNAPSHOT,
        source_revision_id: "rev-1",
        source_shot_id: "shot-1",
        is_default: false,
        created_at: "2026-10-26T10:00:00",
        updated_at: "2026-10-26T10:00:00",
        ...over,
    };
}

const server = Bun.serve({
    port: 0,
    async fetch(request) {
        const url = new URL(request.url);
        captured.push({ method: request.method, path: url.pathname, query: url.search, body: null, status: 200 });
        const index = captured.length - 1;
        const reply = (data: unknown, status = 200) => {
            captured[index].status = status;
            return Response.json(data, { status });
        };
        const p = url.pathname;
        if (p === "/api/studio/recipes/from-shot" && request.method === "POST") {
            captured[index].body = await request.json().catch(() => null);
            const b = captured[index].body as { shot_id?: string };
            if (!b?.shot_id) return reply({ detail: "shot_id 必填" }, 422);
            return reply(recipeRow("r-new", { name: (b && (captured[index].body as { name?: string }).name) || "配方·shot-1" }));
        }
        if (p === "/api/studio/recipes" && request.method === "GET") {
            const engine = url.searchParams.get("engine");
            const rows = [recipeRow("r-1"), recipeRow("r-2", { engine: "ltx", is_default: true })];
            return reply({ recipes: engine ? rows.filter((r) => r.engine === engine) : rows });
        }
        const m = /^\/api\/studio\/recipes\/([^/]+)(\/(clone|set-default|export|diff|apply|import))?$/.exec(p);
        if (m) {
            const rid = m[1];
            const sub = m[3];
            if (!sub && request.method === "GET") return reply(recipeRow(rid));
            if (!sub && request.method === "PATCH") {
                captured[index].body = await request.json().catch(() => null);
                return reply(recipeRow(rid, { pick_strategy: "manual" }));
            }
            if (!sub && request.method === "DELETE") return reply({ deleted: true, id: rid });
            if (sub === "clone" && request.method === "POST") {
                captured[index].body = await request.json().catch(() => null);
                return reply(recipeRow("r-clone", { name: (captured[index].body as { name?: string })?.name || "配方 r-1 副本" }));
            }
            if (sub === "set-default" && request.method === "POST") return reply(recipeRow(rid, { is_default: true }));
            if (sub === "export" && request.method === "GET") {
                return reply({
                    schema: "toiv_generation_recipe_v1",
                    name: `配方 ${rid}`,
                    description: "描述",
                    engine: "h3",
                    render_mode: "video",
                    pipeline: "ref2va",
                    pick_strategy: "auto_best",
                    snapshot: SNAPSHOT,
                    exported_at: "2026-10-27T00:00:00",
                });
            }
            if (sub === "diff" && request.method === "GET") {
                return reply({
                    recipe_id: rid,
                    shot_id: url.searchParams.get("shot_id"),
                    fields: { prompt: { from: "旧提示语", to: "雨夜霓虹" } },
                    render_params: {
                        video_model: "h3",
                        auto_pick: true,
                        wait: true,
                        pipeline: "ref2va",
                        num_candidates: 2,
                        seed: 42,
                    },
                });
            }
            if (sub === "apply" && request.method === "POST") {
                const b = (await request.json().catch(() => null)) as {
                    shot_id?: string; expected_revision?: string; apply_project_specs?: boolean;
                } | null;
                captured[index].body = b;
                if (b?.expected_revision != null && b.expected_revision !== shotCurrentRevision) {
                    return reply({ detail: `分镜已被其他修改更新(current=${shotCurrentRevision})` }, 409);
                }
                shotPrompt = "应用配方后的提示语";
                return reply({
                    shot: { id: b?.shot_id, prompt: shotPrompt, current_revision_id: "rev-10" },
                    render_params: {
                        video_model: "h3",
                        auto_pick: false,
                        wait: true,
                        pipeline: "ref2va",
                        num_candidates: 2,
                        seed: 42,
                        ref_images: ["/refs/a.png"],
                        ref_style: "toon",
                    },
                    applied_fields: ["prompt", "negative", "camera", "duration_sec", "video_model", "render_mode"],
                    project_specs_changed: b?.apply_project_specs ? ["width", "height"] : [],
                });
            }
        }
        if (p === "/api/studio/recipes/import" && request.method === "POST") {
            const body = await request.json().catch(() => null);
            captured[index].body = body;
            if (!body || (body as { schema?: string }).schema !== "toiv_generation_recipe_v1") {
                return reply({ detail: "schema 须为 toiv_generation_recipe_v1" }, 422);
            }
            return reply(recipeRow("r-imported", { name: (body as { name?: string }).name || "导入配方" }));
        }
        if (p === "/api/studio/shots/s1/render" && request.method === "POST") {
            captured[index].body = await request.json().catch(() => null);
            return reply({ job_id: "job-1" }, 202);
        }
        return new Response("not found", { status: 404 });
    },
});

beforeAll(() => {
    toivHttp.defaults.baseURL = `${server.url.origin}/api`;
    captured.length = 0;
});

afterAll(() => {
    toivHttp.defaults.baseURL = originalBaseURL;
    server.stop(true);
});

describe("C1b 配方 API 真实 HTTP 契约", () => {
    test("POST from-shot → /studio/recipes/from-shot,body 携带 shot_id/name/description", async () => {
        const r = await createRecipeFromShot("shot-1", { name: "我的配方", description: "雨夜模板" });
        expect(captured.at(-1)).toMatchObject({ method: "POST", path: "/api/studio/recipes/from-shot" });
        expect(captured.at(-1)?.body).toEqual({ shot_id: "shot-1", name: "我的配方", description: "雨夜模板" });
        expect(r.id).toBe("r-new");
        expect(r.snapshot.prompt).toBe("雨夜霓虹");
        expect(r.is_default).toBe(false);
    });

    test("GET 列表 → /studio/recipes;engine 过滤走查询参数;空集合是空数组", async () => {
        const all = await fetchRecipes();
        expect(captured.at(-1)).toMatchObject({ method: "GET", path: "/api/studio/recipes", query: "" });
        expect(all).toHaveLength(2);
        const ltx = await fetchRecipes("ltx");
        expect(captured.at(-1)?.query).toBe("?engine=ltx");
        expect(ltx.map((x) => x.engine)).toEqual(["ltx"]);
    });

    test("GET 详情 / PATCH / DELETE 走 /studio/recipes/:id", async () => {
        await fetchRecipe("r-1");
        expect(captured.at(-1)).toMatchObject({ method: "GET", path: "/api/studio/recipes/r-1" });
        await patchRecipe("r-1", { prompt: "新提示语", negative: "新负向词", pick_strategy: "manual" });
        expect(captured.at(-1)).toMatchObject({ method: "PATCH", path: "/api/studio/recipes/r-1" });
        expect(captured.at(-1)?.body).toEqual({ prompt: "新提示语", negative: "新负向词", pick_strategy: "manual" });
        await deleteRecipe("r-1");
        expect(captured.at(-1)).toMatchObject({ method: "DELETE", path: "/api/studio/recipes/r-1" });
    });

    test("PATCH 只传部分字段 → 请求体只含该字段(不伪造空串清空)", async () => {
        await patchRecipe("r-1", { name: "只改名字" });
        expect(captured.at(-1)?.body).toEqual({ name: "只改名字" });
    });

    test("clone → POST /:id/clone {name?};set-default → POST /:id/set-default", async () => {
        await cloneRecipe("r-1", "克隆版");
        expect(captured.at(-1)).toMatchObject({ method: "POST", path: "/api/studio/recipes/r-1/clone" });
        expect(captured.at(-1)?.body).toEqual({ name: "克隆版" });
        const dup = await cloneRecipe("r-1");
        expect(captured.at(-1)?.body).toEqual({});
        expect(dup.name).toContain("副本");
        const def = await setDefaultRecipe("r-2");
        expect(captured.at(-1)).toMatchObject({ method: "POST", path: "/api/studio/recipes/r-2/set-default" });
        expect(def.is_default).toBe(true);
    });

    test("export → GET /:id/export 返回 toiv_generation_recipe_v1 形状(含 snapshot/exported_at)", async () => {
        const exp = await exportRecipe("r-1");
        expect(captured.at(-1)).toMatchObject({ method: "GET", path: "/api/studio/recipes/r-1/export" });
        expect(exp.schema).toBe("toiv_generation_recipe_v1");
        expect(exp.name).toBe("配方 r-1");
        expect(exp.snapshot.ckpt_name).toBe("h3-v23");
        expect(exp.exported_at).toBeTruthy();
    });

    test("import → POST /studio/recipes/import;校验失败 422 且 detail 透出(不落半成品)", async () => {
        let thrown: unknown = null;
        try {
            await importRecipe({ schema: "wrong", name: "x" });
        } catch (e) {
            thrown = e;
        }
        expect(thrown).not.toBeNull();
        expect(captured.at(-1)).toMatchObject({ method: "POST", path: "/api/studio/recipes/import", status: 422 });
        const detail = (thrown as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
        expect(detail).toContain("schema 须为 toiv_generation_recipe_v1");
        const ok = await importRecipe({ schema: "toiv_generation_recipe_v1", name: "导入的配方", snapshot: {} });
        expect(ok.id).toBe("r-imported");
        expect(ok.name).toBe("导入的配方");
    });

    test("diff → GET /:id/diff?shot_id=,字段级 from/to + render_params 解包", async () => {
        const diff = await fetchRecipeDiff("r-1", "shot-1");
        expect(captured.at(-1)).toMatchObject({ method: "GET", path: "/api/studio/recipes/r-1/diff" });
        expect(captured.at(-1)?.query).toBe("?shot_id=shot-1");
        expect(diff.fields.prompt).toEqual({ from: "旧提示语", to: "雨夜霓虹" });
        expect(diff.render_params).toMatchObject({ video_model: "h3", auto_pick: true, num_candidates: 2, seed: 42 });
    });

    test("apply → POST /:id/apply {shot_id,expected_revision,apply_project_specs};返回 shot+render_params+applied_fields", async () => {
        const res = await applyRecipe("r-1", { shot_id: "shot-1", expected_revision: shotCurrentRevision, apply_project_specs: true });
        expect(captured.at(-1)).toMatchObject({ method: "POST", path: "/api/studio/recipes/r-1/apply" });
        expect(captured.at(-1)?.body).toEqual({ shot_id: "shot-1", expected_revision: "rev-9", apply_project_specs: true });
        expect(res.shot.prompt).toBe("应用配方后的提示语");
        expect(res.render_params.auto_pick).toBe(false);
        expect(res.applied_fields).toContain("prompt");
        expect(res.project_specs_changed).toEqual(["width", "height"]);
    });

    test("apply 不带 expected_revision → 请求体不带该键(对齐后端可选语义)", async () => {
        await applyRecipe("r-1", { shot_id: "shot-1" });
        expect(captured.at(-1)?.body).toEqual({ shot_id: "shot-1", apply_project_specs: false });
    });

    test("apply expected_revision 不符 → 409 抛出且服务端内容不被覆盖", async () => {
        const before = shotPrompt;
        let thrown: unknown = null;
        try {
            await applyRecipe("r-1", { shot_id: "shot-1", expected_revision: "rev-outdated" });
        } catch (e) {
            thrown = e;
        }
        expect(thrown).not.toBeNull();
        const resp = (thrown as { response?: { status?: number; data?: { detail?: string } } })?.response;
        expect(resp?.status).toBe(409);
        expect(resp?.data?.detail).toContain("分镜已被其他修改更新");
        expect(shotPrompt).toBe(before);
    });
});

describe("renderShotAsync(C1b 扩参:配方 render_params 透传)", () => {
    test("默认不变:num_candidates=2 / wait=false / pipeline=ref2va,无多余键", async () => {
        await renderShotAsync("s1");
        expect(captured.at(-1)?.body).toEqual({ num_candidates: 2, wait: false, pipeline: "ref2va" });
    });

    test("配方参数透传:auto_pick/seed/ref_images/scene_images/ref_style/video_model", async () => {
        await renderShotAsync("s1", {
            num_candidates: 3,
            accel: "h3_acc8",
            pipeline: "c",
            force_direct: true,
            auto_pick: false,
            seed: 42,
            ref_images: ["/refs/a.png"],
            scene_images: ["/scenes/b.png"],
            ref_style: "toon",
            video_model: "ltx",
        });
        expect(captured.at(-1)?.body).toEqual({
            num_candidates: 3,
            wait: false,
            pipeline: "c",
            accel: "h3_acc8",
            force_direct: true,
            auto_pick: false,
            seed: 42,
            ref_images: ["/refs/a.png"],
            scene_images: ["/scenes/b.png"],
            ref_style: "toon",
            video_model: "ltx",
        });
    });

    test("auto_pick=true 也透传(不省略),seed=0 不丢", async () => {
        await renderShotAsync("s1", { auto_pick: true, seed: 0 });
        const body = captured.at(-1)?.body as Record<string, unknown>;
        expect(body.auto_pick).toBe(true);
        expect(body.seed).toBe(0);
        expect(body).not.toHaveProperty("ref_images");
    });
});
