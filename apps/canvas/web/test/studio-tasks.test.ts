import { describe, expect, mock, test } from "bun:test";

mock.module("@/services/toiv/client", () => ({
    fetchJobs: async () => [
        { id: "j1", kind: "render", status: "running", created_at: "2026-10-30", progress: { percent: 42 } },
        { id: "j2", kind: "voice", status: "done", created_at: "2026-10-30" },
    ],
    cancelJob: async (id: string) => id === "j1",
}));
mock.module("@/services/toiv/agent-chat", () => ({
    fetchAgentSessions: async () => [{ id: "s1", title: "会话甲", updated_at: "2026-10-30" }],
}));

const { loadStudioTasks, cancelStudioTask } = await import("@/studio/tasks-model");

describe("loadStudioTasks", () => {
    test("merges three sources with status mapping", async () => {
        const tasks = await loadStudioTasks();
        expect(tasks.map((task) => task.source)).toEqual(["job", "job", "agent"]);
        expect(tasks[0].status).toBe("run");
        expect(tasks[0].progress).toBe(42);
        expect(tasks[0].cancellable).toBe(true);
        expect(tasks[1].status).toBe("done");
        expect(tasks[2].title).toBe("会话甲");
    });
    test("cancel only applies to jobs", async () => {
        const tasks = await loadStudioTasks();
        expect(await cancelStudioTask(tasks[0])).toBe(true);
        expect(await cancelStudioTask(tasks[2])).toBe(false);
    });
});
