import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function walkSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkSourceFiles(path));
            continue;
        }
        if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
    }
    return files;
}

const webRoot = resolve(import.meta.dir, "..");
const srcRoot = resolve(webRoot, "src");

const axiosAllowed = new Set([
    "services/api/request.ts",
    "services/api/channel-transport.ts",
    "services/api/image-response.ts",
    "services/api/video-response.ts",
    "services/diagnostics/client-diagnostics.ts",
    // ToIV FastAPI 平面(融合 M1):裸 JSON + ToIV JWT,不走画布信封,故不能并入共享 http
    "services/toiv/client.ts",
]);

// 两个数据平面各自唯一的 axios 实例根:
// - services/api/request.ts → 画布 Go 后端(/studio/api,信封 {code,data,msg,reason},由 http 解包)
// - services/toiv/client.ts → ToIV FastAPI(同源 /api,裸 JSON),见该文件 docstring「两个数据平面,互不混淆」
const axiosInstanceRoots = new Set(["services/api/request.ts", "services/toiv/client.ts"]);

test("business API modules call http instead of axios or request(apiClient)", () => {
    const offenders = walkSourceFiles(resolve(srcRoot, "services"))
        .filter((file) => {
            const rel = relative(srcRoot, file);
            if (axiosAllowed.has(rel)) return false;
            const source = readFileSync(file, "utf8");
            return /from ["']axios["']/.test(source) || /request\s*(?:<[^>]+>)?\s*\(\s*apiClient\./.test(source) || /const api = apiClient/.test(source);
        })
        .map((file) => relative(srcRoot, file));
    expect(offenders).toEqual([]);
});

test("axios.create stays in the two data-plane roots", () => {
    const offenders = walkSourceFiles(srcRoot)
        .filter((file) => {
            if (axiosInstanceRoots.has(relative(srcRoot, file))) return false;
            return readFileSync(file, "utf8").includes("axios.create(");
        })
        .map((file) => relative(srcRoot, file));
    expect(offenders).toEqual([]);
});

test("copied flush Modal padding lives only in AppModal", () => {
    const banned = [
        'styles={{ container: { padding: 0, overflow: "hidden" }, body: { padding: 0 } }}',
        "styles={{ container: { padding: 0 }, body: { padding: 0 } }}",
    ];
    const offenders = walkSourceFiles(srcRoot)
        .filter((file) => {
            if (relative(srcRoot, file) === "components/ui/product/app-modal/app-modal.tsx") return false;
            const source = readFileSync(file, "utf8");
            return banned.some((snippet) => source.includes(snippet));
        })
        .map((file) => relative(srcRoot, file));
    expect(offenders).toEqual([]);
});
