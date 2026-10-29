import { expect, test } from "bun:test";

import { unhydratedCreationResultAssetTasks } from "../src/lib/canvas/canvas-asset-handoff";

type Message = Parameters<typeof unhydratedCreationResultAssetTasks>[0][number];
type Assets = Parameters<typeof unhydratedCreationResultAssetTasks>[1];

const doneMessage = (overrides: Partial<Message> = {}): Message => ({
    id: "message-1",
    role: "assistant",
    resultUrls: ["/api/resources/resource-1/file"],
    taskIds: ["task-1"],
    ...overrides,
});

const hydratedAsset = (overrides: Record<string, unknown> = {}) =>
    ({
        id: "generation-1",
        kind: "image",
        coverUrl: "/api/resources/resource-1/file",
        data: { dataUrl: "/api/resources/resource-1/file" },
        metadata: { source: "generation-task", messageId: "message-1", taskId: "task-1", outputIndex: 0 },
        ...overrides,
    }) as unknown as Assets[number];

test("reloaded completed messages request hydration for their task ids", () => {
    expect(unhydratedCreationResultAssetTasks([doneMessage()], [])).toEqual(["task-1"]);
});

test("messages whose results already have assets request nothing", () => {
    expect(unhydratedCreationResultAssetTasks([doneMessage()], [hydratedAsset()])).toEqual([]);
});

test("partially hydrated results still request the message task ids", () => {
    const message = doneMessage({ resultUrls: ["/api/resources/resource-1/file", "/api/resources/resource-2/file"] });
    expect(unhydratedCreationResultAssetTasks([message], [hydratedAsset()])).toEqual(["task-1"]);
});

test("user turns and messages without results or tasks are ignored", () => {
    expect(unhydratedCreationResultAssetTasks([
        doneMessage({ role: "user" }),
        doneMessage({ id: "message-2", resultUrls: [] }),
        doneMessage({ id: "message-3", taskIds: [] }),
    ], [])).toEqual([]);
});

test("task ids are deduplicated across messages", () => {
    expect(unhydratedCreationResultAssetTasks([
        doneMessage(),
        doneMessage({ id: "message-2" }),
    ], [])).toEqual(["task-1"]);
});
