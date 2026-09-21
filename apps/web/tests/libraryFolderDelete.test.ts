/**
 * 作品库文件夹整组删除 P0 单测(2026-09-22)
 * ① 入口:文件夹卡 hover 操作组(打开/删除整组)+ 批量模式整组点选(已选气泡)
 * ② 确认流:Modal 成员数/状态分布/进行中排除/回收站+画板提示/「不再确认」持久化
 * ③ 撤销:复用 deleteJobsBatch + undoTokens + 「全部撤销」循环(与批量删除同范式)
 * ④ 进行中排除:folderTerminalMembers/folderStatusSummary 纯函数(queued/running 剔除)
 * 背景:2026-09-20 曾拍板「不做整组删除防误删」;P0 翻案——删除只作用于
 * 点击瞬间快照的终态成员,回收站 72h + 全部撤销双兜底。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  folderStatusSummary,
  folderTerminalMembers,
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
    kind: "txt2img",
    status: "done",
    prompt: "",
    seed: 1,
    created_at: "2026-09-22T00:00:00Z",
    results: [`${id}.png`],
    ...over,
  };
}

/* ── ① 入口 ── */
test("整组删除入口:文件夹卡 hover 操作组(打开/删除整组),批量模式隐藏", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  // hover 操作组与普通卡同族(.lib-actions),仅非批量模式渲染
  const card = src.slice(src.indexOf("lib-card lib-folder-card"), src.indexOf("lib-foot", src.indexOf("lib-card lib-folder-card")));
  assert.ok(card.includes("lib-actions"), "文件夹卡缺 hover 操作组");
  assert.ok(card.includes('{!batchMode && ('), "操作组应在批量模式下隐藏");
  assert.ok(card.includes('aria-label="打开文件夹"'), "缺「打开」入口");
  assert.ok(card.includes("setOpenBatchId(folder.batchId)"), "「打开」应进下钻");
  assert.ok(card.includes("`删除整组: 共 ${terminalIds.length} 张`"), "缺「删除整组」入口");
  assert.ok(card.includes("handleFolderDelete(folder)"), "「删除整组」未接处理函数");
  // 全组进行中:按钮 disabled + 原因提示(双保险在 handleFolderDelete 内 return)
  assert.ok(card.includes('组内作品均在进行中,暂不能删除'), "缺全组进行中禁用提示");
  assert.ok(card.includes("disabled={terminalIds.length === 0 || folderDeleting}"), "删除钮未接禁用态");
});

test("批量模式:文件夹卡可点选(整组终态成员入删单)+ 已选计数气泡", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("toggleFolderSelect(folder)"), "缺文件夹整组点选");
  // 点选语义:终态成员全入/全出 selectedIds
  const toggle = src.slice(src.indexOf("const toggleFolderSelect"));
  assert.ok(toggle.includes("folderTerminalMembers(folder).map((m) => m.id)"), "点选应圈终态成员");
  assert.ok(toggle.includes("ids.every((id) => next.has(id))"), "缺全入判定(再点取消)");
  // 勾选圈 + 已选 X/Y 气泡 + 卡片选中态
  assert.ok(src.includes("folderAllSelected"), "缺整组全选态");
  assert.ok(src.includes("lib-folder-selected-badge"), "缺已选计数气泡");
  assert.ok(src.includes("已选 {selectedCount}/{terminalIds.length}"), "气泡应显示已选/可删");
  // 「全选本页」仍只圈普通卡(不变式)
  assert.ok(
    src.includes('visibleEntries.flatMap((e) => (e.type === "job" ? [e.job.id] : []))'),
    "全选应跳过文件夹成员",
  );
  // 样式:操作组下沉避开 ×N 角标 + 气泡样式入库
  const css = readSrc("app/styles/library.css");
  assert.ok(css.includes(".lib-folder-card .lib-actions"), "操作组未下沉避让角标");
  assert.ok(css.includes(".lib-folder-selected-badge"), "缺气泡样式");
});

