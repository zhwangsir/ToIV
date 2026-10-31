import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioShell } from "../src/studio/shell/StudioShell";
import { FaceSwitcher } from "../src/studio/ui/FaceSwitcher";
import { SlidingTabs } from "../src/studio/ui/SlidingTabs";
import { StatusDot, STATUS_LABEL } from "../src/studio/ui/StatusDot";
import { useStudioToast } from "../src/studio/ui/toast-store";
import { Button } from "../src/studio/ui/Button";
import { Field } from "../src/studio/ui/Field";
import { TakeStrip } from "../src/studio/ui/TakeStrip";
import { MediaTile } from "../src/studio/ui/MediaTile";
import { ViewGroup } from "../src/studio/ui/ViewGroup";
import { PipelineFace } from "../src/studio/faces/pipeline/PipelineFace";
import type { PipelineModel } from "../src/studio/faces/pipeline/model";
import { ShotStrip } from "../src/studio/ui/ShotStrip";
import { Timeline } from "../src/studio/ui/Timeline";
import { ExportMenu } from "../src/studio/ui/ExportMenu";
import { studioExportMenuModel } from "../src/services/toiv/multitrack-export";
import { EditFace } from "../src/studio/faces/edit/EditFace";
import type { EditModel } from "../src/studio/faces/edit/model";
import { ProjectCard } from "../src/studio/ui/ProjectCard";
import { ProjectGrid } from "../src/studio/ui/ProjectGrid";
import { CanvasHomeFace } from "../src/studio/faces/canvas/CanvasHomeFace";
import { TaskDrawer } from "../src/studio/ui/TaskDrawer";
import { RecipeCard } from "../src/studio/ui/RecipeCard";
import { ImportDialog } from "../src/studio/ui/ImportDialog";

describe("StudioShell", () => {
    const html = renderToStaticMarkup(
        <StudioShell face="pipeline" projectLabel="草船借箭 / 素材准备" runningCount={2}
            onFaceChange={() => {}} buddyText="测试台词" onDismissBuddy={() => {}}>
            <p>content</p>
        </StudioShell>,
    );
    test("renders face switcher with pressed state", () => {
        expect(html).toContain('aria-label="工作面"');
        expect(html).toMatch(/aria-pressed="true"[^>]*>流水线/);
    });
    test("renders task capsule with running count", () => {
        expect(html).toMatch(/2 运行中/);
    });
    test("renders companion bubble with dismiss", () => {
        expect(html).toContain("测试台词");
        expect(html).toContain('aria-label="关闭提示"');
    });
    test("shell carries theme class hook and content", () => {
        expect(html).toContain("stv-shell");
        expect(html).toContain("<p>content</p>");
    });
});

describe("FaceSwitcher", () => {
    test("renders three faces", () => {
        const html = renderToStaticMarkup(<FaceSwitcher value="canvas" onChange={() => {}} />);
        expect(html).toContain("流水线");
        expect(html).toContain("画布");
        expect(html).toContain("剪辑湾");
        expect(html).toMatch(/aria-pressed="true"[^>]*>画布/);
    });
});

describe("SlidingTabs", () => {
    const items = [
        { key: "s1", label: "项目配置", done: true },
        { key: "s2", label: "剧本创作", done: true },
        { key: "s3", label: "素材准备" },
    ];
    const html = renderToStaticMarkup(<SlidingTabs items={items} value="s3" onChange={() => {}} />);
    test("renders tablist with selected state", () => {
        expect(html).toContain('role="tablist"');
        expect(html).toMatch(/aria-selected="true"[^>]*><span class="tick">✓<\/span>素材准备|aria-selected="true"[^>]*>素材准备/s);
    });
    test("marks done stages with tick", () => {
        expect(html).toContain('class="tick"');
    });
    test("renders slider element", () => {
        expect(html).toContain("stv-tabs-slider");
    });
});

describe("StatusDot", () => {
    test("labels cover all statuses", () => {
        expect(Object.keys(STATUS_LABEL).sort()).toEqual(["done", "run", "wait"]);
    });
    test("renders semantic class", () => {
        expect(renderToStaticMarkup(<StatusDot status="run" />)).toContain("stv-status-run");
    });
});

