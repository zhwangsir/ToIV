/**
 * A1 工具结果卡片单测(node:test + react-dom/server 静态渲染)——2026-09-22:
 * ① 注册表:七个工具名(六族卡,SelfhealCard 兼容双形态)全注册;未知工具/非对象 payload 回退 null
 * ② 六族卡字段齐全渲染(对照卡/知识条目/应用横条/模型 chips/画板卡/自愈诊断)
 * ③ 防御式解析:缺字段/类型错/垃圾 payload → 归 null(渲染点回退仅 chip,不炸消息流)
 * ④ AssistantView 源码断言:payload 穿线(接口/onEvent 条件展开)、渲染点条件
 *    (ok+payload+注册表)、chip 回退保留、ctx 三回调接线(setInput/market 深链/library 兜底)
 * ⑤ CSS 纪律(P-2b):零 hex、style jsx global、var(--*) token 全部存在于 globals.css
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi(imageUrl 恒等替身)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TOOL_RENDERERS,
  renderToolCard,
  type ToolCardCtx,
} from "../components/assistant/toolcards/registry";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const readSrc = (rel: string): string => readFileSync(join(webRoot, rel), "utf-8");

const h = React.createElement;

const TOOL_NAMES = [
  "optimize_prompt",
  "search_knowledge",
  "list_apps",
  "list_models",
  "create_storyboard",
  "list_smoke_failures",
  "explain_app_failure",
] as const;

const renderCard = (
  name: string,
  payload: Record<string, unknown>,
  ctx: ToolCardCtx = {},
): string =>
  renderToStaticMarkup(h(React.Fragment, null, renderToolCard(name, payload, ctx)));

/* ── ① 注册表 ── */
test("注册表:六族卡七个工具名全注册(title+render),未知工具/非对象 payload 回退 null", () => {
  for (const name of TOOL_NAMES) {
    const entry = TOOL_RENDERERS[name];
    assert.ok(entry, `缺注册 ${name}`);
    assert.ok(entry.title, `${name} 缺中文 title`);
    assert.equal(typeof entry.render, "function", `${name} render 非函数`);
  }
  assert.equal(renderToolCard("unknown_tool", { a: 1 }, {}), null, "未知工具未回退 null");
  assert.equal(
    renderToolCard("list_models", null as unknown as Record<string, unknown>, {}),
    null,
    "null payload 未回退",
  );
  assert.equal(
    renderToolCard("list_models", "x" as unknown as Record<string, unknown>, {}),
    null,
    "非对象 payload 未回退",
  );
});

/* ── ② 六族卡:字段齐全 ── */
test("OptimizePromptCard:原文⇄优化对照 + 负向区 + 应用到输入框(仅在有 onApplyInput 时)", () => {
  const html = renderCard(
    "optimize_prompt",
    { original: "cat doodle", optimized: "masterpiece cat, cinematic", negative: "lowres" },
    { onApplyInput: () => undefined },
  );
  assert.match(html, /av-tc-optimize/);
  assert.match(html, /原文/);
  assert.match(html, /优化后/);
  assert.match(html, /负向提示词/);
  assert.match(html, /cat doodle/);
  assert.match(html, /masterpiece cat, cinematic/);
  assert.match(html, /lowres/);
  assert.match(html, /应用到输入框/);
  // 无 onApplyInput → 按钮不渲染
  const bare = renderCard("optimize_prompt", { optimized: "masterpiece cat" });
  assert.doesNotMatch(bare, /应用到输入框/);
  assert.match(bare, /masterpiece cat/);
  assert.doesNotMatch(bare, /原文/, "缺 original 不应出原文栏");
});

test("KnowledgeCard:标题+摘要+知识库徽标;无标题条目以摘要兜底", () => {
  const html = renderCard("search_knowledge", {
    items: [
      { title: "画质词表", snippet: "masterpiece/best quality 的用法" },
      { snippet: "无标题条目也展示" },
    ],
  });
  assert.match(html, /画质词表/);
  assert.match(html, /masterpiece\/best quality 的用法/);
  assert.match(html, /知识库/);
  assert.match(html, /无标题条目也展示/);
});

test("AppListCard:封面/名称/用途/18+ 徽标/打开应用/共 N 个", () => {
  const html = renderCard(
    "list_apps",
    {
      items: [
        {
          id: "app1",
          name: "电商套图",
          description: "批量产出",
          cover_url: "cover/a.png",
          use_case: "电商",
          output_kind: "image",
          is_nsfw: true,
        },
        { id: "app2", name: "漫剧分镜", use_case: "漫剧" },
      ],
      total: 9,
    },
    { onOpenApp: () => undefined },
  );
  assert.match(html, /电商套图/);
  assert.match(html, /电商 · 批量产出/);
  assert.match(html, /18\+/);
  assert.match(html, /src="cover\/a\.png"/, "封面未走 imageUrl(mock 恒等)");
  assert.match(html, /漫剧分镜/);
  assert.match(html, /打开应用/);
  assert.match(html, /共 9 个应用/);
  // total 不大于展示数时不显示汇总
  const noTotal = renderCard("list_apps", {
    items: [{ id: "app1", name: "电商套图" }],
    total: 1,
  });
  assert.doesNotMatch(noTotal, /共 1 个应用/);
});

test("ModelsCard:模型名 chips 云", () => {
  const html = renderCard("list_models", {
    models: ["deepseek-v4-flash-dspark", "qwen3.8-27b"],
  });
  assert.match(html, /av-tc-chips/);
  assert.match(html, /deepseek-v4-flash-dspark/);
  assert.match(html, /qwen3\.8-27b/);
});

