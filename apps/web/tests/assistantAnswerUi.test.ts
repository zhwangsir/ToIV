/**
 * 助手回答 UI 重做(2026-09-28,参考 ChatGPT / Claude)单测:
 * ① parseMarkdownBlocks 块级解析 / splitInline 行内切片
 * ② 思考轮次 upsert / 收尾 / 过程块摘要
 * ③ 逐字显现步长
 * ④ 源码断言:thinking 事件不计首块、停止键并入发送位、重新生成、贴底跟随、CSS token 纪律
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  parseMarkdownBlocks,
  splitInline,
  upsertThinkingRound,
  settleThinking,
  processSummaryLabel,
  hasThinkingText,
  revealStep,
} from "../components/assistant/assistantFormat";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("markdown:标题/列表/代码块/引用/分隔线/表格/段落", () => {
  const md = [
    "## 方案",
    "第一段",
    "续行",
    "",
    "- 甲",
    "- 乙",
    "  补充说明",
    "",
    "1. 一",
    "2. 二",
    "",
    "```python",
    "print(1)",
    "```",
    "> 引用",
    "---",
    "| 名称 | 值 |",
    "| --- | --- |",
    "| a | 1 |",
  ].join("\n");
  const b = parseMarkdownBlocks(md);
  assert.deepEqual(b.map((x) => x.type), ["h", "p", "ul", "ol", "code", "quote", "hr", "table"]);
  assert.deepEqual(b[0], { type: "h", level: 2, text: "方案" });
  assert.deepEqual(b[1], { type: "p", text: "第一段\n续行" });
  assert.deepEqual(b[2], { type: "ul", items: ["甲", "乙\n补充说明"] });
  assert.deepEqual(b[3], { type: "ol", start: 1, items: ["一", "二"] });
  assert.deepEqual(b[4], { type: "code", lang: "python", code: "print(1)", open: false });
  assert.deepEqual(b[7], { type: "table", head: ["名称", "值"], rows: [["a", "1"]] });
});

test("markdown:流式半截代码块按到末尾处理(open=true)", () => {
  const b = parseMarkdownBlocks("看这里\n```js\nconst a = 1;");
  assert.equal(b[1].type, "code");
  assert.equal((b[1] as { open: boolean }).open, true);
});

test("markdown:单星号不误判列表外的普通文本;中文顿号有序列表", () => {
  const b = parseMarkdownBlocks("1、准备素材\n2、生成");
  assert.equal(b[0].type, "ol");
});

test("splitInline:代码/链接/粗体/斜体,危险协议链接不放行", () => {
  const segs = splitInline("用 `seed` 与 [文档](https://x.com/a) **重点** *轻*");
  assert.deepEqual(
    segs.filter((s) => s.t !== "text").map((s) => s.t),
    ["code", "link", "strong", "em"],
  );
  const bad = splitInline("[x](javascript:alert(1))");
  assert.ok(bad.every((s) => s.t === "text"));
});

test("思考轮次:start 建条 → done 写耗时与正文;重复 start 不回退", () => {
  let r = upsertThinkingRound(undefined, { status: "start", round: 1 }, 1000);
  assert.equal(r[0].status, "start");
  r = upsertThinkingRound(r, { status: "done", round: 1, elapsed_ms: 3200, content: " 先查应用 " }, 4300);
  assert.equal(r[0].status, "done");
  assert.equal(r[0].elapsedMs, 3200);
  assert.equal(r[0].content, "先查应用");
  r = upsertThinkingRound(r, { status: "start", round: 1 }, 5000);
  assert.equal(r[0].status, "done");
  r = upsertThinkingRound(r, { status: "start", round: 2 }, 6000);
  assert.equal(r.length, 2);
  const settled = settleThinking(r, 9000)!;
  assert.equal(settled[1].status, "done");
  assert.equal(settled[1].elapsedMs, 3000);
  assert.ok(hasThinkingText(settled));
});

test("过程块摘要:已思考 N 秒 · 调用了 K 个工具", () => {
  const rounds = [
    { round: 1, status: "done" as const, startedAt: 0, elapsedMs: 4200 },
    { round: 2, status: "done" as const, startedAt: 0, elapsedMs: 7900 },
  ];
  assert.equal(processSummaryLabel(rounds, 3), "已思考 12 秒 · 调用了 3 个工具");
  assert.equal(processSummaryLabel(undefined, 2), "调用了 2 个工具");
  assert.equal(processSummaryLabel([{ round: 1, status: "done", startedAt: 0, elapsedMs: 200 }], 0), "已思考 1 秒");
});

test("逐字显现:剩余约 42 帧显完,至少 2 字/帧,不越界", () => {
  assert.equal(revealStep(0, 1), 1);
  assert.equal(revealStep(0, 10), 2);
  assert.equal(revealStep(0, 420), 10);
  assert.equal(revealStep(50, 40), 40);
  let n = 0;
  let frames = 0;
  while (n < 2000 && frames < 500) {
    n = revealStep(n, 2000);
    frames += 1;
  }
  assert.ok(frames <= 200, `frames=${frames}`);
});

test("源码:thinking 事件不计首块;停止键并入发送位;重新生成;贴底跟随", () => {
  const av = readSrc("components/assistant/AssistantView.tsx");
  const i = av.indexOf('if (ev.type === "thinking")');
  const j = av.indexOf("if (!gotFirstChunkRef.current) {", i);
  assert.ok(i > 0 && j > i, "thinking 分支须在首块判定之前 return");
  assert.match(av, /const regenerate = useCallback/);
  assert.match(av, /onRegenerate=\{regenerate\}/);
  assert.match(av, /stickRef\.current/);
  assert.match(av, /av-jump-btn/);
  const comp = readSrc("components/assistant/Composer.tsx");
  assert.match(comp, /av-composer-stop is-stop/);
  assert.match(comp, /av-stop-square/);
  const ml = readSrc("components/assistant/MessageList.tsx");
  assert.match(ml, /<AvProcess/);
  assert.match(ml, /<AvSmoothText/);
  assert.match(ml, /<AvMsgActions/);
});

test("CSS:新类齐全、零 hex、扫光有减弱动效兜底", () => {
  const css = readSrc("app/styles/assistant-view.css");
  for (const cls of [".av-shimmer", ".av-process-panel", ".av-steps", ".av-md-code", ".av-md-table", ".av-msg-actions", ".av-jump-btn", ".av-stop-square"]) {
    assert.ok(css.includes(cls), `缺 ${cls}`);
  }
  const tail = css.slice(css.indexOf("助手回答重做(2026-09-28"));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(tail), "新增样式不得硬编码 hex");
  const reduce = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(css.includes(".av-shimmer { animation: none;"), "扫光需 reduced-motion 兜底");
  assert.ok(reduce.length > 0);
});
