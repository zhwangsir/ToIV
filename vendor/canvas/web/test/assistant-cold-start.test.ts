import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { retryAssistantRead } from "../src/pages/canvas/use-canvas-assistant";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("助手首开不闪错误", () => {
    test("读取失败会静默重试，成功即返回", async () => {
        let calls = 0;
        const value = await retryAssistantRead(async () => {
            calls += 1;
            if (calls < 3) throw new Error("503");
            return "ok";
        }, () => false, 3, 1);
        expect(value).toBe("ok");
        expect(calls).toBe(3);
    });

    test("重试用尽才抛出；被新读取取代时立即放弃", async () => {
        let calls = 0;
        await expect(retryAssistantRead(async () => { calls += 1; throw new Error("503"); }, () => false, 3, 1)).rejects.toThrow("503");
        expect(calls).toBe(3);
        calls = 0;
        await expect(retryAssistantRead(async () => { calls += 1; throw new Error("503"); }, () => true, 3, 1)).rejects.toThrow("503");
        expect(calls).toBe(1);
    });

    test("还没拿到状态或正在启动时不读历史，并显示启动中而不是错误", () => {
        const hook = read("src/pages/canvas/use-canvas-assistant.ts");
        const sidebar = read("src/pages/canvas/canvas-assistant-sidebar.tsx");
        expect(hook).toContain('if (!status || status.reason === "host_starting") return;');
        expect(hook).toContain('const starting = !status || status.reason === "host_starting";');
        expect(sidebar).toContain("助手正在启动…");
    });
});

describe("生成任务入口不遮挡画布", () => {
    test("收起时是顶栏按钮，不再是画布上的浮动卡片", () => {
        const panel = read("src/components/canvas/canvas-active-task-panel.tsx");
        const project = read("src/pages/canvas/project.tsx");
        const topBar = read("src/pages/canvas/canvas-project-top-bar.tsx");
        expect(topBar).toContain("{activeTasks}");
        expect(project).toContain("activeTasks={<CanvasActiveTaskPanel");
        expect(project).not.toContain('topInset={focusMode ? "var(--space-3)" : "var(--canvas-topbar-offset)"}');
        expect(panel).toContain('className="canvas-topbar-action');
        expect(panel).not.toContain("当前画布 · {tasks.length} 个进行中");
        // 专注模式（含窄屏）放进专注栏，不再单独浮在右上角。
        expect(project).toContain('placement="focusbar"');
        expect(read("src/components/canvas/canvas-focus-mode-bar.tsx")).toContain("{activeTasks}");
    });
});
