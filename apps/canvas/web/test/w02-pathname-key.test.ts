/**
 * W0-2(2026-10-15):外层 Suspense 的 pathname-key 摘除防回归。
 * key 的代价=每次导航整树重挂(闪屏/状态丢失/首进转圈放大器);根修早已在
 * drama-page FromImageDialog 条件挂载(f8633401)。真机门禁:部署后
 * drama↔library↔market↔tasks 往返×10 通过才允许保持摘除态。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf-8");

describe("W0-2 pathname-key 摘除", () => {
    test("外层 Suspense 不再以 pathname 为 key", () => {
        const router = read("src/router.tsx");
        expect(router).not.toContain("<Suspense key={pathname}");
        expect(router).toContain("return <Suspense fallback={fallback}><UserLayout><Outlet /></UserLayout></Suspense>;");
    });
});
