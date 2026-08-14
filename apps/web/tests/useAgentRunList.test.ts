/**
 * useAgentRunList 列表页 hook 单测(node:test + 自制 renderHook):
 * ① 挂载加载历史列表
 * ② 创建 L0 → 不跳转(返回 kind:"l0" + 秒回提示)
 * ③ 创建 L1/L2 → 返回 runId(页面据此跳详情)
 * ④ 空目标不入库,错误透出
 * ⑤ 创建失败透出错误条
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useAgentRunList } from "../components/agent-run/useAgentRunList";
import { flush, renderHook } from "./helpers/renderHook";
import { agentCalls, agentImpl, resetAgentImpl } from "./mocks/studioApi";

beforeEach(() => {
  resetAgentImpl();
});

test("① 挂载加载历史 run 列表", async () => {
  agentImpl.listAgentRuns = async () => [
    {
      id: "r1",
      level: "L2",
      goal: "拍短片",
      status: "running",
      created_at: "2026-08-14T00:00:00Z",
      task_counts: { total: 5, done: 2, error: 0 },
    },
  ];
  const h = renderHook(() => useAgentRunList());
  await flush();
  assert.equal(h.result.current?.runs.length, 1);
  assert.equal(h.result.current?.runs[0]?.task_counts.done, 2);
  assert.equal(h.result.current?.loading, false);
  h.unmount();
});

test("② 创建 L0:不跳转,返回 kind=l0 并给秒回提示", async () => {
  agentImpl.createAgentRun = async () => ({ level: "L0", ack: "已收到,直连对话工作台", run_id: null });
  const h = renderHook(() => useAgentRunList());
  await flush();
  const outcome = await h.result.current!.create("帮忙写句咖啡店文案");
  await flush();
  assert.equal(outcome?.kind, "l0", "L0 不跳详情页");
  assert.equal(outcome?.runId, null);
  assert.equal(h.result.current?.l0Ack, "已收到,直连对话工作台", "秒回提示已透出");
  assert.equal(agentCalls.createAgentRun, 1);
  h.unmount();
});

test("③ 创建 L2:返回 runId,页面跳详情进计划确认门", async () => {
  agentImpl.createAgentRun = async () => ({
    level: "L2",
    ack: "已拆成 3 步",
    run_id: "r-42",
    plan: { tasks: [] },
  });
  const h = renderHook(() => useAgentRunList());
  await flush();
  const outcome = await h.result.current!.create("拍一支 30 秒短片");
  assert.equal(outcome?.kind, "run");
  assert.equal(outcome?.runId, "r-42");
  assert.equal(h.result.current?.l0Ack, null, "L1/L2 不出 L0 提示");
  h.unmount();
});

test("④ 空目标:不发请求,错误透出", async () => {
  const h = renderHook(() => useAgentRunList());
  await flush();
  const outcome = await h.result.current!.create("   ");
  await flush();
  assert.equal(outcome, null);
  assert.equal(agentCalls.createAgentRun, 0, "空目标不入库");
  assert.match(h.result.current?.error ?? "", /一句话描述/);
  h.unmount();
});

test("⑤ 创建失败:错误透出,creating 复位", async () => {
  agentImpl.createAgentRun = () => Promise.reject(new Error("Leader 规划超时"));
  const h = renderHook(() => useAgentRunList());
  await flush();
  const outcome = await h.result.current!.create("拍短片");
  await flush();
  assert.equal(outcome, null);
  assert.match(h.result.current?.error ?? "", /Leader 规划超时/);
  assert.equal(h.result.current?.creating, false);
  // clearError 可关闭
  h.result.current!.clearError();
  await flush();
  assert.equal(h.result.current?.error, null);
  h.unmount();
});
