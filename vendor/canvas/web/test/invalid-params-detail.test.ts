import { expect, test } from "bun:test";
import { explainGenerationError } from "../src/lib/generation-error";

// 2026-10-08:后端把上游中文参数错误落库为 "参数不被接受：…",前端必须原样展示。
const persisted = "参数不被接受：最长支持 60 秒(分段续写安全上限),当前请求 99 秒,请缩短时长";

test("persisted upstream parameter reason is shown as-is", () => {
    const failure = explainGenerationError(persisted);
    expect(failure.category).toBe("invalid_params");
    expect(failure.message).toBe(persisted);
    expect(failure.message).not.toContain("模型不接受当前参数");
});

test("canvas node metadata form keeps the upstream reason and debug ids", () => {
    const failure = explainGenerationError({ code: "invalid_params", message: `${persisted}。排查编号：请求 req-abcdef123` }, { taskId: "task-0123456789" });
    expect(failure.category).toBe("invalid_params");
    expect(failure.reason).toBe(persisted);
    expect(failure.message).toContain("最长支持 60 秒");
    expect(failure.message).toContain("请求 req-abcdef123");
    expect(failure.blockAutomaticRetry).toBe(true);
});