describe("toast store", () => {
    test("push keeps at most three and exposes text", () => {
        useStudioToast.setState({ toasts: [] });
        const { push } = useStudioToast.getState();
        ["a", "b", "c", "d"].forEach((text) => push(text));
        expect(useStudioToast.getState().toasts.map((t) => t.text)).toEqual(["b", "c", "d"]);
    });
});

describe("Button", () => {
    test("primary variant class", () => {
        expect(renderToStaticMarkup(<Button variant="primary" onClick={() => {}}>生成</Button>)).toContain("stv-btn primary");
    });
});

describe("Field", () => {
    test("links label to control", () => {
        const html = renderToStaticMarkup(<Field label="场景描述" htmlFor="desc"><textarea id="desc" /></Field>);
        expect(html).toContain('for="desc"');
        expect(html).toContain("场景描述");
    });
});

describe("TakeStrip", () => {
    const takes = [{ id: "a", label: "T1", seed: 1 }, { id: "b", label: "T2", seed: 2 }];
    const html = renderToStaticMarkup(<TakeStrip takes={takes} activeId="a" onPick={() => {}} />);
    test("marks active take", () => {
        expect(html).toMatch(/aria-pressed="true"[^>]*>.*ACTIVE/s);
    });
    test("renders seed meta", () => {
        expect(html).toContain("seed 1");
    });
});

describe("MediaTile", () => {
    const html = renderToStaticMarkup(<MediaTile label="主视" status="done" badge="SEED 88213" locked selected
        onPreview={() => {}} onReplace={() => {}} onDownload={() => {}} />);
    test("exposes select semantics and actions", () => {
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain("预览");
        expect(html).toContain("替换");
        expect(html).toContain("下载");
    });
    test("shows lock marker when locked", () => {
        expect(html).toContain('class="lock"');
    });
    test("omits empty badge", () => {
        const bare = renderToStaticMarkup(<MediaTile label="右立面" status="wait" />);
        expect(bare).not.toContain('class="badge"');
    });
});

describe("ViewGroup", () => {
    const views = [
        { id: "v1", label: "主视", status: "done" as const, badge: "SEED 1", locked: true },
        { id: "v2", label: "反打", status: "run" as const, progress: 48 },
    ];
    const html = renderToStaticMarkup(<ViewGroup scene={{ id: "s1", name: "中军主帅营帐", slug: "INT / 日" }} views={views}
        selectedViewId="v1" onViewSelect={() => {}} onPreview={() => {}} onReplace={() => {}} onDownload={() => {}} />);
    test("derives running header status", () => {
        expect(html).toContain("stv-status-run");
        expect(html).toContain("渲染中 48%");
    });
    test("renders slug and name", () => {
        expect(html).toContain("INT / 日");
        expect(html).toContain("中军主帅营帐");
    });
});

describe("PipelineFace", () => {
    const model: PipelineModel = {
        projectId: "p1", projectName: "草船借箭", runningCount: 1, companionHint: "hint",
        stages: [{ key: "s0", label: "项目配置", done: true }, { key: "s1", label: "剧本创作", done: true }, { key: "s2", label: "素材准备", done: false }],
        stageIndex: 2,
        scenes: [{ id: "s1", name: "中军主帅营帐", slug: "INT / 日", views: [{ id: "v1", label: "主视", status: "done", badge: "SEED 1", locked: true }] }],
        shots: [{ id: "sh1", title: "镜01", prompt: "p", camera: "STATIC", durationSec: 4.5, status: "done", takes: [{ id: "c1", label: "T1", seed: 1 }], activeTakeId: "c1" }],
    };
    const html = renderToStaticMarkup(<PipelineFace model={model} recipes={[]} onAction={() => {}} />);
    test("renders three-column body", () => {
        expect(html).toContain('class="stv-body"');
        expect(html).toContain('aria-label="场次目录"');
        expect(html).toContain('aria-label="场景检查器"');
    });
    test("renders stage tabs and scene group", () => {
        expect(html).toContain('role="tablist"');
        expect(html).toContain("中军主帅营帐");
    });
    test("inspector offers the recipe panel alongside the shot panel", () => {
        expect(html).toContain('aria-label="检查器面板"');
        expect(html).toContain("配方");
        expect(html).not.toContain("stv-recipe");
    });
    test("renders take strip with active", () => {
        expect(html).toContain("ACTIVE");
    });
    test("empty scenes render detect action", () => {
        const empty = renderToStaticMarkup(<PipelineFace model={{ ...model, scenes: [] }} recipes={[]} onAction={() => {}} />);
        expect(empty).toContain("从剧本识别场景");
    });
});

