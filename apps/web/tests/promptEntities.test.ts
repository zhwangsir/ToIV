/**
 * @主体引用前台化(P1,对标 Vidu Q3 @牛仔 @酒吧)单测(node:test):
 * ① lib/entities 纯函数:findActiveMention(@触发态)/filterEntities/parseMentions
 *    (最长名优先+首现去重)/resolveEntityIds/insertMention/removeMention
 * ② fetchEntities:/api/entities 主路径(EntityOut 映射+缩略图槽位序)
 *    + /api/assets 回退 + 双失败静默空数组
 * ③ PromptWithEntities/EntityRefsPreview 渲染:chip @名字(图N) + aria(combobox/listbox)
 * ④ 三处接线源码断言:PromptBar(GenerateView)/ImageEditView(qwenedit)/AssistantView
 * ⑤ submitEngineGeneration:H3 链路携带 entity_ids;空 ids 不带字段
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  entityKindLabel,
  fetchEntities,
  filterEntities,
  findActiveMention,
  insertMention,
  parseMentions,
  removeMention,
  resolveEntityIds,
  type EntityInfo,
} from "../lib/entities";
import { submitEngineGeneration, type EngineInfo } from "../lib/engines";
import { EntityRefsPreview, PromptWithEntities } from "../components/ui/PromptWithEntities";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");
const h = React.createElement;

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

const COWBOY: EntityInfo = {
  id: "e-cowboy",
  name: "牛仔",
  kind: "character",
  thumbUrl: "/api/entities/e-cowboy/images/front",
  imageCount: 2,
};
const BAR: EntityInfo = {
  id: "e-bar",
  name: "酒吧",
  kind: "scene",
  thumbUrl: "",
  imageCount: 1,
};
const HAT: EntityInfo = {
  id: "e-hat",
  name: "牛仔帽",
  kind: "prop",
  thumbUrl: "",
  imageCount: 1,
};
const ENTITIES = [COWBOY, BAR, HAT];

/* ── ① 纯函数:@ 触发探测 ── */
test("findActiveMention:光标紧贴 @词 时命中,空词=刚输入 @", () => {
  assert.deepEqual(findActiveMention("西部片的@", 5), { start: 4, query: "" });
  assert.deepEqual(findActiveMention("@牛", 2), { start: 0, query: "牛" });
  assert.deepEqual(findActiveMention("写 @牛仔 走进", 4), { start: 2, query: "牛" });
});

test("findActiveMention:非触发态(词后空格/光标在开头/无符号)", () => {
  assert.equal(findActiveMention("@牛仔 走进酒吧", 6), null); // 光标远离 @词(中间隔了空格)
  assert.equal(findActiveMention("@牛", 0), null); // 光标在 0
  assert.equal(findActiveMention("没有符号", 4), null);
  // 中文正文后直接跟 @ 也命中(不设前置空白守卫,与助手 @ 面板同语义)
  assert.deepEqual(findActiveMention("西部片的@牛", 6), { start: 4, query: "牛" });
});

test("filterEntities:大小写不敏感子串;空词全量", () => {
  assert.equal(filterEntities(ENTITIES, "").length, 3);
  assert.deepEqual(filterEntities(ENTITIES, "牛").map((e) => e.name), ["牛仔", "牛仔帽"]);
  assert.deepEqual(filterEntities(ENTITIES, "酒吧").map((e) => e.id), ["e-bar"]);
});

/* ── ① 纯函数:提及解析/插入/移除 ── */
test("parseMentions:首现顺序编号 + 最长名优先 + 同实体去重", () => {
  const ms = parseMentions("@牛仔 和 @酒吧 里的 @牛仔帽,@牛仔 再登场", ENTITIES);
  assert.deepEqual(ms.map((m) => m.entity.id), ["e-cowboy", "e-bar", "e-hat"]);
  // 最长名优先:@牛仔帽 不被 @牛仔 截胡
  assert.equal(ms[2].entity.name, "牛仔帽");
  // 同实体二次提及不重复编号(正典:每张图片只编号一次)
  assert.equal(ms.filter((m) => m.entity.id === "e-cowboy").length, 1);
  // start/end 定位准确
  assert.equal("@牛仔 和 @酒吧".slice(ms[1].start, ms[1].end), "@酒吧");
});

