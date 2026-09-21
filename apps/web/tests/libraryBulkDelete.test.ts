/**
 * 作品库大组切端点 P1 单测(2026-09-21)
 * ① deleteJobsSmart 阈值决策机:>20 走 bulk(形状映射与本地循环一致)/ ≤20 走循环 / bulk 抛错回退循环
 * ② LibraryView 批量+整组两处处理器接 deleteJobsSmart,toast/全部撤销语义不变
 * ③ BoardsView 板列表卡 hover 删除入口 + 确认 Modal(danger,「不删成员作品」)+ 执行函数复用
 * 背景:POST /api/jobs/bulk-delete 已上线(ids≤200,逐件归属校验+独立 undo_token);
 * 前端 >20 成员时一次 HTTP 软删,端点异常(401/网络)自动回退本地循环不阻断删除。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { deleteJobsSmart } from "../lib/libraryQuery";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

function makeIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `id-${i + 1}`);
}

/* ── ① 阈值决策机 ── */
test("deleteJobsSmart:>阈值走 bulk,done/failed/undoTokens 映射与本地循环同形", async () => {
  const ids = makeIds(21);
  const singleCalls: string[] = [];
  let bulkCalls = 0;
  const result = await deleteJobsSmart(ids, {
    single: async (id) => {
      singleCalls.push(id);
    },
    bulk: async (got) => {
      bulkCalls++;
      assert.deepEqual([...got], ids, "bulk 应一次收到全部 id");
      return {
        done: [
          { id: "id-1", undo_token: "tok-1" },
          { id: "id-2" }, // 无凭据须过滤
          { id: "id-3", undo_token: "" }, // 空凭据须过滤
          { id: "id-4", undo_token: "tok-4" },
        ],
        failed: ["id-5"],
      };
    },
  });
  assert.equal(bulkCalls, 1);
  assert.deepEqual(singleCalls, [], ">20 不应走本地循环");
  assert.deepEqual(result.done, ["id-1", "id-2", "id-3", "id-4"], "done=响应 done 的 id 列表");
  assert.deepEqual(result.failed, ["id-5"]);
  assert.deepEqual(result.undoTokens, ["tok-1", "tok-4"], "空/缺 undo_token 须过滤");
});

test("deleteJobsSmart:≤阈值维持本地顺序循环,不调 bulk", async () => {
  const ids = makeIds(20);
  const singleCalls: string[] = [];
  let bulkCalls = 0;
  const result = await deleteJobsSmart(ids, {
    single: async (id) => {
      singleCalls.push(id);
      return { undo_token: `tok-${id}` };
    },
    bulk: async () => {
      bulkCalls++;
      return { done: [], failed: [] };
    },
  });
  assert.equal(bulkCalls, 0, "≤20 不应调 bulk 端点");
  assert.deepEqual(singleCalls, ids, "应逐条顺序调用 single");
  assert.equal(result.done.length, 20);
  assert.equal(result.failed.length, 0);
  assert.equal(result.undoTokens.length, 20);
});

test("deleteJobsSmart:bulk 整体抛错(401/网络)自动回退本地循环,不阻断删除", async () => {
  const ids = makeIds(25);
  const singleCalls: string[] = [];
  const result = await deleteJobsSmart(ids, {
    single: async (id) => {
      singleCalls.push(id);
      if (id === "id-7") throw new Error("boom");
      return { undo_token: `tok-${id}` };
    },
    bulk: async () => {
      throw new Error("401 unauthorized");
    },
  });
  assert.deepEqual(singleCalls, ids, "回退后应逐条尝试全部 id(失败不中断)");
  assert.equal(result.done.length, 24);
  assert.deepEqual(result.failed, ["id-7"]);
  assert.equal(result.undoTokens.length, 24);
});

test("deleteJobsSmart:自定义 threshold 边界(=阈值走循环,+1 走 bulk)", async () => {
  let bulkCalls = 0;
  const deps = {
    single: async (_id: string) => {},
    bulk: async (_ids: readonly string[]) => {
      bulkCalls++;
      return { done: [], failed: [] };
    },
  };
  await deleteJobsSmart(makeIds(3), { ...deps, threshold: 3 });
  assert.equal(bulkCalls, 0, "等于阈值应走本地循环");
  await deleteJobsSmart(makeIds(4), { ...deps, threshold: 3 });
  assert.equal(bulkCalls, 1, "超过阈值应走 bulk");
});

