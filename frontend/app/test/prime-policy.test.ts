import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolvePolicyModule } from "../vite.config";

// 内容锁唯一来源：优先 canvas 的 content-lock.ts；锁被删除时回落到同目录
// content-policy.ts 的 no-op；两者都不存在时用 Prime 本地 no-op，保证删锁
// 后构建/启动照常。Prime 目前没有任何门控入口（仅偏好开关与信息徽标），
// 后续新增门控/隐藏/徽标必须经 @content-lock。
const repo = join(import.meta.dir, "..");
const temps: string[] = [];

function fakeLayout() {
    const root = mkdtempSync(join(tmpdir(), "prime-policy-"));
    temps.push(root);
    const app = join(root, "frontend/app");
    const canvas = join(root, "vendor/canvas/web/src");
    mkdirSync(app, { recursive: true });
    mkdirSync(canvas, { recursive: true });
    return { app, canvas };
}

afterAll(async () => {
    await Promise.all(temps.map(root => rm(root, { recursive: true, force: true })));
});

test("prefers the shared lock and falls back to the neutral policy when the lock is deleted", () => {
    const { app, canvas } = fakeLayout();
    writeFileSync(join(canvas, "content-lock.ts"), "export const contentPolicy = {};\n");
    writeFileSync(join(canvas, "content-policy.ts"), "export const contentPolicy = {};\n");
    expect(basename(resolvePolicyModule(app) ?? "")).toBe("content-lock.ts");

    // 删除锁文件：同一别名必须回落放行，不能让构建/启动报错。
    rmSync(join(canvas, "content-lock.ts"));
    expect(basename(resolvePolicyModule(app) ?? "")).toBe("content-policy.ts");
});

test("falls back to a local no-op when the shared policy is absent entirely", () => {
    const { app } = fakeLayout();
    const resolved = resolvePolicyModule(app);
    expect(resolved?.endsWith("src/toiv/policy/noop-content-lock.ts")).toBe(true);
});

test("this repository resolves the alias to the shared lock", () => {
    const resolved = resolvePolicyModule(repo);
    expect(resolved?.endsWith("vendor/canvas/web/src/content-lock.ts")).toBe(true);
    expect(existsSync(resolved!)).toBe(true);
});

test("the local no-op keeps the shared policy surface and allows everything", async () => {
    const noopPath = join(repo, "src/toiv/policy/noop-content-lock.ts");
    const local = await import(noopPath);
    const canonical = await import(join(repo, "../../vendor/canvas/web/src/content-policy.ts"));

    expect(Object.keys(local.contentPolicy).sort()).toEqual(Object.keys(canonical.contentPolicy).sort());
    expect(local.contentPolicy.id).toBe("unrestricted");
    expect(local.contentPolicy.isGatedLocation({ pathname: "/nsfw" }, [])).toBe(false);
    expect(local.contentPolicy.allowsContent(false)).toBe(true);
    expect(local.contentPolicy.isUnderage("2020-01-01")).toBe(false);
    expect(local.contentPolicy.isAssetSelectable("nsfw", false)).toBe(true);
});