test("parseMentions:无 @ 或实体库为空 → 空数组(纯文本零影响)", () => {
  assert.deepEqual(parseMentions("普通提示词", ENTITIES), []);
  assert.deepEqual(parseMentions("@牛仔", []), []);
});

test("resolveEntityIds:按提及首现序输出 id(与后端 @图片N 绑定对应)", () => {
  assert.deepEqual(resolveEntityIds("@酒吧 里的 @牛仔", ENTITIES), ["e-bar", "e-cowboy"]);
  assert.deepEqual(resolveEntityIds("没有引用", ENTITIES), []);
});

test("insertMention:替换 @触发词 为 `@名字 ` 并给出新光标位", () => {
  const r = insertMention("写 @牛 走进", { start: 2, query: "牛" }, COWBOY, 4);
  assert.equal(r.text, "写 @牛仔  走进");
  assert.equal(r.text.slice(0, r.caret), "写 @牛仔 ");
});

test("removeMention:删除引用并吸收一个相邻空格", () => {
  const ms = parseMentions("@牛仔 @酒吧 场景", ENTITIES);
  assert.equal(removeMention("@牛仔 @酒吧 场景", ms[0]), "@酒吧 场景");
  assert.equal(removeMention("@牛仔 @酒吧 场景", ms[1]), "@牛仔 场景");
});

test("entityKindLabel:已知 kind 中文短名,未知兜底「主体」", () => {
  assert.equal(entityKindLabel("character"), "角色");
  assert.equal(entityKindLabel("scene"), "场景");
  assert.equal(entityKindLabel("prop"), "道具");
  assert.equal(entityKindLabel("unknown"), "主体");
});

/* ── ② fetchEntities:主路径/回退/静默 ── */
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

function stubWindow(): void {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k === "toiv_token" ? "tok-test" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
}

beforeEach(() => {
  stubWindow();
});

