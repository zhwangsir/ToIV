/**
 * F8(2026-10-14 融合批):market/library 迁 canvas 的跳转契约(源码断言)。
 * ①跳转表必须含 market→/studio/toiv/market、library→/studio/toiv/library;
 * ②两条逃生口必须同在:?classic=1 与 R18 模式都留在经典壳(canvas 纯 SFW,R18 面唯一家在经典);
 * ③经典渲染路径不得被删:market/library 仍在 VALID_VIEWS 与 viewImporters(逃生口要真能渲染);
 * ④canvas 侧作品面必须走分页契约且不得带 R18 头(SFW 拍板面)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf-8");
}

test("F8 跳转表:market/library 指向 canvas 对应页", () => {
  const src = readSrc("apps/web/app/page.tsx");
  const block = src.slice(src.indexOf("const CANVAS_MIGRATED_VIEWS"));
  const table = block.slice(0, block.indexOf("};"));
  assert.match(table, /market:\s*"\/studio\/toiv\/market"/);
  assert.match(table, /library:\s*"\/studio\/toiv\/library"/);
});

test("F8 逃生口:classic=1 与 R18 模式都必须留在经典壳", () => {
  const src = readSrc("apps/web/app/page.tsx");
  const at = src.indexOf("const migrated = CANVAS_MIGRATED_VIEWS");
  assert.notEqual(at, -1, "缺少 F8 跳转分支");
  const block = src.slice(at, src.indexOf("return;\n    }", at) + 12);
  assert.match(block, /classic=1/, "缺 ?classic=1 逃生口");
  assert.match(block, /!r18/, "缺 R18 模式逃生口(canvas 纯 SFW,R18 面不能跳走)");
  assert.match(block, /window\.location\.replace\(migrated\)/);
});

test("F8 不删经典渲染路径:逃生口要真能渲染 market/library", () => {
  const src = readSrc("apps/web/app/page.tsx");
  const valid = src.slice(src.indexOf("const VALID_VIEWS"), src.indexOf("const VIEW_META"));
  assert.match(valid, /"market"/);
  assert.match(valid, /"library"/);
  assert.match(src, /view === "market" && <MarketView/);
  assert.match(src, /view === "library" && <LibraryView/);
});

test("canvas 作品面:分页契约 + 签名媒体 + 回收站/重跑,且不带 R18 头", () => {
  const src = readSrc("apps/canvas/web/src/pages/toiv/library-works.tsx");
  assert.match(src, /fetchToivWorksPage\(/, "必须走 /api/jobs 分页,不得一次全量");
  assert.match(src, /hasMore/, "必须有加载更多而非隐藏截断");
  assert.match(src, /toivMediaUrl|toivCoverImageUrl/, "媒体必须走 ?token= 签名口径(P-1)");
  assert.match(src, /deleteToivWork|restoreToivWork|rerunToivWork/);
  assert.doesNotMatch(src, /X-NSFW|nsfw:\s*true/, "canvas 是纯 SFW 面,不得请求 R18 列表");
  const client = readSrc("apps/canvas/web/src/services/toiv/client.ts");
  assert.match(client, /throw|reject/i, "分页失败不得吞成空数组(P-11)");
});