/* ── ② 确认流 ── */
test("确认 Modal:成员数/状态分布/进行中排除/回收站+画板提示/不再确认", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  const modal = src.slice(src.indexOf('title="删除整组作品"'), src.indexOf("/* 一键清理失败作品确认对话框"));
  assert.ok(modal.includes("confirmFolderDelete.members.length"), "缺成员总数");
  assert.ok(modal.includes("folderStatusSummary(confirmFolderDelete).done"), "缺完成数");
  assert.ok(modal.includes("folderStatusSummary(confirmFolderDelete).error"), "缺失败数");
  assert.ok(modal.includes("件将被排除,可在完成后单独删除"), "缺进行中排除明示");
  assert.ok(modal.includes("72 小时内可逐件恢复"), "缺回收站恢复说明");
  assert.ok(modal.includes("画板中的成员将被静默移除"), "缺画板成员提示");
  assert.ok(modal.includes("skipConfirmChecked"), "缺「不再确认」勾选");
  assert.ok(modal.includes("handleFolderModalConfirm"), "确认钮未接 Modal 确认流");
  assert.ok(modal.includes("preventClose={folderDeleting}"), "删除中应禁止关闭");
  // 「不再确认」持久化与单删同一 localStorage 键;skip 路径直达执行体
  const modalConfirm = src.slice(src.indexOf("const handleFolderModalConfirm"));
  assert.ok(modalConfirm.includes('window.localStorage.setItem("toiv_skip_del_confirm", "1")'), "勾选未持久化");
  const click = src.slice(src.indexOf("const handleFolderDelete"));
  assert.ok(click.includes('window.localStorage.getItem("toiv_skip_del_confirm") === "1"'), "未读「不再确认」偏好");
  assert.ok(click.includes("folderTerminalMembers(folder).length === 0"), "缺全组进行中双保险");
});

/* ── ③ 撤销 ── */
test("执行与撤销:快照终态成员 → deleteJobsBatch → toast 全部撤销(批量同范式)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  const exec = src.slice(src.indexOf("const handleConfirmFolderDelete"), src.indexOf("const handleFolderModalConfirm"));
  // 红线:组是视图派生,只删点击瞬间快照的终态成员 id
  assert.ok(exec.includes("folderTerminalMembers(folder).map((m) => m.id)"), "未快照终态成员");
  assert.ok(exec.includes("deleteJobsBatch(ids, deleteJob)"), "未复用批量删除助手");
  assert.ok(exec.includes("undoTokens"), "未收集撤销凭据");
  assert.ok(exec.includes('label: "全部撤销"'), "缺全部撤销入口");
  assert.ok(exec.includes("undoTokens.map((t) => undoDelete(t))"), "撤销未逐件恢复");
  assert.ok(exec.includes("setConfirmFolderDelete(null)"), "成功后未关 Modal");
  assert.ok(exec.includes("件删除失败,其余已移入回收站"), "失败应内联报错并明示已删部分");
});

/* ── ④ 进行中排除(纯函数) ── */
test("folderTerminalMembers:仅 done/error 入删单,queued/running 排除", () => {
  const folder: BatchFolder = {
    batchId: "v:txt2img:1:p",
    variant: true,
    members: [
      makeJob("d1"),
      makeJob("e1", { status: "error", results: [] }),
      makeJob("q1", { status: "queued", results: [] }),
      makeJob("r1", { status: "running", results: [] }),
    ],
  };
  assert.deepEqual(
    folderTerminalMembers(folder).map((m) => m.id),
    ["d1", "e1"],
    "只应保留终态成员且顺序沿用传入列表",
  );
  const allActive: BatchFolder = {
    batchId: "b-x",
    members: [makeJob("q", { status: "queued", results: [] }), makeJob("r", { status: "running", results: [] })],
  };
  assert.equal(folderTerminalMembers(allActive).length, 0, "全组进行中应空删单(按钮禁用)");
});

test("folderStatusSummary:done/error/active 分布计数(其他状态归入进行中)", () => {
  const folder: BatchFolder = {
    batchId: "b-y",
    members: [
      makeJob("d1"),
      makeJob("d2"),
      makeJob("e1", { status: "error", results: [] }),
      makeJob("q1", { status: "queued", results: [] }),
      makeJob("r1", { status: "running", results: [] }),
    ],
  };
  assert.deepEqual(folderStatusSummary(folder), { done: 2, error: 1, active: 2 });
  const empty: BatchFolder = { batchId: "b-z", members: [] };
  assert.deepEqual(folderStatusSummary(empty), { done: 0, error: 0, active: 0 });
});
