/**
 * Agent Team 任务卡片渲染守卫单测(node:test + react-dom/server 静态渲染):
 * ① verdictText:字符串原样;对象提取文本键;空对象归 "";无已知键 JSON 展开
 * ② TaskCardList:verdict 为对象(存量/异常数据)不崩溃,渲染提取文本(React #31 回归)
 * ③ TaskCardList:verdict 空 + error 态 → 回退 output.error / 规范兜底文案
 * ④ TaskCardList:depends_on 异常数据(非数组)不崩溃
 * ⑤ stripMarkdown:goal 的粗体/标题/反引号/链接标记剥离,压平单行
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi(imageUrl 替身)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { stripMarkdown, verdictText } from "../components/agent-run/agentRunMeta";
import { TaskCardList } from "../components/agent-run/TaskCardList";
import { makeAgentTask } from "./mocks/studioApi";

const h = React.createElement;

const renderCards = (tasks: ReturnType<typeof makeAgentTask>[]): string =>
  renderToStaticMarkup(
    h(TaskCardList, {
      tasks,
      busy: {},
      onAction: async () => undefined,
      onUpload: async () => undefined,
    }),
  );

/* ── ① verdictText 纯函数 ── */
test("verdictText:字符串原样;对象提取 summary/reason/text/error/message", () => {
  assert.equal(verdictText("人工评语"), "人工评语");
  assert.equal(verdictText(""), "");
  assert.equal(verdictText({ error: "显存不足" }), "显存不足");
  assert.equal(verdictText({ summary: "验收通过", score: 9 }), "验收通过");
  assert.equal(verdictText({ reason: "构图偏" }), "构图偏");
  assert.equal(verdictText({ text: "t" }), "t");
  assert.equal(verdictText({ message: "m" }), "m");
  // 空对象归空(历史 _loads 默认 {} 是 React #31 崩溃根因)
  assert.equal(verdictText({}), "");
  // 无已知键 → JSON 展开;数组/null/数字归空
  assert.equal(verdictText({ score: 3 }), '{"score":3}');
  assert.equal(verdictText(null), "");
  assert.equal(verdictText(undefined), "");
  assert.equal(verdictText(42), "");
  assert.equal(verdictText(["a"]), "");
});

/* ── ② verdict 为对象:卡片不崩溃,渲染提取文本 ── */
test("TaskCardList:verdict 为对象(存量数据)渲染文本而非崩溃", () => {
  const task = makeAgentTask("t1", {
    status: "error",
    verdict: { error: "显存不足,请降帧" } as unknown as string,
  });
  const html = renderCards([task]);
  assert.match(html, /显存不足,请降帧/);
  assert.match(html, /agent-task-error/);
});

test("TaskCardList:done 态 verdict 为对象渲染验收意见", () => {
  const task = makeAgentTask("t1", {
    status: "done",
    verdict: { summary: "验收通过" } as unknown as string,
  });
  const html = renderCards([task]);
  assert.match(html, /验收意见:验收通过/);
});

/* ── ③ verdict 空 + error 态:回退 output.error / 兜底文案 ── */
test("TaskCardList:verdict 为空对象时回退 output.error,再兜底规范文案", () => {
  const withOutputErr = makeAgentTask("t1", {
    status: "error",
    verdict: {} as unknown as string,
    output: { error: "OOM 兜底可见" },
  });
  assert.match(renderCards([withOutputErr]), /OOM 兜底可见/);

  const bare = makeAgentTask("t2", {
    status: "error",
    verdict: {} as unknown as string,
    output: {},
  });
  assert.match(renderCards([bare]), /生成失败,可改文案后重生成/);
});

/* ── ④ depends_on 异常数据不崩溃 ── */
test("TaskCardList:depends_on 为非数组(异常数据)按无依赖渲染", () => {
  const task = makeAgentTask("t1", {
    depends_on: { 0: "x" } as unknown as string[],
  });
  const html = renderCards([task]);
  assert.match(html, /任务 t1/);
  assert.ok(!html.includes("agent-task-deps"), "非数组依赖不渲染依赖行");
});

/* ── ⑤ stripMarkdown ── */
test("stripMarkdown:剥离 **、#、反引号、链接语法并压平单行", () => {
  assert.equal(stripMarkdown("**拍一支 30 秒短片**"), "拍一支 30 秒短片");
  assert.equal(stripMarkdown("# 计划\n## 第二镜"), "计划 第二镜");
  assert.equal(stripMarkdown("用 `drama` 模式和 *斜体* 词"), "用 drama 模式和 斜体 词");
  assert.equal(stripMarkdown("[参考片](https://example.com) 风格"), "参考片 风格");
  assert.equal(stripMarkdown("多行\n\n目标:**咖啡店** 开业"), "多行 目标:咖啡店 开业");
  assert.equal(stripMarkdown(""), "");
  assert.equal(stripMarkdown(null), "");
  assert.equal(stripMarkdown(undefined), "");
  assert.equal(stripMarkdown(123), "");
});
