/**
 * 助手 403 必须是终态、不得轮询(2026-10-14 全面 UI 测试实证)。
 * 现场:web 入口(:3100/studio)经 Next 代理时 Host 非回环,canvas-api 的 ops/assistant
 * 会话层按 `isLoopbackRequest` 一律 403。此前 hook 的 catch 把任何失败在 warmup 内
 * 归成 host_starting → starting 恒真 → 每秒打一次 /assistant/ui-session,
 * 一次会话累计 **3877 条 403**(控制台日志实测),UI 还一直显示"助手正在启动…"骗人。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

describe("assistant 403 terminal state", () => {
    const api = read("src/services/api/agent-assistant.ts");
    const hook = read("src/pages/canvas/use-canvas-assistant.ts");
    const copy = read("src/pages/canvas/canvas-assistant-copy.ts");

    test("403 打可判定标记并导出判定函数", () => {
        expect(api).toContain("forbidden.agentUiForbidden = true");
        expect(api).toContain("export function isAgentUiForbidden");
    });

    test("hook 命中 403 即置终态并停止轮询", () => {
        expect(hook).toContain('if (!open || forbidden) return;');
        expect(hook).toContain('setStatus({ available: false, reason: "forbidden" })');
        expect(hook).toContain("isAgentUiForbidden(error)");
    });

    test("文案说真话且不给重试按钮(重试只会再 403)", () => {
        const at = copy.indexOf('case "forbidden"');
        expect(at).toBeGreaterThan(-1);
        const block = copy.slice(at, copy.indexOf("case ", at + 5));
        expect(block).toContain("不可用");
        expect(block).not.toContain("actionLabel");
    });

    test("waitForAssistant 不会为 forbidden 跑满 20 次重试", () => {
        const readiness = read("src/pages/canvas/assistant-readiness.ts");
        // 只有 host_starting 才继续循环;forbidden 走 throw 分支立即退出
        expect(readiness).toContain('if (status.reason !== "host_starting") throw');
    });
});
