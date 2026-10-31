/**
 * P-20 子路径部署防线(2026-10-14 T-U 真机实证):canvas SPA 生产挂 /studio 前缀,
 * createBrowserRouter 有 basename,react-router <Link to>/navigate() 会自动加前缀;
 * 但裸 <a href="/..."> 绕过 basename → 浏览器整页跳 /toiv/ws/... → Next 404。
 * 实证缺陷:短剧列表卡「打开工作台」404(drama-page.tsx:93)。
 * 本测试扫 src/** 全量:禁止裸绝对路径 <a href>(react-router Link 除外),
 * 新增例外必须走 Link/navigate 或在 ALLOW 里白名单登记并写明理由。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const SRC = join(root, "src");

/** 白名单:rel:line 精确登记(改行号须同步)。仅限确知安全的场景。 */
const ALLOW = new Set<string>([
    // markdown 渲染器透传外链(target=_blank,href 来自内容而非站内路径)
    "src/components/ai/ai-message-markdown.tsx",
]);

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) yield* walk(p);
        else if (/\.(tsx?|jsx?)$/.test(name)) yield p;
    }
}

describe("P-20 子路径部署:禁止绕过 router basename 的裸站内绝对路径锚", () => {
    test("src 内 <a href> 一律不允许以 / 开头的站内路径(改用 Link to=)", () => {
        const offenders: string[] = [];
        for (const file of walk(SRC)) {
            const rel = relative(root, file).replaceAll("\\", "/");
            if (ALLOW.has(rel)) continue;
            const src = readFileSync(file, "utf8");
            const lines = src.split("\n");
            lines.forEach((line, i) => {
                // 命中:<a ... href="/..." 或 <a ... href={`/...`}——模板串与字面量都算
                const raw = /<a\b[^>]*href=\{?(`"?\/)/.test(line);
                if (raw) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    test("已修复的三处(2026-10-14)不得回退为裸锚", () => {
        const dramaPage = readFileSync(join(root, "src/pages/toiv/drama-page.tsx"), "utf8");
        // R11 + W2：列表卡只进 /create?project=；basename 安全 <Link>。
        expect(dramaPage).toContain("<Link key={proj.id} to={`/create?project=${proj.id}`}");
        expect(dramaPage).not.toMatch(/<a\b[^>]*href=\{`\/(toiv\/ws|create)/);
        const router = readFileSync(join(root, "src/router.tsx"), "utf8");
        expect(router).toContain("ToivDramaDetailToCreateRedirect");
        expect(router).toContain('{ path: "/toiv/drama/:id", element: <ToivDramaDetailToCreateRedirect /> }');
        expect(router).not.toContain("drama-detail");
        const pane = readFileSync(join(root, "src/pages/settings/channel-settings-pane.tsx"), "utf8");
        expect(pane).toContain('<Link to="/agents"');
        expect(pane).not.toContain('href="/agents"');
    });
});
