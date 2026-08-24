/**
 * 作品库内容分组(batch_id 文件夹)+ qwen_edit 归图像类 单测(2026-08-24)
 * ① groupLibraryEntries:同批折叠/位置取最新成员/单成员回落/无 batch_id 旧作业不变
 * ② folderCover:封面=首个有产物成员
 * ③ kind 归属:qwen_edit → 图像(文件夹按成员 kind 进图像筛选桶)
 * ④ LibraryView 源码断言:文件夹卡(封面+×N 角标)/ 下钻(面包屑+成员网格)/
 *    主网格去重 / 成员卡同行为(大图组内穿梭 + 单独删除)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  folderCover,
  groupLibraryEntries,
  kindLabel,
  kindToFilter,
  type BatchFolder,
} from "../lib/libraryQuery";
import type { JobItem } from "../lib/types";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

function makeJob(id: string, over: Partial<JobItem> = {}): JobItem {
  return {
    id,
    prompt_id: `p-${id}`,
    kind: "qwen_edit",
    status: "done",
    prompt: "",
    seed: 1,
    created_at: "2026-08-24T00:00:00Z",
    results: [`${id}.png`],
    ...over,
  };
}

/* ── ① 分组折叠 ── */
test("groupLibraryEntries:同批 8 个成员折叠为一个文件夹,主网格不再平铺", () => {
  const batch = "orbit-abc123";
  const members = Array.from({ length: 8 }, (_, i) =>
    makeJob(`m${i}`, { batch_id: batch }),
  );
  const plain = makeJob("x", { kind: "txt2img" });
  // newest-first:plain 最新,成员按 m0..m7 依次更早
  const entries = groupLibraryEntries([plain, ...members]);
  assert.equal(entries.length, 2, "8 成员应折叠为 1 个文件夹 + 1 张普通卡");
  assert.equal(entries[0].type, "job");
  assert.equal(entries[1].type, "batch");
  const folder = (entries[1] as { type: "batch"; folder: BatchFolder }).folder;
  assert.equal(folder.batchId, batch);
  assert.equal(folder.members.length, 8);
  assert.deepEqual(
    folder.members.map((m) => m.id),
    members.map((m) => m.id),
    "成员顺序应沿用传入(已排序)列表",
  );
});

test("groupLibraryEntries:文件夹位置取首个(最新)成员处;无 batch_id 旧作业原样", () => {
  const a = makeJob("a", { batch_id: "b1" });
  const mid = makeJob("mid", { kind: "txt2img" });
  const b = makeJob("b", { batch_id: "b1" });
  const entries = groupLibraryEntries([a, mid, b]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, "batch", "文件夹应位于最新成员的位置");
  assert.equal(entries[1].type, "job");
  // 无 batch_id / 空串都不分组
  const legacy = groupLibraryEntries([makeJob("l1"), makeJob("l2", { batch_id: "" })]);
  assert.ok(legacy.every((e) => e.type === "job"), "旧作业(无 batch_id)行为不变");
});

test("groupLibraryEntries:成员删到只剩 1 个时回落普通卡(文件夹自然消失)", () => {
  const only = makeJob("solo", { batch_id: "b-gone" });
  const entries = groupLibraryEntries([only]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "job");
  assert.equal((entries[0] as { type: "job"; job: JobItem }).job.id, "solo");
});

/* ── ② 封面 ── */
test("folderCover:封面=首个有产物的成员,全员无产物回退首成员", () => {
  const running = makeJob("r", { status: "running", results: [], batch_id: "b2" });
  const done = makeJob("d", { batch_id: "b2" });
  const folder: BatchFolder = { batchId: "b2", members: [running, done] };
  assert.equal(folderCover(folder).id, "d", "应跳过无产物成员");
  const none: BatchFolder = {
    batchId: "b3",
    members: [running, makeJob("e", { status: "error", results: [], batch_id: "b3" })],
  };
  assert.equal(folderCover(none).id, "r", "全员无产物回退首成员(占位卡)");
});

/* ── ③ kind 归属 ── */
test("kindToFilter:qwen_edit 归图像类(文件夹按成员 kind 进图像筛选桶)", () => {
  assert.equal(kindToFilter("qwen_edit"), "image");
  assert.equal(kindLabel("qwen_edit"), "智能编辑");
});

/* ── ④ LibraryView 源码断言 ── */
test("LibraryView:文件夹卡(封面缩略图 + ×N 角标 + 标题/时间)与下钻视图", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("groupLibraryEntries"), "未接分组管线");
  assert.ok(src.includes("folderCover"), "缺封面选取");
  assert.ok(src.includes("lib-folder-badge"), "缺 ×N 角标");
  assert.ok(src.includes("×{folder.members.length}"), "角标应显示成员数");
  assert.ok(src.includes("360° 环绕序列"), "缺文件夹标题");
  assert.ok(src.includes("setOpenBatchId(folder.batchId)"), "点击文件夹应进入下钻");
  // 下钻:面包屑 + 成员网格
  assert.ok(src.includes("lib-breadcrumb"), "缺面包屑");
  assert.ok(src.includes("环绕序列 {openFolder.batchId.slice(0, 8)}"), "面包屑缺批次标识");
  assert.ok(src.includes("openFolder.members.map"), "缺成员网格");
  assert.ok(src.includes("setOpenBatchId(null)"), "缺返回主网格");
  // 主网格不再平铺成员:分组后才分页渲染
  assert.ok(src.includes("visibleEntries"), "主网格应渲染分组后的条目");
  assert.ok(!src.includes("visibleJobs"), "主网格不应再平铺未分组列表");
});

test("LibraryView:成员卡同行为(大图组内穿梭 / 单独删除),不做整组删除", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  // 灯箱穿梭范围:下钻内点开成员限定组内
  assert.ok(src.includes("openLightbox(job, openFolder.members)"), "成员大图应组内穿梭");
  assert.ok(src.includes("lightboxScope"), "灯箱缺穿梭范围状态");
  // 成员单独删除复用既有确认流
  const drill = src.slice(src.indexOf("lib-breadcrumb"));
  assert.ok(drill.includes("handleDelete(job)"), "成员应可单独删除");
  // 批量「全选本页」只选普通卡,文件夹成员不参与主网格批量选择(防整组误删)
  assert.ok(
    src.includes('visibleEntries.flatMap((e) => (e.type === "job" ? [e.job.id] : []))'),
    "全选应跳过文件夹成员",
  );
});