describe("ShotStrip", () => {
    const shots = [
        { id: "sh1", title: "镜01", durationSec: 4.5, status: "done" as const, stillSeed: 1 },
        { id: "sh2", title: "镜02", durationSec: 3, status: "run" as const, stillSeed: 2 },
    ];
    const html = renderToStaticMarkup(<ShotStrip shots={shots} activeId="sh1" onPick={() => {}} />);
    test("marks active shot and shows duration", () => {
        expect(html).toMatch(/aria-pressed="true"[^>]*>.*>01</s);
        expect(html).toContain("4.5s");
    });
});

describe("Timeline", () => {
    const clips = [
        { id: "v1", label: "SHOT01", track: "v1" as const, startSec: 0, durationSec: 4.5, kind: "video" as const, status: "done" as const },
        { id: "v2", label: "SHOT02", track: "v1" as const, startSec: 4.5, durationSec: 3, kind: "video" as const, status: "done" as const },
    ];
    const html = renderToStaticMarkup(<Timeline clips={clips} totalSec={7.5} playheadSec={3} activeClipId="v1" onClipPick={() => {}} />);
    test("positions clips by second ratio", () => {
        expect(html).toContain("left:0%;width:60%");
        expect(html).toContain("left:60%;width:40%");
    });
    test("positions playhead by second ratio", () => {
        expect(html).toContain("left:40%");
    });
    test("renders three track lanes", () => {
        expect(html).toContain('data-track="v1"');
        expect(html).toContain('data-track="a1"');
        expect(html).toContain('data-track="a2"');
    });
});

describe("ExportMenu", () => {
    test("lists the four export actions from the service model", () => {
        const items = studioExportMenuModel({ ready: true });
        expect(items.map((item) => item.key)).toEqual(["jianying", "edl", "fcpxml", "multitrack"]);
        const html = renderToStaticMarkup(<ExportMenu projectId="p1" ready onResult={() => {}} />);
        expect(html).toContain("导出");
        for (const item of items) expect(html).toContain(item.label);
    });
});

describe("EditFace", () => {
    const model: EditModel = {
        projectId: "p1", projectName: "草船借箭", totalSec: 7.5, hasBgm: false,
        shots: [{ id: "sh1", title: "镜01", durationSec: 4.5, status: "done", stillSeed: 1 }],
        clips: [
            { id: "v1", label: "SHOT01 · 4.5s", track: "v1", startSec: 0, durationSec: 4.5, kind: "video", status: "done" },
            { id: "a1", label: "对白 · 镜01", track: "a1", startSec: 0, durationSec: 4.5, kind: "dialogue", status: "done" },
        ],
    };
    const html = renderToStaticMarkup(<EditFace model={model} onResult={() => {}} />);
    test("renders play control and timeline", () => {
        expect(html).toContain('aria-label="播放"');
        expect(html).toContain('data-track="v1"');
        expect(html).toContain("Sequence");
    });
    test("renders shot strip and export menu", () => {
        expect(html).toContain('aria-label="镜头条"');
        expect(html).toContain("导出");
    });
    test("hints missing bgm track", () => {
        expect(html).toContain("BGM 未绑定");
    });
});

describe("ProjectCard", () => {
    const card = { id: "p1", title: "草船借箭", status: "active", stillSeed: 1, shotCount: 6, source: "studio" as const };
    const html = renderToStaticMarkup(<ProjectCard card={card} onOpen={() => {}} />);
    test("exposes open semantics with title", () => {
        expect(html).toContain('aria-label="打开项目 草船借箭"');
        expect(html).toContain("草船借箭");
        expect(html).toContain("6 镜");
    });
});

