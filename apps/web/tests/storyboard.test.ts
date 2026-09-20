/**
 * 分镜板 v2(M1)web 侧测试:
 * ① rowsToPutPayload:占位行 job_id="";shot_meta/note/shot_text 全量回带
 * ② moveRow:上移/下移/钳制/空数组/越界
 * ③ parseShotMeta:合法/空串/坏 JSON/数组容错
 * ④ 源码断言:LibraryView 灯箱 portal 提升(条件视图内可挂载)、
 *    BoardsView 接分镜模式/剧本拆镜/导出、LibraryView 移入画板带 shot_meta
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { moveRow, parseShotMeta, rowsToPutPayload } from "../lib/storyboard";
import type { BoardItemOut } from "../lib/api";

const here = dirname(fileURLToPath(import.meta.url));

function row(partial: Partial<BoardItemOut>): BoardItemOut {
  return {
    id: 1,
    sort_order: 0,
    note: "",
    shot_text: "",
    shot_meta: "",
    job: null,
    ...partial,
  };
}

test("① rowsToPutPayload:占位行 job_id 空串,shot_meta 回带", () => {
  const payload = rowsToPutPayload([
    row({ id: 11, shot_text: "镜一", shot_meta: '{"scene":"s"}', note: "n1" }),
    row({ id: 12, job: { id: "job-abc" } as never, shot_text: "镜二" }),
  ]);
  assert.deepEqual(payload, [
    { job_id: "", note: "n1", shot_text: "镜一", shot_meta: '{"scene":"s"}' },
    { job_id: "job-abc", note: "", shot_text: "镜二", shot_meta: "" },
  ]);
});

test("② moveRow:移动/钳制/边界", () => {
  const rows = ["a", "b", "c", "d"];
  assert.deepEqual(moveRow(rows, 0, 1), ["b", "a", "c", "d"]); // 下移
  assert.deepEqual(moveRow(rows, 2, 1), ["a", "c", "b", "d"]); // 上移
  assert.deepEqual(moveRow(rows, 0, -5), ["a", "b", "c", "d"]); // to 钳到 0
  assert.deepEqual(moveRow(rows, 3, 99), ["a", "b", "c", "d"]); // to 钳到末尾(原位)
  assert.deepEqual(moveRow(rows, 1, 99), ["a", "c", "d", "b"]); // 移到末尾
  assert.deepEqual(moveRow([], 0, 1), []); // 空
  assert.deepEqual(moveRow(rows, -1, 2), rows); // from 越界原样
  assert.notEqual(moveRow(rows, 0, 1), rows); // 返回新数组
  assert.deepEqual(rows, ["a", "b", "c", "d"]); // 原数组不被改
});

test("③ parseShotMeta:容错解析", () => {
  assert.deepEqual(parseShotMeta('{"scene":"夜","duration_sec":4,"characters":["林凡"]}'), {
    scene: "夜",
    duration_sec: 4,
    characters: ["林凡"],
  });
  assert.equal(parseShotMeta(""), null);
  assert.equal(parseShotMeta("not-json"), null);
  assert.equal(parseShotMeta('["a"]'), null); // 数组不是合法 meta
  assert.equal(parseShotMeta(null), null);
  assert.equal(parseShotMeta(undefined), null);
});

test("④ 源码断言:灯箱提升/分镜接线/shot_meta 透传", () => {
  const libView = readFileSync(join(here, "../components/library/LibraryView.tsx"), "utf8");
  assert.ok(libView.includes("const lightboxPortal ="), "LibraryView 灯箱 portal 未提升为变量");
  assert.ok(
    libView.indexOf("const lightboxPortal =") < libView.indexOf("if (showBoards)"),
    "lightboxPortal 必须在 showBoards 早退之前声明",
  );

  const boardsView = readFileSync(join(here, "../components/library/BoardsView.tsx"), "utf8");
  assert.ok(boardsView.includes("BoardStoryboard"), "BoardsView 未接分镜模式");
  assert.ok(boardsView.includes("createBoardFromScript"), "BoardsView 未接剧本拆镜");
  assert.ok(boardsView.includes("exportBoard"), "BoardsView 未接导出");
  assert.ok(boardsView.includes("shot_meta: it.shot_meta"), "BoardsView removeItem 漏带 shot_meta");

  assert.ok(libView.includes("shot_meta: it.shot_meta"), "LibraryView 移入画板漏带 shot_meta");
  assert.ok(libView.includes("it.job?.id"), "LibraryView 移入画板未做占位行 null 防护");
});
