import { describe, expect, test } from "bun:test";

import {
    REVISION_FIELD_LABELS,
    buildShotsSavePayload,
    revisionSourceLabel,
    shotInspectorActions,
    shotMediaBadges,
    shotSaveConflictMessage,
    showFinalClipFreshBadge,
} from "../src/components/toiv/shot-revision-inspector";
import type { ToivDramaShot } from "../src/services/toiv/client";

function shot(partial: Partial<ToivDramaShot>): ToivDramaShot {
    return {
        id: "shot-1",
        idx: 1,
        status: "draft",
        scene: "雨夜天台",
        prompt: "初始提示语",
        dialogue: "初始台词",
        speaker: "林晚",
        camera: "推近",
        duration_sec: 6,
        characters: ["林晚"],
        render_mode: "video",
        seam_to_next: "hardcut",
        ...partial,
    };
}

describe("buildShotsSavePayload(C1a 全量 PUT 构造)", () => {
    const shots: ToivDramaShot[] = [
        shot({ id: "a", idx: 1, current_revision_id: "rev-a2" }),
        shot({ id: "b", idx: 2, current_revision_id: "rev-b1", dialogue: "别跟着我" }),
        shot({ id: "c", idx: 3 }), // 旧行:无 current_revision_id
    ];

    test("全量携带每一镜,不打丢、不改单镜语义", () => {
        const payload = buildShotsSavePayload(shots, {
            patch: { id: "b", fields: { prompt: "改后的提示语" } },
        });
        expect(payload.map((x) => x.id)).toEqual(["a", "b", "c"]);
        expect(payload[1].prompt).toBe("改后的提示语");
        expect(payload[0].prompt).toBe("初始提示语");
        expect(payload[2].prompt).toBe("初始提示语");
    });

    test("每镜都带 expected_revision=current_revision_id(旧行空串对齐后端 or 比较)", () => {
        const payload = buildShotsSavePayload(shots);
        expect(payload[0].expected_revision).toBe("rev-a2");
        expect(payload[1].expected_revision).toBe("rev-b1");
        expect(payload[2].expected_revision).toBe("");
    });

    test("时间线覆盖(时长/衔接)与镜字段全量保留", () => {
        const payload = buildShotsSavePayload(shots, {
            durationSec: { b: 9 },
            seamToNext: { a: "continue" },
        });
        expect(payload[1].duration_sec).toBe(9);
        expect(payload[0].duration_sec).toBe(6);
        expect(payload[0].seam_to_next).toBe("continue");
        expect(payload[2].seam_to_next).toBe("hardcut");
        expect(payload[1].dialogue).toBe("别跟着我");
        expect(payload[1].speaker).toBe("林晚");
        expect(payload[1].camera).toBe("推近");
        expect(payload[1].characters).toEqual(["林晚"]);
        expect(payload[1].render_mode).toBe("video");
    });

    test("ref_epoch/ref_epoch_note 随镜透传(与后端 ShotInput 契约对齐,不丢失)", () => {
        const withEpoch = shots.map((x) =>
            x.id === "a" ? { ...x, ref_epoch: "ep3", ref_epoch_note: "定妆后" } : x,
        );
        const payload = buildShotsSavePayload(withEpoch);
        expect(payload[0].ref_epoch).toBe("ep3");
        expect(payload[0].ref_epoch_note).toBe("定妆后");
        // 无值 → null(后端 None=不改),不伪造空串覆盖
        expect(payload[1].ref_epoch ?? null).toBeNull();
    });
});

describe("shotSaveConflictMessage(409 乐观并发)", () => {
    test("axios 形态 409 + detail → 返回后端冲突说明", () => {
        const err = {
            response: { status: 409, data: { detail: "分镜已被其他修改更新(current=rev-9)" } },
        };
        expect(shotSaveConflictMessage(err)).toBe("分镜已被其他修改更新(current=rev-9)");
    });

    test("409 无 detail → 通用冲突文案", () => {
        expect(shotSaveConflictMessage({ response: { status: 409 } })).toContain("已被其他修改更新");
    });

    test("非 409 / 普通错误 → null", () => {
        expect(shotSaveConflictMessage({ response: { status: 400, data: { detail: "x" } } })).toBeNull();
        expect(shotSaveConflictMessage(new Error("network"))).toBeNull();
        expect(shotSaveConflictMessage(null)).toBeNull();
    });
});

describe("shotMediaBadges(只消费 API 真值)", () => {
    test("visual stale → 视觉待重渲;不牵连配音", () => {
        const badges = shotMediaBadges(shot({ visual_media_status: "stale", audio_media_status: "current" }));
        expect(badges.map((b) => b.label)).toEqual(["视觉待重渲"]);
    });

    test("audio stale → 配音待重录", () => {
        const badges = shotMediaBadges(shot({ visual_media_status: "current", audio_media_status: "stale" }));
        expect(badges.map((b) => b.label)).toEqual(["配音待重录"]);
    });

    test("unknown → 明示未知;none/current → 不显示", () => {
        expect(shotMediaBadges(shot({ visual_media_status: "unknown", audio_media_status: "none" })).map((b) => b.label)).toEqual(["视觉状态未知"]);
        expect(shotMediaBadges(shot({ visual_media_status: "current", audio_media_status: "current" }))).toEqual([]);
        expect(shotMediaBadges(shot({ visual_media_status: "none", audio_media_status: "none" }))).toEqual([]);
    });

    test("final stale → 成片待重合成;final unknown → 诚实未知;none/current → 不显示", () => {
        const stale = shotMediaBadges(shot({ visual_media_status: "current", audio_media_status: "current", final_media_status: "stale" }));
        expect(stale.map((b) => b.label)).toEqual(["成片待重合成"]);
        expect(stale[0].tone).toBe("warning");
        expect(shotMediaBadges(shot({ final_media_status: "unknown" })).map((b) => b.label)).toEqual(["成片状态未知"]);
        expect(shotMediaBadges(shot({ final_media_status: "none" }))).toEqual([]);
        expect(shotMediaBadges(shot({ final_media_status: "current" }))).toEqual([]);
    });
});

