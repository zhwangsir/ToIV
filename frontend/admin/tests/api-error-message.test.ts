/** apiErrorMessage 归一契约:字符串 detail 原样 / 422 数组拼「路径: 消息」/ 容错 / 空回退。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { apiErrorMessage } from "../lib/api";

test("字符串 detail 原样返回", () => {
  assert.equal(apiErrorMessage("应用 id 已存在", "创建应用失败", 409), "应用 id 已存在");
});

test("422 数组拼「字段路径: 消息」,loc 滤掉 body 前缀", () => {
  const detail = [
    { loc: ["body", "workflow_json"], msg: "field required", type: "value_error" },
    { loc: ["body", "id"], msg: "string too short", type: "value_error" },
  ];
  assert.equal(
    apiErrorMessage(detail, "创建应用失败", 422),
    "workflow_json: field required；id: string too short",
  );
});

test("loc 非数组时只取 msg;非对象项 String 化;空 msg 项滤除", () => {
  const detail = [
    { loc: "weird", msg: "bad value" },
    "plain string item",
    { loc: ["body"], msg: "" },
    42,
  ];
  assert.equal(apiErrorMessage(detail, "兜底", 422), "bad value；plain string item；42");
});

test("空数组/空字符串/null 回退「fallback (status)」", () => {
  assert.equal(apiErrorMessage([], "加载失败", 500), "加载失败 (500)");
  assert.equal(apiErrorMessage("", "加载失败", 502), "加载失败 (502)");
  assert.equal(apiErrorMessage(null, "加载失败", 503), "加载失败 (503)");
  assert.equal(apiErrorMessage(undefined, "加载失败", 504), "加载失败 (504)");
});
