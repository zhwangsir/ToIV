import { describe, expect, test } from "bun:test";

// C1b 配方面板纯函数单测:字段标签 / 导入文本解析 / 错误透出 / 导出文件名 /
// render_params 摘要 / 可快照性预判。组件行为见 shot-recipe-panel.browser.test.ts。
import {
    RECIPE_FIELD_LABELS,
    RECIPE_PICK_STRATEGY_LABELS,
    canSaveRecipeFromShot,
    parseRecipeImportText,
    recipeErrorMessage,
    recipeExportFilename,
    recipeFieldLabel,
    recipePickStrategyLabel,
    recipeRenderParamSummary,
    sanitizeRecipeExportForDownload,
} from "../src/components/toiv/shot-recipe-panel";
import type { ToivDramaShot } from "../src/services/toiv/client";

describe("recipeFieldLabel(diff 字段中文标签)", () => {
    test("覆盖 apply 可能涉及的镜头字段", () => {
        expect(RECIPE_FIELD_LABELS.prompt).toBe("提示语");
        expect(RECIPE_FIELD_LABELS.negative).toBe("负向词");
        expect(RECIPE_FIELD_LABELS.camera).toBe("运镜");
        expect(RECIPE_FIELD_LABELS.duration_sec).toBe("时长");
        expect(RECIPE_FIELD_LABELS.video_model).toBe("视频模型");
        expect(RECIPE_FIELD_LABELS.render_mode).toBe("生成方式");
        expect(RECIPE_FIELD_LABELS.ref_epoch).toBe("参考纪元");
        expect(RECIPE_FIELD_LABELS.ref_epoch_note).toBe("纪元备注");
        expect(RECIPE_FIELD_LABELS.scene_ref_json).toBe("场景引用");
        expect(RECIPE_FIELD_LABELS.ref_images).toBe("参考图");
    });

    test("未知字段原样返回(不伪造标签)", () => {
        expect(recipeFieldLabel("future_field")).toBe("future_field");
    });
});

describe("sanitizeRecipeExportForDownload(导出下载前脱敏:与后端 recipes.strip_url_secret 同口径)", () => {
    const base = {
        schema: "toiv_generation_recipe_v1" as const,
        name: "x",
        description: "",
        engine: "h3",
        render_mode: "video",
        pipeline: "ref2va",
        pick_strategy: "auto_best" as const,
        snapshot: {},
        exported_at: "",
    };

    test("/api/images 保留 filename/subfolder/worker/type 定位参数,sig 等敏感 query 剥除", () => {
        const out = sanitizeRecipeExportForDownload({
            ...base,
            snapshot: {
                ref_images: ["/api/images?filename=a.png&worker=comfy0&subfolder=refs&type=output&sig=SECRET&token=abc"],
            },
        });
        expect(out.snapshot.ref_images).toEqual([
            "/api/images?filename=a.png&subfolder=refs&worker=comfy0&type=output",
        ]);
    });

    test("其他路径 query 全剥(签名/密钥不进导出文件)", () => {
        const out = sanitizeRecipeExportForDownload({
            ...base,
            snapshot: {
                ref_images: ["/refs/a.png?sig=SECRET&exp=1", "/refs/b.png#frag"],
                scene_images: ["/scenes/c.png?token=abc"],
            },
        });
        expect(out.snapshot.ref_images).toEqual(["/refs/a.png", "/refs/b.png"]);
        expect(out.snapshot.scene_images).toEqual(["/scenes/c.png"]);
    });

    test("绝对 URL 剥 userinfo(凭据)与其余 query,保留 host:port 与可定位路径", () => {
        const out = sanitizeRecipeExportForDownload({
            ...base,
            snapshot: {
                ref_images: ["http://user:pass@worker.internal:8188/view?filename=a.png&key=k"],
                scene_images: ["https://cdn.example.com/s/c.png?auth=zzz"],
            },
        });
        expect(out.snapshot.ref_images).toEqual(["http://worker.internal:8188/view"]);
        expect(out.snapshot.scene_images).toEqual(["https://cdn.example.com/s/c.png"]);
    });

    test("非法 URL 不抛崩溃、不回显秘密(整项置空)", () => {
        const out = sanitizeRecipeExportForDownload({
            ...base,
            snapshot: { ref_images: ["http://host:badport/x?sig=SECRET", ""] },
        });
        expect(out.snapshot.ref_images).toEqual(["", ""]);
        expect(JSON.stringify(out)).not.toContain("SECRET");
    });

    test("裸文件名原样(去 query);执行面参数出现即剥除", () => {
        const out = sanitizeRecipeExportForDownload({
            ...base,
            snapshot: {
                ref_images: ["a.png?sig=1"],
                worker_url: "http://10.0.0.1:9000",
                context_latent_path: "/tmp/x.latent",
                parent_chain_job_id: "job-1",
            },
        } as never);
        expect(out.snapshot.ref_images).toEqual(["a.png"]);
        expect(out.snapshot).not.toHaveProperty("worker_url");
        expect(out.snapshot).not.toHaveProperty("context_latent_path");
        expect(out.snapshot).not.toHaveProperty("parent_chain_job_id");
    });

    test("scene_ref_json:有效 JSON 保留结构,anchor_image 同法脱敏", () => {
        const out = sanitizeRecipeExportForDownload({
            ...base,
            snapshot: {
                scene_ref_json: JSON.stringify({
                    anchor_id: "master",
                    anchor_image: "/api/images?filename=scene.png&worker=comfy0&sig=SECRET",
                    scene_name: "便利店",
                }),
            },
        });
        const parsed = JSON.parse(out.snapshot.scene_ref_json as string) as {
            anchor_id: string; anchor_image: string; scene_name: string;
        };
        expect(parsed.anchor_id).toBe("master");
        expect(parsed.scene_name).toBe("便利店");
        expect(parsed.anchor_image).toBe("/api/images?filename=scene.png&worker=comfy0");
    });

    test("scene_ref_json:非 JSON 游离字符串按 URL 同法脱敏;不 mutate 入参", () => {
        const input = {
            ...base,
            snapshot: {
                scene_ref_json: "/api/images?filename=old.png&sig=SECRET",
                num_candidates: 2,
            },
        } as never;
        const out = sanitizeRecipeExportForDownload(input);
        expect(out.snapshot.scene_ref_json).toBe("/api/images?filename=old.png");
        expect((input.snapshot as { scene_ref_json: string }).scene_ref_json).toContain("sig=SECRET");
        expect(out.snapshot.num_candidates).toBe(2);
    });
});

