/**
 * AssetPicker 服务端分页单测(node:test,无 DOM):
 * ① mergeJobsPage:按 Job id 去重追加(拉取间隙新作业插入顶部 → 页间位置漂移,
 *    第二页会含首页尾部条目;不去重则同一产物在网格里重复出现)
 * ② 组件源码断言:首页带 hasMore 判定、「加载更多」以 jobs.length 为 offset、
 *    追加走 mergeJobsPage 去重
 * 回归锚点:此前 AssetPicker 只拉首页 120 条且无分页/去重,老作品资产不可选,
 * 朴素分页又会在页间重叠时产出重复条目。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { mergeJobsPage } from "../components/generate/AssetPicker";
import type { JobItem } from "../lib/types";

const testDir = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(testDir, "..", rel), "utf8");
}

function job(id: string): JobItem {
  return {
    id,
    prompt_id: `p-${id}`,
    kind: "txt2img",
    status: "done",
    prompt: "",
    seed: 1,
    created_at: "",
    results: [`/api/images?filename=${id}.png`],
  };
}

test("① mergeJobsPage:页间重叠条目按 id 去重,新条目保持顺序追加", () => {
  const page1 = [job("a"), job("b"), job("c")];
  // 拉第二页时顶部来了新作业 n,原页 1 尾部 c 漂进页 2 开头(位置漂移重叠)
  const page2 = [job("c"), job("d"), job("e")];
  const merged = mergeJobsPage(page1, page2);
  assert.deepEqual(
    merged.map((j) => j.id),
    ["a", "b", "c", "d", "e"],
    "重叠的 c 不得重复出现",
  );
});

test("①b mergeJobsPage:整页都是已见条目(快速连点/满页漂移)不重复;空页原样", () => {
  const prev = [job("a"), job("b")];
  assert.deepEqual(mergeJobsPage(prev, [job("a"), job("b")]).map((j) => j.id), ["a", "b"]);
  assert.deepEqual(mergeJobsPage(prev, []).map((j) => j.id), ["a", "b"]);
  assert.deepEqual(mergeJobsPage([], [job("x")]).map((j) => j.id), ["x"]);
});

test("② AssetPicker 分页接线:首页 hasMore 判定 + 下一页 offset=已加载条数 + 去重合并(源码断言)", () => {
  const src = readSrc("components/generate/AssetPicker.tsx");
  assert.ok(src.includes("fetchJobsPage(0, PAGE_LIMIT)"), "首页未走 PAGE_LIMIT 分页拉取");
  assert.ok(src.includes("setHasMore(list.length >= PAGE_LIMIT)"), "首页满页未置 hasMore");
  assert.ok(src.includes("fetchJobsPage(jobs.length, PAGE_LIMIT)"), "下一页 offset 未取已加载条数");
  assert.ok(src.includes("mergeJobsPage(prev, page)"), "追加未走去重合并(页间重叠会重复)");
  assert.ok(src.includes("加载更多"), "缺「加载更多」入口");
});