test("fetchEntities:/api/entities 主路径,EntityOut 映射 + 缩略图槽位优先级", async () => {
  let called = "";
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    called = String(input);
    return new Response(
      JSON.stringify([
        {
          id: "e1",
          kind: "character",
          name: "牛仔",
          description: "主角",
          image_urls: { ref: "/api/entities/e1/images/ref", front: "/api/entities/e1/images/front" },
        },
        { id: "e2", kind: "scene", name: "酒吧", image_urls: {} },
        { id: "e3", kind: "prop", name: "", image_urls: {} }, // 无名剔除
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const rows = await fetchEntities();
    assert.ok(called.endsWith("/api/entities"));
    assert.equal(rows.length, 2);
    // 槽位序:front 优先于 ref(与后端 best_image_value 同序)
    assert.equal(rows[0].thumbUrl, "/api/entities/e1/images/front");
    assert.equal(rows[0].imageCount, 2);
    assert.equal(rows[1].thumbUrl, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchEntities:entities 未就绪(404)回退 /api/assets;双失败静默空数组", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const u = String(input);
    urls.push(u);
    if (u.endsWith("/api/entities")) return new Response("nf", { status: 404 });
    if (u.endsWith("/api/assets")) {
      return new Response(
        JSON.stringify([
          { id: "a1", kind: "character", name: "旧资产", images: [{ filename: "f.png", worker: "w" }] },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("x", { status: 500 });
  }) as typeof fetch;
  try {
    const rows = await fetchEntities();
    assert.deepEqual(urls.map((u) => u.slice(u.lastIndexOf("/api/"))), ["/api/entities", "/api/assets"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].thumbUrl, "/api/assets/a1/images/0");
  } finally {
    globalThis.fetch = realFetch;
  }
  // 双失败 → 空数组(不抛错,@ 功能隐身)
  globalThis.fetch = (async (): Promise<Response> => new Response("x", { status: 500 })) as typeof fetch;
  try {
    assert.deepEqual(await fetchEntities(), []);
  } finally {
    globalThis.fetch = realFetch;
    (globalThis as { window?: unknown }).window = realWindow;
  }
});

/* ── ③ 组件渲染:chip 预览 + aria ── */
test("PromptWithEntities:渲染 combobox textarea + 已引用主体 chip(@名字 图N)", () => {
  const html = renderToStaticMarkup(
    h(PromptWithEntities, {
      value: "@牛仔 走进 @酒吧",
      onChange: () => undefined,
      entities: ENTITIES,
      ariaLabel: "提示词",
      className: "promptbar-textarea",
    }),
  );
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-autocomplete="list"/);
  assert.match(html, /aria-label="提示词"/);
  // 预览行:两枚 chip,图N 按首现序
  assert.match(html, /已引用主体:/);
  assert.match(html, /@牛仔/);
  assert.match(html, /@酒吧/);
  assert.ok(html.indexOf("@牛仔") < html.indexOf("@酒吧"), "chip 顺序 = 首现序");
  assert.match(html, /图1/);
  assert.match(html, /图2/);
  assert.match(html, /aria-label="移除引用 牛仔"/);
  assert.match(html, /查看绑定详情/);
});

test("PromptWithEntities:无提及时预览行不渲染(纯文本零影响)", () => {
  const html = renderToStaticMarkup(
    h(PromptWithEntities, { value: "普通提示词", onChange: () => undefined, entities: ENTITIES }),
  );
  assert.ok(!html.includes("已引用主体"));
});

test("EntityRefsPreview:chip 可独立复用(助手输入框路径)", () => {
  const html = renderToStaticMarkup(
    h(EntityRefsPreview, { value: "@酒吧 里 @牛仔 对坐", entities: ENTITIES, onChange: () => undefined }),
  );
  assert.match(html, /pwe-refs/);
  assert.match(html, /aria-label="已引用主体"/);
  assert.ok(html.indexOf("@酒吧") < html.indexOf("@牛仔"));
  assert.match(html, /aria-label="酒吧\(图1\),查看绑定详情"/);
});

test("PromptWithEntities:@ 选择器键盘导航与 aria 约定(源码断言)", () => {
  const src = readSrc("components/ui/PromptWithEntities.tsx");
  for (const key of ['"ArrowDown"', '"ArrowUp"', '"Enter"', '"Tab"', '"Escape"']) {
    assert.ok(src.includes(key), `缺按键处理 ${key}`);
  }
  assert.ok(src.includes('role="listbox"'), "缺 listbox");
  assert.ok(src.includes('role="option"'), "缺 option");
  assert.ok(src.includes("aria-activedescendant"), "缺 aria-activedescendant");
  assert.ok(src.includes("aria-selected"), "缺 aria-selected");
});

/* ── ④ 三处接线(源码断言) ── */
test("PromptBar(GenerateView 视频生成 prompt):textarea 换为 PromptWithEntities", () => {
  const src = readSrc("components/generate/PromptBar.tsx");
  assert.ok(src.includes('from "@/components/ui/PromptWithEntities"'), "未引入组件");
  assert.ok(src.includes("<PromptWithEntities"), "未渲染组件");
  assert.ok(src.includes("promptbar-textarea"), "宿主类名丢失(玻璃条样式)");
  // ⌘/Ctrl+Enter 快速生成经 onKeyDown 透传保留
  assert.ok(src.includes("onKeyDown"), "onKeyDown 透传丢失");
});

test("GenerateView:提交时 resolveEntityIds → submitEngineGeneration entityIds", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes('from "@/lib/entities"'), "未引入 entities lib");
  assert.ok(src.includes("useEntities()"), "未共享主体清单");
  assert.ok(src.includes("resolveEntityIds(promptText, subjectEntities)"), "提交未解析 @提及 entity_ids");
  assert.ok(src.includes("entityIds,"), "submitEngineGeneration 未传 entityIds");
});

test("engines.ts:EngineSubmitInput.entityIds + H3 四案携带 entity_ids,空则不携带", () => {
  const src = readSrc("lib/engines.ts");
  assert.ok(src.includes("entityIds?: string[]"), "EngineSubmitInput 缺 entityIds");
  assert.ok(src.includes("entity_ids: entityIds"), "负载缺 entity_ids 字段");
  const h3t2v = src.slice(src.indexOf('case "h3-t2v"'), src.indexOf('case "longcat-t2v"'));
  assert.ok(h3t2v.includes("_entityIdsPayload(entityIds)"), "h3-t2v 未携带");
  const h3i2v = src.slice(src.indexOf('case "h3-i2v"'), src.indexOf('case "wan-nsfw-i2v"'));
  assert.ok(h3i2v.includes("_entityIdsPayload(entityIds)"), "h3-i2v 未携带");
  // 空数组 → 不带字段(后端行为不变)
  assert.ok(src.includes("entityIds && entityIds.length > 0 ? { entity_ids: entityIds } : {}"), "空 ids 未短路");
});

test("ImageEditView:qwenedit 编辑指令接 PromptWithEntities + entity_ids 上送", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes("<PromptWithEntities"), "编辑指令未换组件");
  assert.ok(src.includes("entityIds: resolveEntityIds(qwenPositive, subjectEntities)"), "qwenedit 未解析 entity_ids");
  const api = readSrc("lib/api.ts");
  assert.ok(api.includes("entityIds?: string[]"), "QwenEditParams 缺 entityIds");
  assert.ok(api.includes("{ entity_ids: params.entityIds }"), "generateQwenEdit 未透传 entity_ids");
});

test("AssistantView:@ 面板并入「主体」分组 + chip 预览 + 发送携带 entity_ids", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes('from "@/lib/entities"'), "未引入 entities lib");
  assert.ok(src.includes("onPickEntity"), "缺主体选定回调");
  assert.ok(src.includes(">主体</span>"), "@ 面板缺主体分组");
  assert.ok(src.includes("EntityRefsPreview"), "缺 chip 预览");
  assert.ok(src.includes("resolveEntityIds(text, subjectEntities)"), "发送未解析 entity_ids");
  assert.ok(src.includes("{ entity_ids: entityIds }"), "agentChatStream 未携带 entity_ids");
  const api = readSrc("lib/api.ts");
  assert.ok(api.includes("entity_ids?: string[]"), "AgentChatStreamBody 缺 entity_ids");
});

