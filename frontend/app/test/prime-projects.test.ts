import { afterEach, expect, test } from "bun:test";
import {
    formatRelativeTime,
    loadPrimeProjects,
    loadProjectView,
    projectBucket,
    projectStages,
    saveProjectView,
    statusCounts,
    type PrimeProjectCard,
} from "../src/toiv/adapters/projects";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("canvas summaries are unwrapped from the Go envelope rather than lost", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).startsWith("/studio/api")
        ? json({ code: 0, data: { projects: [{ id: "c1", title: "画布甲", updatedAt: "2026-10-30T10:00:00Z" }] }, msg: "ok" })
        : json([{ id: "p1", title: "短片乙" }])) as typeof fetch;
    const result = await loadPrimeProjects();
    expect(result.cards.map(({ id, title, shotCount }) => ({ id, title, shotCount }))).toEqual([
        { id: "p1", title: "短片乙", shotCount: 0 },
        { id: "c1", title: "画布甲", shotCount: 0 },
    ]);
    expect(result.degraded).toBe("none");
});

test("both unavailable sources are reported instead of pretending the library is empty", async () => {
    globalThis.fetch = (async () => json({ detail: "unavailable" }, 503)) as typeof fetch;
    expect((await loadPrimeProjects()).degraded).toBe("both");
});

test("a rejected Go business envelope reports source failure even with HTTP 200", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).startsWith("/studio/api")
        ? json({ code: 403, data: null, msg: "denied" }) : json([])) as typeof fetch;
    expect((await loadPrimeProjects()).degraded).toBe("canvas");
});

test("studio cards keep pipeline, cover and update time instead of dropping them", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).startsWith("/studio/api")
        ? json({ code: 0, data: { projects: [{ id: "c1", title: "画布甲", updatedAt: "2026-10-30T10:00:00Z" }] }, msg: "ok" })
        : json([
            {
                id: "p1",
                title: "雨夜",
                status: "generating",
                updated_at: "2026-11-01T11:00:00Z",
                pipeline: {
                    total_shots: 4,
                    by_status: { rendered: 2, error: 1, draft: 1 },
                    next_step: { step: "render", label: "渲染分镜", todo: 2 },
                    cover_url: "/api/studio/files/cover.mp4",
                    cover_kind: "video",
                },
            },
            { id: "p2", title: "旧数据", shots_count: 3 },
        ])) as typeof fetch;
    const result = await loadPrimeProjects();
    const [studio, legacy, canvas] = result.cards;
    expect(studio).toMatchObject({
        id: "p1",
        shotCount: 4,
        shotsKnown: true,
        coverUrl: "/api/studio/files/cover.mp4",
        coverKind: "video",
        updatedAt: "2026-11-01T11:00:00Z",
        pipeline: {
            totalShots: 4,
            byStatus: { rendered: 2, error: 1, draft: 1 },
            nextStep: { step: "render", label: "渲染分镜", todo: 2 },
        },
    });
    expect(legacy).toMatchObject({ id: "p2", shotCount: 3, shotsKnown: true, coverUrl: "", pipeline: null });
    expect(canvas).toMatchObject({ id: "c1", shotsKnown: false, updatedAt: "2026-10-30T10:00:00Z", pipeline: null });
    expect(result.degraded).toBe("none");
});

function card(overrides: Partial<PrimeProjectCard> = {}): PrimeProjectCard {
    return {
        id: "p1", title: "片", source: "studio", status: "draft", shotCount: 4,
        shotsKnown: true, coverUrl: "", coverKind: "", updatedAt: "",
        pipeline: { totalShots: 4, byStatus: { draft: 4 }, nextStep: { step: "render", label: "渲染分镜", todo: 4 } },
        ...overrides,
    };
}

test("project buckets separate repair, done, draft and active work", () => {
    expect(projectBucket(card())).toBe("active");
    expect(projectBucket(card({ pipeline: { totalShots: 0, byStatus: {}, nextStep: { step: "render", label: "渲染分镜", todo: 0 } }, shotCount: 0 }))).toBe("draft");
    expect(projectBucket(card({ pipeline: { totalShots: 4, byStatus: { error: 1, done: 3 }, nextStep: { step: "render", label: "渲染分镜", todo: 1 } } }))).toBe("repair");
    expect(projectBucket(card({ status: "error", pipeline: { totalShots: 1, byStatus: { rendered: 1 }, nextStep: { step: "assemble", label: "合成成片", todo: 1 } } }))).toBe("repair");
    expect(projectBucket(card({ pipeline: { totalShots: 4, byStatus: { done: 4 }, nextStep: { step: "done", label: "全部完成", todo: 0 } } }))).toBe("done");
    expect(projectBucket(card({ source: "canvas", pipeline: null, status: "canvas" }))).toBe("canvas");
    expect(statusCounts([
        card(),
        card({ id: "p2", pipeline: { totalShots: 0, byStatus: {}, nextStep: { step: "render", label: "渲染分镜", todo: 0 } }, shotCount: 0 }),
        card({ id: "p3", pipeline: { totalShots: 1, byStatus: { error: 1 }, nextStep: { step: "render", label: "渲染分镜", todo: 1 } } }),
        card({ id: "p4", pipeline: { totalShots: 2, byStatus: { done: 2 }, nextStep: { step: "done", label: "全部完成", todo: 0 } } }),
        card({ id: "c1", source: "canvas", status: "canvas", pipeline: null }),
    ])).toEqual({ all: 5, draft: 1, active: 1, repair: 1, done: 1 });
});

test("progress axis marks completed, current and pending stages from next_step", () => {
    expect(projectStages(card()).map((stage) => stage.state)).toEqual(["current", "todo", "todo", "todo"]);
    expect(projectStages(card({ pipeline: { totalShots: 4, byStatus: { rendered: 4 }, nextStep: { step: "voice", label: "分镜配音", todo: 2 } } })).map((stage) => stage.state))
        .toEqual(["done", "current", "todo", "todo"]);
    expect(projectStages(card({ pipeline: { totalShots: 4, byStatus: { done: 4 }, nextStep: { step: "done", label: "全部完成", todo: 0 } } })).map((stage) => stage.state))
        .toEqual(["done", "done", "done", "done"]);
    expect(projectStages(card({ source: "canvas", pipeline: null }))).toEqual([]);
});

test("relative time stays human until a month, then falls back to a date", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(formatRelativeTime("", now)).toBe("");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
    expect(formatRelativeTime("2026-11-01T11:59:30Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-11-01T11:55:00Z", now)).toBe("5 分钟前");
    expect(formatRelativeTime("2026-11-01T09:00:00Z", now)).toBe("3 小时前");
    expect(formatRelativeTime("2026-10-31T09:00:00Z", now)).toBe("昨天");
    expect(formatRelativeTime("2026-10-27T12:00:00Z", now)).toBe("5 天前");
    expect(formatRelativeTime("2026-09-02T12:00:00Z", now)).toBe("2026-09-02");
});

test("gallery or list view survives without throwing when storage is unavailable", () => {
    const store = new Map<string, string>();
    const fake = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    expect(loadProjectView(fake)).toBe("gallery");
    saveProjectView("list", fake);
    expect(loadProjectView(fake)).toBe("list");
    saveProjectView("gallery", fake);
    expect(loadProjectView(fake)).toBe("gallery");
    expect(loadProjectView(null)).toBe("gallery");
    expect(() => saveProjectView("list", null)).not.toThrow();
});
