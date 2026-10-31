import { describe, expect, test } from "bun:test";

import {
    CLIENT_TIMEOUT_STILL_RUNNING,
    TOIV_TASKS_PATH,
    formatClientTimeoutMessage,
    isClientTimeoutError,
    isStillRunningMessage,
    userFacingCaughtError,
} from "@/services/toiv/client-timeout";

describe("toiv client-timeout perception (#13 / P3)", () => {
    test("unified copy points at task center and still-running", () => {
        expect(TOIV_TASKS_PATH).toBe("/toiv/tasks");
        expect(formatClientTimeoutMessage()).toBe(CLIENT_TIMEOUT_STILL_RUNNING);
        expect(CLIENT_TIMEOUT_STILL_RUNNING).toContain("仍在后台跑");
        expect(CLIENT_TIMEOUT_STILL_RUNNING).toContain("任务中心");
        expect(CLIENT_TIMEOUT_STILL_RUNNING).not.toMatch(/失败|请重试/);
    });

    test("axios / apiFetch client timeout → still running, not failure", () => {
        expect(isClientTimeoutError({ code: "ECONNABORTED", message: "timeout of 15000ms exceeded" })).toBe(true);
        expect(isClientTimeoutError({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" })).toBe(true);
        expect(isClientTimeoutError({ code: "ERR_TIMEOUT", message: "timeout" })).toBe(true);
        expect(userFacingCaughtError({ code: "ECONNABORTED", message: "timeout of 15000ms exceeded" }, "生成失败")).toBe(
            CLIENT_TIMEOUT_STILL_RUNNING,
        );
        expect(userFacingCaughtError(new Error("timeout of 60000ms exceeded"), "运行失败")).toBe(CLIENT_TIMEOUT_STILL_RUNNING);
        expect(userFacingCaughtError(new Error("请求超时 (30s),请稍后重试"), "生成失败")).toBe(CLIENT_TIMEOUT_STILL_RUNNING);
    });

    test("real job failure / cancel / abort are not rewritten as still-running", () => {
        expect(isClientTimeoutError(new Error("生成失败"))).toBe(false);
        expect(isClientTimeoutError(new Error("生成失败(可在任务中心查看)"))).toBe(false);
        expect(isClientTimeoutError(new Error("渲染失败"))).toBe(false);
        expect(isClientTimeoutError(new Error("质检门禁未过"))).toBe(false);
        expect(userFacingCaughtError(new Error("渲染失败"), "fallback")).toBe("渲染失败");
        expect(userFacingCaughtError(new Error("生成失败(可在任务中心查看)"), "生成失败")).toBe("生成失败(可在任务中心查看)");
        expect(isClientTimeoutError({ name: "AbortError", message: "Aborted" })).toBe(false);
        // Job hold_reason 英文 timeout：无 axios code 时不误判
        expect(isClientTimeoutError(new Error("worker timeout after 900s"))).toBe(false);
        expect(isStillRunningMessage("生成失败(可在任务中心查看)")).toBe(false);
    });

    test("legacy poll-deadline copy normalizes to unified still-running", () => {
        expect(userFacingCaughtError(new Error("超分超时:作业仍在进行,可稍后到 ToIV 任务中心查看结果"), "超分失败")).toBe(
            CLIENT_TIMEOUT_STILL_RUNNING,
        );
        expect(userFacingCaughtError(new Error("拆解超时,可在任务中心查看进度后重试"), "拆解失败")).toBe(
            CLIENT_TIMEOUT_STILL_RUNNING,
        );
        expect(isStillRunningMessage(CLIENT_TIMEOUT_STILL_RUNNING)).toBe(true);
        expect(isStillRunningMessage("后台生成中,任务中心可见")).toBe(true);
        expect(isStillRunningMessage("生成失败")).toBe(false);
    });
});