test("StoryboardCard:板名 + N 分镜行/M 角色 + 打开画板", () => {
  const html = renderCard(
    "create_storyboard",
    { board_id: "b1", name: "周末漫剧", item_count: 12, cast_count: 3 },
    { onOpenBoard: () => undefined },
  );
  assert.match(html, /周末漫剧/);
  assert.match(html, /12 分镜行 \/ 3 角色/);
  assert.match(html, /打开画板/);
  // 无 board_id → 不出按钮
  const noId = renderCard("create_storyboard", { name: "周末漫剧" }, { onOpenBoard: () => undefined });
  assert.match(noId, /周末漫剧/);
  assert.doesNotMatch(noId, /打开画板/);
});

test("SelfhealCard 形态 A(items):cls 徽标 + 建议 + 错误摘要", () => {
  const html = renderCard("list_smoke_failures", {
    items: [
      { id: "s1", name: "电商套图", cls: "workflow_broken", advice: "重挂模型", error: "KSampler 404" },
    ],
  });
  assert.match(html, /电商套图/);
  assert.match(html, /workflow_broken/);
  assert.match(html, /建议:重挂模型/);
  assert.match(html, /KSampler 404/);
});

test("SelfhealCard 形态 B(explain):诊断徽标 + 建议 + 提案列表 + 查看应用", () => {
  const html = renderCard(
    "explain_app_failure",
    {
      app_id: "app9",
      name: "电商套图",
      smoke_status: "fail",
      smoke_cls: "engine_offline",
      smoke_error: "ComfyUI 502",
      advice: "检查 LB 后端",
      proposals: [{ id: "p1", status: "open", failure_cls: "engine_offline", note: "切换备用后端" }],
    },
    { onOpenApp: () => undefined },
  );
  assert.match(html, /电商套图/);
  assert.match(html, /engine_offline/);
  assert.match(html, /建议:检查 LB 后端/);
  assert.match(html, /ComfyUI 502/);
  assert.match(html, /修复提案/);
  assert.match(html, /切换备用后端/);
  assert.match(html, /open/);
  assert.match(html, /查看应用/);
});

/* ── ③ 防御式解析:垃圾 payload → null(回退仅 chip) ── */
test("六族卡:关键字段缺失/类型错 → 归 null,绝不抛错", () => {
  const garbage: Record<string, unknown>[] = [
    {},
    { items: "not-array" },
    { items: [1, null, "x"] },
    { optimized: 42 },
    { models: { a: 1 } },
    { name: 7, board_id: [] },
    { proposals: "nope" },
  ];
  for (const name of TOOL_NAMES) {
    for (const g of garbage) {
      assert.equal(
        renderCard(name, g, { onApplyInput: () => undefined, onOpenApp: () => undefined, onOpenBoard: () => undefined }),
        "",
        `${name} 垃圾 payload 未归 null: ${JSON.stringify(g)}`,
      );
    }
  }
});

/* ── ④ AssistantView 源码断言 ── */
test("AssistantView:ToolChip 接口携带 payload;onEvent 条件展开透传", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  const iface = src.slice(
    src.indexOf("export interface ToolChip"),
    src.indexOf("export interface ToolChip") + 600,
  );
  assert.ok(iface.includes("payload?: Record<string, unknown>"), "ToolChip 缺 payload 字段");
  // onEvent tool 分支:条件展开(缺省不覆盖归并前值)
  assert.ok(
    src.includes("...(ev.payload ? { payload: ev.payload } : {})"),
    "tool 分支未条件展开透传 ev.payload",
  );
});

test("AssistantView:渲染点 ok+payload+注册表 追加卡片,chip 回退保留", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(
    src.includes('t.status === "ok" && t.payload && TOOL_RENDERERS[t.name]'),
    "渲染点缺 ok+payload+注册表 条件",
  );
  assert.ok(
    src.includes("renderToolCard(t.name, t.payload, toolCardCtx)"),
    "渲染点未走 renderToolCard",
  );
  // chip 三态/error detail 旧逻辑原样保留
  assert.ok(src.includes("av-tool-chip"), "chip 渲染丢失");
  assert.ok(src.includes('t.status === "error" && t.detail'), "error detail 展示丢失");
});

test("AssistantView:工具卡 ctx 三回调接线(setInput/market 深链/library 兜底)", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("const toolCardCtx = useMemo<ToolCardCtx>"), "缺 toolCardCtx");
  assert.ok(src.includes("setInput(text)"), "应用到输入框未接 setInput");
  assert.ok(src.includes("goView(`market?app=${appId}`)"), "打开应用未走 market?app= 深链");
  assert.ok(src.includes('goView("library")'), "打开画板未兜底 library");
});

/* ── ⑤ CSS 纪律(P-2b) ── */
test("cards.tsx:样式零 hex、style jsx global、token 全部存在于 globals.css", () => {
  const src = readSrc("components/assistant/toolcards/cards.tsx");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), "出现 hex 色值");
  assert.ok(src.includes("style jsx global"), "缺 style jsx global");
  const globals = readSrc("app/globals.css");
  const tokens = new Set(
    [...src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]),
  );
  assert.ok(tokens.size > 10, "token 提取异常(过少)");
  for (const tok of tokens) {
    assert.ok(globals.includes(`${tok}:`), `臆造 token ${tok}(globals.css 不存在)`);
  }
});
