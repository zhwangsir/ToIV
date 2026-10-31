import { describe, expect, test } from "bun:test";

// C1c 阶段进度纯函数:六阶段定义/旧数据回退/导航映射/阻断推导/动作可用性/409 提取/load 防串号。
import {
    STAGE_STATE_META,
    STUDIO_STAGES,
    createLoadSeqGuard,
    firstBlockingStage,
    hasStageStates,
    stageActionsFor,
    stageNavSection,
    stageStateOf,
    stageTransitionConflictMessage,
} from "../src/lib/studio-stage-progress";
import type { ToivDramaDetail } from "../src/services/toiv/client";

function detailWith(states: Partial<ToivDramaDetail["stage_states"]>, revision = 3): ToivDramaDetail {
    return { id: "p1", status: "draft", stage_revision: revision, stage_states: states } as ToivDramaDetail;
}

describe("STUDIO_STAGES 六阶段定义", () => {
    test("顺序与索引:script 01 → timeline 06", () => {
        expect(STUDIO_STAGES.map((s) => s.id)).toEqual([
            "script", "assets", "storyboard", "generate", "voice", "timeline",
        ]);
        expect(STUDIO_STAGES.map((s) => s.index)).toEqual(["01", "02", "03", "04", "05", "06"]);
        expect(STUDIO_STAGES.map((s) => s.label)).toEqual(["剧本", "资产", "分镜", "生成", "配音", "合成"]);
    });

    test("导航映射:覆盖实际 SECTIONS(script/assets/storyboard/shots/timeline/final)", () => {
        // 实际区段集合:generate 区段即 shots;voice→shots,timeline→timeline(不得错导航为 shots)
        expect(stageNavSection("script")).toBe("script");
        expect(stageNavSection("assets")).toBe("assets");
        expect(stageNavSection("storyboard")).toBe("storyboard");
        expect(stageNavSection("generate")).toBe("shots");
        expect(stageNavSection("voice")).toBe("shots");
        expect(stageNavSection("timeline")).toBe("timeline");
        const allowed = new Set(["script", "assets", "storyboard", "shots", "timeline", "final"]);
        for (const stage of STUDIO_STAGES) {
            expect(allowed.has(stageNavSection(stage.id)), `${stage.id} 导航合法`).toBe(true);
        }
    });
});

describe("hasStageStates / stageStateOf 旧服务端回退", () => {
    test("无 stage_states(旧服务端/无项目)→ false,不得空白崩溃", () => {
        expect(hasStageStates(null)).toBe(false);
        expect(hasStageStates(undefined)).toBe(false);
        expect(hasStageStates({} as ToivDramaDetail)).toBe(false);
        expect(hasStageStates({ id: "p1", status: "draft" } as ToivDramaDetail)).toBe(false);
    });

    test("部分阶段(旧数据残缺)→ 不启用六阶段,安全回旧四阶段", () => {
        const d = detailWith({ script: { state: "confirmed", ready: true, blockers: [] } });
        expect(hasStageStates(d)).toBe(false);
        expect(stageStateOf(d, "script")?.state).toBe("confirmed");
        expect(stageStateOf(d, "assets")).toBeUndefined();
    });

    test("六段字段齐全才启用(多一段/少一段都不算)", () => {
        const full = Object.fromEntries(
            STUDIO_STAGES.map((s) => [s.id, { state: "draft" as const, ready: false, blockers: [] }]),
        );
        expect(hasStageStates(detailWith(full))).toBe(true);
        const missingOne = { ...full };
        delete (missingOne as Record<string, unknown>).voice;
        expect(hasStageStates(detailWith(missingOne))).toBe(false);
    });
});

