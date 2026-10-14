/**
 * F8 融合批(2026-10-14):canvas 作品库「作品」面与路由契约(源码断言,bun test)。
 * ① library-page 必须有 作品/画板 双 tab,且作品面默认;
 * ② 作品卡详情必须落在 router 已注册的 /library/works/:id;
 * ③ /toiv/library 仍重定向到媒体库壳(source=works),经典壳跳转过来才能落到同一页。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

describe("toiv library works face", () => {
    const page = read("src/pages/toiv/library-page.tsx");
    const works = read("src/pages/toiv/library-works.tsx");
    const router = read("src/router.tsx");

    test("library-page 双 tab 且作品为默认", () => {
        expect(page).toContain('useState<"works" | "boards">("works")');
        expect(page).toContain("data-testid={`library-tab-${k}`}");
        expect(page).toContain("<LibraryWorks />");
    });

    test("作品面不得把 job id 链进画板详情路由(10-14 实测 404 回归)", () => {
        // /library/works/:id 由 library-detail.tsx 承载,它把 :id 当**画板 id** 用
        // (fetchBoardItems(id) → GET /api/boards/{id}/items)。传 job id 进去必然 404,
        // 且详情页的改名/导出/删除画板等动作语义全错。作品预览改走页面内置浮层。
        expect(works).not.toContain("/library/works/");
        expect(works).toContain("setPreview(job)");
        expect(works).toContain('aria-label="作品预览"');
        expect(router).toContain('{ path: "/library/works/:id"'); // 画板详情仍在,只是不该收 job id
    });

    test("/toiv/library 重定向到媒体库壳,经典跳转与画布内导航同页", () => {
        expect(router).toContain('{ path: "/toiv/library", element: <Navigate to="/library?source=works" replace /> }');
    });

    test("作品面不静默吞分页失败(P-11):axios 抛错由调用方转错误态", () => {
        // fetchToivWorksPage 直接 await toivHttp.get,失败向上抛;页面 catch 后 setError(true) 显示错误态而非空列表
        expect(works).toContain("setError(true)");
        expect(read("src/services/toiv/client.ts")).toContain("export async function fetchToivWorksPage");
    });
});