describe("showFinalClipFreshBadge(成片段 success 不伪装最新)", () => {
    test("final stale/unknown → 不显示 success;current/字段缺失(旧数据)→ 维持原样", () => {
        expect(showFinalClipFreshBadge(shot({ final_clip_url: "/f.mp4", final_media_status: "stale" }))).toBe(false);
        expect(showFinalClipFreshBadge(shot({ final_clip_url: "/f.mp4", final_media_status: "unknown" }))).toBe(false);
        expect(showFinalClipFreshBadge(shot({ final_clip_url: "/f.mp4", final_media_status: "current" }))).toBe(true);
        expect(showFinalClipFreshBadge(shot({ final_clip_url: "/f.mp4" }))).toBe(true);
        expect(showFinalClipFreshBadge(shot({ final_media_status: "current" }))).toBe(false);
    });
});

describe("shotInspectorActions.口型主操作统一(同屏只有一个)", () => {
    test("final stale + voice/video 可用 → 唯一主操作「重对口型」", () => {
        const a = shotInspectorActions(
            shot({ final_clip_url: "/f.mp4", voice_url: "/v.wav", video_url: "/m.mp4", final_media_status: "stale" }),
            { busy: false, makeupReady: true },
        );
        expect(a.canLipsync).toBe(true);
        expect(a.lipsyncLabel).toBe("重对口型");
    });

    test("普通已配音镜(非 final stale)→ 唯一主操作「对口型」", () => {
        const a = shotInspectorActions(
            shot({ status: "voiced", voice_url: "/v.wav", video_url: "/m.mp4", final_media_status: "current" }),
            { busy: false, makeupReady: true },
        );
        expect(a.canLipsync).toBe(true);
        expect(a.lipsyncLabel).toBe("对口型");
    });

    test("final stale 缺 video、busy、lipsyncing/lipsynced、无 voice_url → 不可", () => {
        const opts = { busy: false, makeupReady: true };
        expect(shotInspectorActions(shot({ final_media_status: "stale", voice_url: "/v.wav" }), opts).canLipsync).toBe(false);
        expect(shotInspectorActions(shot({ final_media_status: "stale", voice_url: "/v.wav", video_url: "/m.mp4" }), { busy: true, makeupReady: true }).canLipsync).toBe(false);
        expect(shotInspectorActions(shot({ status: "lipsyncing", voice_url: "/v.wav", video_url: "/m.mp4" }), opts).canLipsync).toBe(false);
        expect(shotInspectorActions(shot({ status: "lipsynced", voice_url: "/v.wav", video_url: "/m.mp4" }), opts).canLipsync).toBe(false);
        expect(shotInspectorActions(shot({ status: "voiced", video_url: "/m.mp4" }), opts).canLipsync).toBe(false);
    });
});

describe("shotInspectorActions(stale 也可重渲/重配音)", () => {
    test("status=rendered 且 visual stale → 可重渲染", () => {
        const a = shotInspectorActions(shot({ status: "rendered", video_url: "/v.mp4", visual_media_status: "stale" }), { busy: false, makeupReady: true });
        expect(a.canRender).toBe(true);
        expect(a.renderLabel).toBe("重渲染");
    });

    test("status=rendered 无 stale → 不可再渲染", () => {
        const a = shotInspectorActions(shot({ status: "rendered", visual_media_status: "current" }), { busy: false, makeupReady: true });
        expect(a.canRender).toBe(false);
    });

    test("status=voiced 且 audio stale(已有旧配音)→ 可重配音,不强制删旧媒体", () => {
        const a = shotInspectorActions(
            shot({ status: "voiced", voice_url: "/old.wav", audio_media_status: "stale" }),
            { busy: false, makeupReady: true },
        );
        expect(a.canVoice).toBe(true);
        expect(a.voiceLabel).toBe("重配音");
    });

    test("rendered 无配音且无 stale → 可首配;busy 时全部禁用", () => {
        expect(shotInspectorActions(shot({ status: "rendered", dialogue: "你好" }), { busy: false, makeupReady: true }).canVoice).toBe(true);
        expect(shotInspectorActions(shot({ status: "rendered", dialogue: "你好" }), { busy: true, makeupReady: true }).canVoice).toBe(false);
        expect(shotInspectorActions(shot({ status: "draft" }), { busy: false, makeupReady: true }).canRender).toBe(true);
    });
});

describe("修订历史文案", () => {
    test("source 标签映射", () => {
        expect(revisionSourceLabel("manual-edit")).toBe("手工编辑");
        expect(revisionSourceLabel("rollback")).toBe("回滚");
        expect(revisionSourceLabel("imported")).toBe("导入");
        expect(revisionSourceLabel("render")).toBe("生成");
        expect(revisionSourceLabel("future-x")).toBe("future-x");
    });

    test("diff 字段标签覆盖 prompt/dialogue 主编辑面", () => {
        expect(REVISION_FIELD_LABELS.prompt).toBe("提示语");
        expect(REVISION_FIELD_LABELS.dialogue).toBe("台词");
    });
});