describe("ProjectGrid", () => {
    test("empty state offers create action", () => {
        const html = renderToStaticMarkup(<ProjectGrid cards={[]} onOpen={() => {}} onCreate={() => {}} />);
        expect(html).toContain("新建项目");
    });
    test("renders one card per project", () => {
        const cards = [{ id: "p1", title: "甲", status: "active", stillSeed: 0, shotCount: 1, source: "studio" as const }, { id: "p2", title: "乙", status: "draft", stillSeed: 2, shotCount: 0, source: "canvas" as const }];
        const html = renderToStaticMarkup(<ProjectGrid cards={cards} onOpen={() => {}} onCreate={() => {}} />);
        expect(html).toContain("甲");
        expect(html).toContain("乙");
    });
});

describe("CanvasHomeFace", () => {
    const model = { cards: [{ id: "p1", title: "草船借箭", status: "active", stillSeed: 0, shotCount: 6, source: "studio" as const }], empty: false };
    const html = renderToStaticMarkup(<CanvasHomeFace model={model} onOpen={() => {}} onCreate={() => {}} />);
    test("renders search and create controls", () => {
        expect(html).toContain('aria-label="搜索项目"');
        expect(html).toContain("新建项目");
    });
    test("renders project cards", () => {
        expect(html).toContain("草船借箭");
    });
});

describe("TaskDrawer", () => {
    const tasks = [
        { id: "j1", source: "job" as const, title: "render · j1", status: "run" as const, progress: 42, sub: "x", cancellable: true },
        { id: "a1", source: "agent" as const, title: "会话甲", status: "wait" as const, cancellable: false },
    ];
    test("groups by source and exposes cancel only for cancellable", () => {
        const html = renderToStaticMarkup(<TaskDrawer open tasks={tasks} onClose={() => {}} onCancel={() => {}} />);
        expect(html).toContain("ToIV 作业");
        expect(html).toContain("智能体会话");
        expect(html).not.toContain("画布同步");
        expect(html.match(/class="cancel"/g)).toHaveLength(1);
    });
    test("closed drawer is aria-hidden", () => {
        const html = renderToStaticMarkup(<TaskDrawer open={false} tasks={tasks} onClose={() => {}} onCancel={() => {}} />);
        expect(html).toContain('aria-hidden="true"');
    });
    test("empty state", () => {
        expect(renderToStaticMarkup(<TaskDrawer open tasks={[]} onClose={() => {}} onCancel={() => {}} />)).toContain("队列空闲");
    });
});

describe("RecipeCard", () => {
    const recipe = { id: "r1", name: "夜戏标准", description: "低光双灯", meta: "comfyui · ref2va · video", isDefault: true, updatedOn: "2026-10-29", sourceShotId: "sh9" };
    test("shows identity, engine meta and default tag", () => {
        const html = renderToStaticMarkup(<RecipeCard recipe={recipe} shotId="sh2" onAction={() => {}} />);
        expect(html).toContain("夜戏标准");
        expect(html).toContain("comfyui · ref2va · video");
        expect(html).toContain("默认");
        expect(html).toContain("低光双灯");
        expect(html).toContain("导出");
        expect(html).toContain("复用到本镜");
    });
    test("apply needs a target shot", () => {
        expect(renderToStaticMarkup(<RecipeCard recipe={recipe} shotId="sh2" onAction={() => {}} />)).not.toContain("disabled");
        expect(renderToStaticMarkup(<RecipeCard recipe={recipe} onAction={() => {}} />)).toContain("disabled");
    });
});

describe("ImportDialog", () => {
    test("renders nothing while closed", () => {
        expect(renderToStaticMarkup(<ImportDialog open={false} onClose={() => {}} onInstall={() => {}} />)).toBe("");
    });
    test("open dialog is modal and starts with install disabled", () => {
        const html = renderToStaticMarkup(<ImportDialog open onClose={() => {}} onInstall={() => {}} />);
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="true"');
        expect(html).toContain('aria-label="安装配方"');
        expect(html).toContain('aria-label="配方 JSON"');
        expect(html).toContain("toiv_generation_recipe_v1");
        expect(html).toContain("disabled");
        expect(html).toContain("取消");
    });
});