/* ── ⑤ submitEngineGeneration:H3 链路 entity_ids 契约 ── */
interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}
let fetchCalls: FetchCall[] = [];

function h3Engine(): EngineInfo {
  return {
    id: "h3-t2v",
    label: "MiniMax H3",
    kind: "video",
    available: true,
    nsfw: false,
    params: [
      { key: "negative", label: "负向", type: "textarea", default: "" },
      { key: "width", label: "宽", type: "number", default: 1344 },
      { key: "height", label: "高", type: "number", default: 768 },
    ],
  };
}

beforeEach(() => {
  fetchCalls = [];
  stubWindow();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
    });
    return new Response(
      JSON.stringify({ prompt_id: "p1", client_id: "c1", worker: "http://w", seed: 7 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

test("submitEngineGeneration:h3-t2v 携带 entity_ids(提及首现序);空 ids 不带字段", async () => {
  await submitEngineGeneration({
    engine: h3Engine(),
    positive: "@牛仔 走进 @酒吧",
    values: {},
    entityIds: ["e-cowboy", "e-bar"],
  });
  assert.ok(fetchCalls[0].url.endsWith("/api/h3/t2v"));
  assert.deepEqual(fetchCalls[0].body.entity_ids, ["e-cowboy", "e-bar"]);

  fetchCalls = [];
  await submitEngineGeneration({ engine: h3Engine(), positive: "无引用", values: {}, entityIds: [] });
  assert.ok(!("entity_ids" in fetchCalls[0].body), "空 ids 不应携带 entity_ids 字段");

  fetchCalls = [];
  await submitEngineGeneration({ engine: h3Engine(), positive: "无引用", values: {} });
  assert.ok(!("entity_ids" in fetchCalls[0].body), "未给 ids 不应携带 entity_ids 字段");
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});
