/**
 * F11(2026-10-15):媒体库收编等价矩阵——canvas 作品库必须覆盖经典 web 壳 LibraryView 的核心面。
 *
 * 口径:源码断言(bun test,无网络)。web 侧清单从 apps/web/components/library/LibraryView.tsx
 * (4275 行,经典壳作品库)派生;canvas 侧对应物在 library-page / library-works /
 * library-transcript-search / library-detail 与 services/toiv。
 * F12 退役 apps/web 后 web 源文件消失,web 侧断言自动 skip,canvas 侧断言永久生效。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

const WEB_LIB_REL = "../../web/components/library/LibraryView.tsx";
const webLibAvailable = existsSync(join(root, WEB_LIB_REL));
const webLib = webLibAvailable ? read(WEB_LIB_REL) : "";

describe("F11 等价矩阵:web 壳作品库面清单(派生源)", () => {
    test.skipIf(!webLibAvailable)("LibraryView 含 作品列表/搜索/排序/删除/回收站/恢复/预览/画板 关键词", () => {
        // 每条都能在 web 源码里定位(行号见 F11_GAP 注);这是「web 提供了什么」的证据面
        for (const kw of ["回收站", "恢复", "预览", "画板", "搜索", "删除", "排序", "批量"]) {
            expect(webLib).toContain(kw);
        }
    });
});

describe("F11 等价矩阵:canvas 作品库对应物", () => {
    const page = read("src/pages/toiv/library-page.tsx");
    const works = read("src/pages/toiv/library-works.tsx");
    const detail = read("src/pages/toiv/library-detail.tsx");
    const client = read("src/services/toiv/client.ts");

    test("作品列表面:works tab 默认 + /api/jobs 分页(P-11 形状门)", () => {
        expect(page).toContain("<LibraryWorks />");
        expect(works).toContain("fetchToivWorksPage");
        expect(client).toContain("export async function fetchToivWorksPage");
        expect(client).toContain("作业列表响应形状异常"); // 非数组/非信封 200 抛错
    });

    test("画板列表面:boards tab + /api/boards + 画板详情路由", () => {
        expect(page).toContain("fetchBoards");
        expect(page).toContain("mediaLibraryWorksDetailPath(board.id)");
        expect(client).toContain("export async function fetchBoards");
        expect(detail).toContain("fetchBoardItems"); // /library/works/:id = 画板详情
    });

    test("回收站/恢复面:trash 模式 + restore(与 web 回收站 72h 恢复同链路)", () => {
        expect(works).toContain("fetchToivTrashPage");
        expect(works).toContain("restoreToivWork");
        expect(works).toContain("trashMode");
        expect(client).toContain("export async function restoreToivWork");
    });

    test("预览面:页面内置浮层,且 job id 不进画板详情路由(10-14 404 回归护栏)", () => {
        expect(works).toContain("setPreview(job)");
        expect(works).toContain('aria-label="作品预览"');
        expect(works).not.toContain("/library/works/");
    });

    test("搜索/排序面:提示词过滤 + 时间排序切换", () => {
        expect(works).toContain("搜索提示词");
        expect(works).toContain("sortNewest");
    });

    test("台词检索面(F11 新增,admin-only):tab 门禁 + 防抖 + 预览浮层", () => {
        const panel = read("src/pages/toiv/library-transcript-search.tsx");
        const svc = read("src/services/toiv/transcript-search.ts");
        expect(page).toContain("台词检索");
        expect(page).toContain("isTranscriptSearchAvailable");
        expect(page).toContain("<LibraryTranscriptSearch />");
        expect(svc).toContain("/admin/media/transcripts/search");
        expect(svc).toContain('return role === "admin"');
        expect(svc).toContain("台词检索响应形状异常"); // P-11:畸形 200 抛错,不静默空集
        expect(panel).toContain("DEBOUNCE_MS = 300");
        expect(panel).toContain('data-testid="transcript-search-input"');
        expect(panel).toContain('aria-label="台词命中预览"');
        expect(panel).not.toContain("/library/works/"); // 命中媒体走浮层,不走画板详情路由
    });
});

/**
 * F11_GAP(只记录,不实现;web-only 而 canvas 作品库当前缺失的面,行号=LibraryView.tsx 证据):
 * 1. 收藏/「只看收藏」(L313,L1358;localStorage 持久)——canvas 无收藏概念。
 * 2. 网格密度切换(L302,L721;持久化)——canvas 固定网格。
 * 3. 视频一键超分到 4K(L379,L1135;M6 fleet 帧级管线+轮询)——canvas 无超分入口。
 * 4. 批量管理/批量删除/全选(L886,L919,含文件夹整组删除 L371)——canvas 只有逐件删除
 *    (client.ts 已有 bulkDeleteJobs,但作品面 UI 未接线)。
 * 5. 动态文件夹/保存视图(L316;localStorage)——canvas 无文件夹组织。
 * 6. 灯箱增强:下载/分享/键盘 ←→ 穿梭/D 下载/R 重试(L3335,L3440,L3690)——canvas 预览浮层只有播放+重跑+删除。
 * 7. 「移入画板」选择器(L400,L827;从作品卡加入画板)——canvas 画板详情可编辑成员(library-detail
 *    putBoardItems),但作品面没有一键移入画板入口。
 * 8. 3D/音频类型占位与灯箱预览(L230)——canvas works 有 kind=3d 过滤与音频内联播放器,但 3D 无预览体。
 */