/* ── ② LibraryView 接线 ── */
test("LibraryView:批量/整组两处处理器接 deleteJobsSmart,toast/全部撤销语义不变", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("bulkDeleteJobs"), "应引入 bulkDeleteJobs 封装");
  const batch = src.slice(
    src.indexOf("const handleConfirmBatchDelete"),
    src.indexOf("const handleFolderDelete"),
  );
  assert.ok(
    batch.includes("deleteJobsSmart(ids, { single: deleteJob, bulk: bulkDeleteJobs })"),
    "批量删除未切 deleteJobsSmart",
  );
  assert.ok(batch.includes('label: "全部撤销"'), "批量删除缺全部撤销入口");
  assert.ok(batch.includes("undoTokens.map((t) => undoDelete(t))"), "批量删除撤销未逐件恢复");
  assert.ok(batch.includes("已删除 ${done.length} 件作品"), "批量删除 toast 文案漂移");
  assert.ok(batch.includes("已保留选中,可重试"), "批量删除失败内联报错漂移");
  const folder = src.slice(
    src.indexOf("const handleConfirmFolderDelete"),
    src.indexOf("const handleFolderModalConfirm"),
  );
  assert.ok(
    folder.includes("deleteJobsSmart(ids, { single: deleteJob, bulk: bulkDeleteJobs })"),
    "整组删除未切 deleteJobsSmart",
  );
  assert.ok(folder.includes("folderTerminalMembers(folder).map((m) => m.id)"), "整组删除仍须快照终态成员");
  assert.ok(folder.includes('label: "全部撤销"'), "整组删除缺全部撤销入口");
  assert.ok(folder.includes("undoTokens.map((t) => undoDelete(t))"), "整组删除撤销未逐件恢复");
});

/* ── ③ BoardsView 板卡删除 ── */
test("BoardsView:板列表卡 hover 删除入口 + 确认 Modal「不删成员作品」+ 执行复用", () => {
  const src = readSrc("components/library/BoardsView.tsx");
  // 板列表卡(非详情)hover 操作组:与作品卡同族 lib-actions/lib-action-btn--danger
  const listCard = src.slice(
    src.indexOf("lib-card lib-board-card"),
    src.indexOf("lib-foot", src.indexOf("lib-card lib-board-card")),
  );
  assert.ok(listCard.includes("lib-actions"), "板列表卡缺 hover 操作组");
  assert.ok(listCard.includes("lib-action-btn lib-action-btn--danger"), "板卡删除钮非同族 danger 样式");
  assert.ok(listCard.includes('aria-label={`删除画板: ${b.name}`}'), "板卡删除钮缺无障碍标签");
  assert.ok(listCard.includes("不删成员作品"), "板卡删除钮 title 未明示不删成员");
  assert.ok(listCard.includes("setConfirmDeleteBoard(b)"), "板卡删除未接既有确认流");
  // 确认 Modal:danger 基座 + 文案明示「仅删除组织,不删成员作品」
  const modal = src.slice(src.indexOf("删除画板「"), src.indexOf("<Modal", src.indexOf("删除画板「")));
  assert.ok(modal.includes("danger"), "确认 Modal 缺 danger 基座");
  assert.ok(modal.includes("画板仅删除组织,不删成员作品"), "Modal 文案未明示不删成员作品");
  assert.ok(modal.includes("保留在作品库"), "Modal 文案未明示作品去向");
  // 执行函数复用 deleteBoard(板卡与详情页同一入口)+ 列表移除 + toast
  assert.ok(src.includes("await deleteBoard(confirmDeleteBoard.id)"), "删除未复用 deleteBoard 执行函数");
  assert.ok(
    src.includes("setBoards((prev) => (prev ?? []).filter((b) => b.id !== confirmDeleteBoard.id))"),
    "删除后未从列表移除",
  );
  assert.ok(src.includes("已删除(作品保留在作品库)"), "缺删除成功 toast");
});