describe("pick strategy 标签", () => {
    test("auto_best/manual 中文标签;未知原样返回", () => {
        expect(RECIPE_PICK_STRATEGY_LABELS.auto_best).toBe("自动择优");
        expect(RECIPE_PICK_STRATEGY_LABELS.manual).toBe("手动挑选");
        expect(recipePickStrategyLabel("manual")).toBe("手动挑选");
        expect(recipePickStrategyLabel("weird")).toBe("weird");
    });
});

describe("canSaveRecipeFromShot(可快照性预判,与后端口径一致)", () => {
    const base: ToivDramaShot = { id: "s1", idx: 1, status: "draft" };

    test("有渲染修订/内容修订/任一媒体 URL 即可保存", () => {
        expect(canSaveRecipeFromShot({ ...base, rendered_revision_id: "r1" })).toBe(true);
        expect(canSaveRecipeFromShot({ ...base, current_revision_id: "r2" })).toBe(true);
        expect(canSaveRecipeFromShot({ ...base, video_url: "/v.mp4" })).toBe(true);
        expect(canSaveRecipeFromShot({ ...base, image_url: "/i.png" })).toBe(true);
    });

    test("全新空镜不可保存(后端同样 422,前端先禁用并给提示)", () => {
        expect(canSaveRecipeFromShot(base)).toBe(false);
        expect(canSaveRecipeFromShot({ ...base, video_url: "  " })).toBe(false);
    });
});

describe("parseRecipeImportText(导入 JSON 文本解析)", () => {
    test("合法 JSON → ok + payload", () => {
        const r = parseRecipeImportText('{"schema":"toiv_generation_recipe_v1","name":"x"}');
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.payload).toMatchObject({ schema: "toiv_generation_recipe_v1" });
    });

    test("非 JSON / 非对象 → 本地可读错误(不发请求)", () => {
        expect(parseRecipeImportText("not json").ok).toBe(false);
        const arr = parseRecipeImportText("[1,2]");
        expect(arr.ok).toBe(false);
        if (!arr.ok) expect(arr.error).toContain("JSON 对象");
    });
});

describe("recipeErrorMessage(错误透出:409 优先,其次后端 detail)", () => {
    test("409 + detail → 冲突说明(不覆盖语义)", () => {
        const e = { response: { status: 409, data: { detail: "分镜已被其他修改更新(current=rev-9)" } } };
        expect(recipeErrorMessage(e, "应用失败")).toBe("分镜已被其他修改更新(current=rev-9)");
    });

    test("422 detail → 服务端校验原文(导入错误展示)", () => {
        const e = { response: { status: 422, data: { detail: "schema 须为 toiv_generation_recipe_v1" } } };
        expect(recipeErrorMessage(e, "导入失败")).toContain("schema 须为");
    });

    test("无 detail → Error.message;兜底 fallback", () => {
        expect(recipeErrorMessage(new Error("网络抖动"), "导入失败")).toBe("网络抖动");
        expect(recipeErrorMessage(null, "导入失败")).toBe("导入失败");
    });
});

describe("recipeExportFilename(导出下载文件名)", () => {
    test("名称清洗 + _recipe.json 后缀;空名兜底", () => {
        expect(recipeExportFilename("雨夜 配方/v2")).toBe("雨夜_配方_v2_recipe.json");
        expect(recipeExportFilename("  ")).toBe("toiv-recipe_recipe.json");
    });

    test("超长截断", () => {
        const name = recipeExportFilename("a".repeat(80));
        expect(name.endsWith("_recipe.json")).toBe(true);
        expect(name.length).toBeLessThan(60);
    });
});

describe("recipeRenderParamSummary(render_params 可读摘要)", () => {
    test("覆盖已知键并跳过空值", () => {
        const s = recipeRenderParamSummary({
            video_model: "h3",
            auto_pick: false,
            wait: true,
            pipeline: "ref2va",
            num_candidates: 3,
            seed: 42,
            ref_style: "toon",
            accel: "h3_acc8",
            ref_images: ["/a.png"],
            scene_images: [],
        });
        expect(s).toContain("视频模型 h3");
        expect(s).toContain("管线 ref2va");
        expect(s).toContain("候选 3");
        expect(s).toContain("seed 42");
        expect(s).toContain("手动挑选");
        expect(s).toContain("参考图 1 张");
        expect(s).not.toContain("场景图");
    });

    test("auto_pick=true → 自动择优;空参数 → 空数组", () => {
        expect(recipeRenderParamSummary({ auto_pick: true }).join("")).toContain("自动择优");
        expect(recipeRenderParamSummary({})).toEqual([]);
    });
});
