/**
 * apiErrorMessage(lib/api.ts)单测(node:test,无 DOM):
 * 2026-08-27 助手「回复失败:[object Object]」根因修复——FastAPI 422 的 detail
 * 是 [{loc,msg,type}] 数组,直接 new Error(数组) 只会得到 [object Object]。
 * 覆盖:字符串 detail 原样 / 422 数组序列化(loc 去 body 前缀) / 空数组与 null
 * 回退「兜底 (status)」/ 非对象项容错。
 * 相对路径 ../lib/api 不经 loader 替身映射,拿到的是真实实现(同 trackJob.test.ts)。
 */
import assert from "node:assert/strict";
import test from "node:test";

// ── window/localStorage 替身:必须在导入 api.ts 前装好(模块顶层读 window 兜底) ──
const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  clear: () => localStore.clear(),
};

const { apiErrorMessage } = await import("../lib/api");

test("字符串 detail:原样返回(后端业务错误直通)", () => {
  assert.equal(apiErrorMessage("会话不存在", "对话失败", 404), "会话不存在");
});

test("422 数组 detail:逐项「字段路径: 消息」拼接,loc 去掉 body 前缀", () => {
  const detail = [
    { loc: ["body", "messages"], msg: "List should have at most 40 items", type: "too_long" },
    { loc: ["body", "messages", 3, "content"], msg: "String should have at most 8000 characters", type: "too_long" },
  ];
  const out = apiErrorMessage(detail, "对话失败", 422);
  assert.ok(out.includes("messages: List should have at most 40 items"), out);
  assert.ok(out.includes("messages.3.content: String should have at most 8000 characters"), out);
  assert.ok(!out.includes("[object Object]"), out);
});

test("422 数组缺 loc:仅输出 msg", () => {
  const out = apiErrorMessage([{ msg: "校验失败" }], "对话失败", 422);
  assert.equal(out, "校验失败");
});

test("空数组 / null / 非对象项:回退「兜底 (status)」,绝不出现 [object Object]", () => {
  assert.equal(apiErrorMessage([], "对话失败", 422), "对话失败 (422)");
  assert.equal(apiErrorMessage(null, "对话失败", 500), "对话失败 (500)");
  assert.equal(apiErrorMessage(undefined, "提案回执失败", 502), "提案回执失败 (502)");
  // 混杂非对象项时仍序列化文本项
  const out = apiErrorMessage(["plain", { loc: ["body", "x"], msg: "bad" }], "对话失败", 422);
  assert.ok(out.includes("plain") && out.includes("x: bad"), out);
});