describe("firstBlockingStage:批量 render/assemble 409 的可执行定位入口", () => {
    const rest = {
        generate: { state: "draft" as const, ready: false, blockers: [] },
        voice: { state: "draft" as const, ready: false, blockers: [] },
        timeline: { state: "draft" as const, ready: false, blockers: [] },
    };

    test("返回最早未 confirmed/skipped 的阶段", () => {
        const d = detailWith({
            script: { state: "confirmed", ready: true, blockers: [] },
            assets: { state: "skipped", ready: false, blockers: [] },
            storyboard: { state: "generating", ready: false, blockers: [] },
            ...rest,
        });
        expect(firstBlockingStage(d)).toBe("storyboard");
    });

    test("needs_review/failed/pending_confirmation 都阻断;全通过 → null", () => {
        expect(firstBlockingStage(detailWith({
            script: { state: "needs_review", ready: true, blockers: ["质检未过"] },
            assets: { state: "confirmed", ready: true, blockers: [] },
            storyboard: { state: "confirmed", ready: true, blockers: [] },
            ...rest,
        }))).toBe("script");
        expect(firstBlockingStage(detailWith({
            script: { state: "failed", ready: false, blockers: ["生成失败"] },
            assets: { state: "confirmed", ready: true, blockers: [] },
            storyboard: { state: "confirmed", ready: true, blockers: [] },
            ...rest,
        }))).toBe("script");
        expect(firstBlockingStage(detailWith({
            script: { state: "confirmed", ready: true, blockers: [] },
            assets: { state: "confirmed", ready: true, blockers: [] },
            storyboard: { state: "skipped", ready: false, blockers: [] },
            generate: { state: "confirmed", ready: true, blockers: [] },
            voice: { state: "confirmed", ready: true, blockers: [] },
            timeline: { state: "skipped", ready: false, blockers: [] },
        }))).toBeNull();
    });

    test("无 stage_states(旧服务端)→ null,不误导导航", () => {
        expect(firstBlockingStage({ id: "p1", status: "draft" } as ToivDramaDetail)).toBeNull();
    });
});

describe("stageActionsFor:确认/跳过/重开可用性", () => {
    test("pending_confirmation → 可确认可跳过", () => {
        expect(stageActionsFor("pending_confirmation")).toEqual({
            canConfirm: true, canSkip: true, canReopen: false, confirmLabel: "确认",
        });
    });

    test("needs_review → 重开再确认(重开后可再确认)", () => {
        const a = stageActionsFor("needs_review");
        expect(a.canReopen).toBe(true);
        expect(a.confirmLabel).toContain("重开");
        expect(a.canConfirm).toBe(false);
    });

    test("confirmed/skipped 可重开;failed 不提供 reopen(后端实际 no-op);generating 无动作;draft 可跳过", () => {
        expect(stageActionsFor("confirmed").canReopen).toBe(true);
        expect(stageActionsFor("skipped").canReopen).toBe(true);
        // failed:后端 reopen 实际是 no-op,前端不提供该入口
        expect(stageActionsFor("failed")).toEqual({ canConfirm: false, canSkip: false, canReopen: false, confirmLabel: "确认" });
        expect(stageActionsFor("generating")).toEqual({ canConfirm: false, canSkip: false, canReopen: false, confirmLabel: "确认" });
        expect(stageActionsFor("draft").canSkip).toBe(true);
        expect(stageActionsFor(undefined).canSkip).toBe(true);
    });

    test("STAGE_STATE_META 覆盖全部七种状态文案", () => {
        for (const s of ["draft", "pending_confirmation", "confirmed", "generating", "failed", "needs_review", "skipped"] as const) {
            expect(STAGE_STATE_META[s].label.length).toBeGreaterThan(0);
        }
        expect(STAGE_STATE_META.needs_review.label).toContain("复核");
        expect(STAGE_STATE_META.skipped.label).toContain("跳过");
    });
});

describe("stageTransitionConflictMessage:409 → 后端 detail;非 409 → null", () => {
    test("409 提取 detail 字符串", () => {
        const e = { response: { status: 409, data: { detail: "阶段已被其他操作更新(stage_revision=9)" } } };
        expect(stageTransitionConflictMessage(e)).toContain("阶段已被其他操作更新");
    });

    test("409 无 detail → 通用冲突文案;非 409 → null 交常规错误处理", () => {
        expect(stageTransitionConflictMessage({ response: { status: 409, data: {} } })).toContain("冲突");
        expect(stageTransitionConflictMessage({ response: { status: 500, data: { detail: "x" } } })).toBeNull();
        expect(stageTransitionConflictMessage(new Error("network"))).toBeNull();
    });
});

describe("createLoadSeqGuard:项目切换/卸载时丢弃旧投影", () => {
    test("旧 seq 失活,仅最新 load 可写状态", () => {
        const guard = createLoadSeqGuard();
        const a = guard.begin();
        const b = guard.begin();
        expect(guard.isCurrent(a)).toBe(false);
        expect(guard.isCurrent(b)).toBe(true);
        const c = guard.begin();
        expect(guard.isCurrent(b)).toBe(false);
        expect(guard.isCurrent(c)).toBe(true);
    });
});
