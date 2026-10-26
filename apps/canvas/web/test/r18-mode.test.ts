/** R18 门控模式(D-U1)单测:开关持久化 + dataset 钩子 + 头开关(不碰 axios)。 */
import { describe, expect, test } from "bun:test";

function installBrowserStub(r18: string | null) {
    const store = new Map<string, string | null>([["toiv_r18_mode", r18]]);
    (globalThis as Record<string, unknown>).window = {
        localStorage: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        },
        location: { href: "http://localhost/", pathname: "/", search: "", assign() {}, replace() {} },
        dispatchEvent: () => true,
        addEventListener() {},
        removeEventListener() {},
    };
    const dataset: Record<string, string> = {};
    (globalThis as Record<string, unknown>).document = { documentElement: { dataset } };
    return { store, dataset };
}

describe("r18-mode", () => {
    test("setR18Mode 持久化并反映到 html dataset;nsfwHeaderEnabled 跟随", () => {
        const { dataset } = installBrowserStub(null);
        const mod = require("../src/services/toiv/r18-mode");
        expect(mod.isR18Mode()).toBe(false);
        expect(mod.nsfwHeaderEnabled()).toBe(false);
        mod.setR18Mode(true);
        expect(mod.isR18Mode()).toBe(true);
        expect(mod.nsfwHeaderEnabled()).toBe(true);
        expect(dataset.r18).toBe("1");
        mod.setR18Mode(false);
        expect(mod.isR18Mode()).toBe(false);
        expect(mod.nsfwHeaderEnabled()).toBe(false);
        expect(dataset.r18).toBeUndefined();
    });

    test("预置 toiv_r18_mode=1 时 initR18Mode 恢复 dataset(启动路径)", () => {
        const { dataset } = installBrowserStub("1");
        const mod = require("../src/services/toiv/r18-mode");
        mod.initR18Mode();
        expect(dataset.r18).toBe("1");
        expect(mod.nsfwHeaderEnabled()).toBe(true);
    });
});

describe("r18 failure classification surface", () => {
    test("403 R18 detail classifies as r18_context_required not permission", () => {
        const { explainGenerationError } = require("../src/lib/generation-error");
        const f = explainGenerationError({
            status: 403,
            data: { detail: "该操作为 R18 内容,须在 R18 上下文(X-NSFW)下使用" },
        });
        expect(f.category).toBe("r18_context_required");
        expect(f.guideEnableR18).toBe(true);
        expect(f.slotLabel).toBe("需成人");
        expect(f.slot).toBe("route_guard_adult");
        expect(f.blockAutomaticRetry).toBe(true);
    });

    test("persisted r18 reason round-trips without generic 失败", () => {
        const { explainGenerationError, generationFailureMetadata } = require("../src/lib/generation-error");
        const first = explainGenerationError({ code: "r18_context_required" });
        const meta = generationFailureMetadata({ code: "r18_context_required" }, "adult prompt");
        expect(meta.generationErrorCode).toBe("r18_context_required");
        expect(meta.failedInputFingerprint).toBeTruthy();
        expect(meta.errorDetails).toMatch(/成人|普通/);
        expect(meta.errorDetails).not.toBe("生成失败");
        const again = explainGenerationError(meta.errorDetails);
        expect(again.category).toBe("r18_context_required");
        expect(again.reason).toBe(first.reason);
    });

    test("underage 403 is adult-gate (guide CTA), not bare permission", () => {
        const { explainGenerationError } = require("../src/lib/generation-error");
        for (const detail of ["未成年账户不可开启或使用 R18 内容", "未成年用户不可开启 R18 模式"]) {
            const f = explainGenerationError({ status: 403, data: { detail } });
            expect(f.category).toBe("r18_context_required");
            expect(f.guideEnableR18).toBe(true);
            expect(f.slot).toBe("route_guard_adult");
        }
    });

    test("non-content 403 never guides adult switch", () => {
        const { explainGenerationError } = require("../src/lib/generation-error");
        const cases: Array<[unknown, string, boolean?]> = [
            [{ status: 403, data: { detail: "需要管理员权限" } }, "permission"],
            [{ status: 403, data: { detail: "视频路径不在允许的媒体目录内" } }, "permission"],
            [{ status: 403, data: { detail: "Forbidden" } }, "permission"],
            [{ status: 403, data: { detail: "请求过于频繁，请稍后再试" } }, "throttled"],
            [{ status: 403, data: { detail: "服务令牌无权访问该接口" } }, "auth"],
            [{ status: 403, data: { detail: "账号额度不足，请充值后重试" } }, "quota_unknown"],
        ];
        for (const [err, category] of cases) {
            const f = explainGenerationError(err);
            expect(f.category).toBe(category);
            expect(f.guideEnableR18).toBe(false);
            expect(f.slot).not.toBe("route_guard_adult");
        }
    });
});
