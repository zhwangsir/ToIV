/**
 * F9(2026-10-15 UI 统一波):智能体浮层启动序列 + 初始建议 + 会话分叉入口 + 任务中心抽屉。
 * ① 启动序列:首开呼吸小核+状态文字,prefers-reduced-motion 直开;
 * ② 初始建议:空会话渲染快捷起手,点击填入输入框(等价 web 场景卡/快捷动作);
 * ③ 会话分叉/在对话页打开:forkAgentSession + stashPendingAgentSession 通道;
 * ④ 任务中心抽屉:在跑判集与 /toiv/tasks 页共享投影同源,5s 轮询 + 中止 + 跳转;
 * ⑤ pending-session stash 行为(take 即删)。
 */
import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { generationSourceProjection } from "@/lib/generation-task-display";
import {
    FLOAT_ACTIVE_JOB_STATUSES,
    FLOAT_BOOT_MS,
    FLOAT_SUGGESTIONS,
    ToivAgentFloat,
    floatJobStatusLabel,
} from "@/pages/canvas/toiv-agent-float";
import {
    AGENT_PENDING_SESSION_KEY,
    stashPendingAgentSession,
    takePendingAgentSession,
} from "@/services/toiv/agent-draft";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

function withFakeWindow(fn: () => void) {
    const store = new Map<string, string>();
    const fake = {
        localStorage: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        },
    };
    (globalThis as Record<string, unknown>).window = fake;
    try {
        fn();
    } finally {
        delete (globalThis as Record<string, unknown>).window;
    }
}

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
});

describe("F9 toiv agent float", () => {
    test("启动序列:首开播放、reduced-motion 直开、状态语义齐备", () => {
        expect(FLOAT_BOOT_MS).toBeGreaterThan(0);
        expect(FLOAT_BOOT_MS).toBeLessThanOrEqual(1600);
        const src = read("src/pages/canvas/toiv-agent-float.tsx");
        expect(src).toContain("booting");
        expect(src).toContain("bootedOnceRef");
        expect(src).toContain("prefers-reduced-motion: reduce");
        expect(src).toContain('aria-label="智能体启动中"');
        expect(src).toContain("正在接入 ToIV 智能体…");
        expect(src).toContain("animate-pulse");
        // reduced-motion 命中时不得进入 booting 分支
        const openFn = src.slice(src.indexOf("const openFloat"), src.indexOf("const loadSessions"));
        expect(openFn.indexOf("reduceMotion")).toBeLessThan(openFn.indexOf("setBooting(true)"));
    });

    test("初始建议:空会话渲染快捷起手,点击填入输入框而非直发", () => {
        expect(FLOAT_SUGGESTIONS.length).toBeGreaterThanOrEqual(3);
        const src = read("src/pages/canvas/toiv-agent-float.tsx");
        expect(src).toContain("turns.length === 0");
        expect(src).toContain("FLOAT_SUGGESTIONS.map");
        expect(src).toContain("setInput(s); inputRef.current?.focus();");
    });

    test("会话分叉入口 + 深链创作台(stash 通道)", () => {
        const src = read("src/pages/canvas/toiv-agent-float.tsx");
        expect(src).toContain("forkAgentSession");
        expect(src).toContain("stashPendingAgentSession");
        expect(src).toContain("openInCreateComposer");
        // W3/W7：浮窗只深链 /create composer，不再挂 legacy AgentPage
        expect(src).toContain('navigate("/create")');
        expect(src).not.toContain('navigate("/toiv/agent")');
        expect(src).not.toContain("view=agent");
        expect(src).toContain("已分叉为新会话");
    });

    test("任务中心抽屉:在跑判集与 /toiv/tasks 页共享投影同源", () => {
        for (const status of FLOAT_ACTIVE_JOB_STATUSES) {
            const projection = generationSourceProjection({ source: "toiv-job", task: { id: `job-${status}`, status, created_at: "2026-10-28T00:00:00Z" } });
            expect(projection.isActive).toBe(true);
            expect(projection.canCancel).toBe(true);
            expect(projection.statusLabel).toBe(floatJobStatusLabel(status));
        }
        expect(FLOAT_ACTIVE_JOB_STATUSES).toContain("running");
        expect(floatJobStatusLabel("queued")).toBe("排队中");
        expect(floatJobStatusLabel("held")).toBe("等待资源");
        expect(floatJobStatusLabel("running")).toBe("运行中");
        expect(floatJobStatusLabel("weird")).toBe("weird");
    });

    test("任务中心抽屉:5s 轮询 + 中止确认门 + 打开任务中心跳转", () => {
        const src = read("src/pages/canvas/toiv-agent-float.tsx");
        expect(src).toContain("const TASK_POLL_MS = 5_000");
        expect(src).toContain("fetchJobs(50)");
        expect(src).toContain("cancelJob(job.id)");
        expect(src).toContain("Popconfirm");
        expect(src).toContain('navigate("/toiv/tasks")');
        expect(src).toContain("打开任务中心");
        expect(src).toContain("当前没有在跑的任务");
        expect(src).toContain('aria-label="任务中心"');
        // 轮询仅在抽屉展开期间(收起即停,浮层不做常驻轮询)
        expect(src).toContain("if (!open || !tasksOpen) return;");
    });

    test("pending-session stash:写入→take 即删→再 take 为 null", () => {
        withFakeWindow(() => {
            stashPendingAgentSession("sess-42");
            expect(takePendingAgentSession()).toBe("sess-42");
            expect(takePendingAgentSession()).toBe(null);
            // 空白 id 不写
            stashPendingAgentSession("   ");
            expect(takePendingAgentSession()).toBe(null);
        });
    });

    test("stash key 固定(take 即删模式,与草稿通道同域)", () => {
        expect(AGENT_PENDING_SESSION_KEY).toBe("toiv_agent_pending_session");
    });

    test("收起态渲染: launcher 按钮可发现(aria-label)", () => {
        const html = renderToStaticMarkup(
            createElement(MemoryRouter, null, createElement(ToivAgentFloat)),
        );
        expect(html).toContain('aria-label="打开 ToIV 智能体"');
    });
});
