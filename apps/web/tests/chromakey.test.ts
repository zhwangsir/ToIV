/**
 * 绿幕合成前端(数字人 M6)单测(node:test + fetch 桩 + 源码断言):
 * ① buildChromakeyPayload 默认值:key_color=0x00FF00 / similarity=0.18 / blend=0.08
 * ② 背景互斥:color 模式只带 background_color;image 模式只带 background_url
 * ③ clamp01 / workerViewUrl(worker /view 直链,后端白名单认 worker host)
 * ④ chromakeyCompose:POST /api/video/chromakey 带 Bearer 与长任务超时,返回 {job_id,url,kind}
 * ⑤ AvatarGenPanel 折叠区源码断言:渲染条件(有产物才出现)、字段接线、结果播放器 url
 * 契约锚点:apps/api/app/routes/chromakey.py(产物 GET /api/video/chromakey/output/{name})。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";

import {
  BLEND_DEFAULT,
  KEY_COLOR_DEFAULT,
  SIMILARITY_DEFAULT,
  buildChromakeyPayload,
  chromakeyCompose,
  clamp01,
  workerViewUrl,
} from "../lib/chromakey";

const testDir = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(testDir, "..", rel), "utf8");
}

// ── ①② 载荷构建 ──

test("① 默认值:key_color=0x00FF00、similarity=0.18、blend=0.08", () => {
  const p = buildChromakeyPayload({
    foreground_url: "/api/images?filename=fg.mp4&sig=x",
    background: { mode: "color", color: "black" },
  });
  assert.equal(p.key_color, KEY_COLOR_DEFAULT);
  assert.equal(p.similarity, SIMILARITY_DEFAULT);
  assert.equal(p.blend, BLEND_DEFAULT);
  assert.equal(SIMILARITY_DEFAULT, 0.18);
  assert.equal(BLEND_DEFAULT, 0.08);
});

test("② 背景互斥:color 无 background_url;image 无 background_color", () => {
  const color = buildChromakeyPayload({
    foreground_url: "/api/images?filename=fg.mp4&sig=x",
    background: { mode: "color", color: "0xFFFFFF" },
    key_color: "0x00FF00",
    similarity: 0.3,
    blend: 0.1,
  });
  assert.equal(color.background_type, "color");
  assert.equal(color.background_color, "0xFFFFFF");
  assert.equal("background_url" in color, false, "color 模式不得携带 background_url");
  assert.equal(color.foreground_url, "/api/images?filename=fg.mp4&sig=x");

  const image = buildChromakeyPayload({
    foreground_url: "/api/images?filename=fg.mp4&sig=x",
    background: { mode: "image", url: "http://pool1/view?filename=bg.png&type=input" },
  });
  assert.equal(image.background_type, "image");
  assert.equal(image.background_url, "http://pool1/view?filename=bg.png&type=input");
  assert.equal("background_color" in image, false, "image 模式不得携带 background_color");

  // 空色兜底 black(后端默认)
  const empty = buildChromakeyPayload({
    foreground_url: "x",
    background: { mode: "color", color: "  " },
  });
  assert.equal(empty.background_color, "black");
});

// ── ③ 纯函数 ──

test("③ clamp01 夹取与 workerViewUrl 直链", () => {
  assert.equal(clamp01(0.5, 0.18), 0.5);
  assert.equal(clamp01(2, 0.18), 1);
  assert.equal(clamp01(-1, 0.18), 0);
  assert.equal(clamp01(Number.NaN, 0.18), 0.18);
  assert.equal(clamp01(0.456, 0.18), 0.46, "0.01 粒度");

  assert.equal(
    workerViewUrl({ filename: "bg 图.png", worker: "http://pool1/" }),
    "http://pool1/view?filename=bg%20%E5%9B%BE.png&type=input",
    "worker 尾斜线归一 + filename 编码 + type=input",
  );
});

// ── ④ API(fetch 桩) ──

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  fetchCalls = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k === "toiv_token" ? "tok-test" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response(
      JSON.stringify({
        job_id: "j1",
        url: "/api/video/chromakey/output/chromakey-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4",
        kind: "chromakey",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

test("④ chromakeyCompose:POST /api/video/chromakey 带 Bearer,返回 {job_id,url,kind}", async () => {
  const r = await chromakeyCompose({
    foreground_url: "/api/images?filename=fg.mp4&sig=x",
    background: { mode: "color", color: "black" },
    key_color: "0x00FF00",
    similarity: 0.18,
    blend: 0.08,
  });
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes("/api/video/chromakey"));
  assert.equal(fetchCalls[0].method, "POST");
  assert.equal(fetchCalls[0].headers.Authorization, "Bearer tok-test");
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.foreground_url, "/api/images?filename=fg.mp4&sig=x");
  assert.equal(body.background_type, "color");
  assert.equal(body.background_color, "black");
  assert.equal(body.key_color, "0x00FF00");
  assert.equal(r.url, "/api/video/chromakey/output/chromakey-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4");
  assert.equal(r.kind, "chromakey");
  assert.equal(r.job_id, "j1");
});

// ── ⑤ 组件接线(源码断言) ──

test("⑤ AvatarGenPanel:折叠区渲染条件 + 字段接线 + 结果播放器", () => {
  const src = readSrc("components/avatartalk/AvatarGenPanel.tsx");
  // 渲染条件:有产物视频(gen done + resultPaths)才出现
  assert.ok(src.includes('gen.status === "done" && gen.resultPaths.length > 0'), "折叠区未挂在产物条件上");
  assert.ok(src.includes("{resultUrl && ("), "折叠区未按 resultUrl 条件渲染");
  assert.ok(src.includes("绿幕合成"), "缺折叠区标题");
  assert.ok(src.includes("aria-expanded={ckOpen}"), "折叠头缺展开语义");
  // 绿幕形象模板:默认展开 + 提示
  assert.ok(src.includes("green_screen ?? false"), "未按模板绿幕标记判定");
  assert.ok(src.includes("if (greenTpl) setCkOpen(true)"), "绿幕形象未默认展开");
  assert.ok(src.includes("绿幕形象,可直接合成"), "缺绿幕形象提示");
  // 背景类型:纯色(black/white/自定义 hex)| 上传背景图
  assert.ok(src.includes('{ key: "color", label: "纯色" }'), "缺纯色背景选项");
  assert.ok(src.includes('{ key: "image", label: "背景图" }'), "缺背景图选项");
  assert.ok(src.includes('{ key: "black", label: "黑色" }') && src.includes('{ key: "white", label: "白色" }'), "缺黑/白预设");
  assert.ok(src.includes('type="color"'), "自定义背景色缺取色器");
  assert.ok(src.includes("onCkBgFile"), "背景图未接上传");
  assert.ok(src.includes("workerViewUrl(ckBgImage!)"), "背景图未转 worker /view 直链");
  // key_color 默认 + similarity/blend 滑块默认 0.18/0.08
  assert.ok(src.includes("useState(KEY_COLOR_DEFAULT)"), "key_color 未用默认 0x00FF00");
  assert.ok(src.includes("useState(SIMILARITY_DEFAULT)"), "similarity 未用默认 0.18");
  assert.ok(src.includes("useState(BLEND_DEFAULT)"), "blend 未用默认 0.08");
  assert.ok((src.match(/type="range"/g) ?? []).length >= 3, "similarity/blend 缺滑块");
  // 提交:foreground_url 即产物相对路径(签名 URL,后端白名单认)
  assert.ok(src.includes("foreground_url: resultUrl"), "提交未带产物 URL");
  assert.ok(src.includes("chromakeyCompose({"), "未走 chromakeyCompose 封装");
  // 结果播放器:url 即产物地址(经 imageUrl 带 token)
  assert.ok(src.includes("ckResultUrl && ("), "结果播放器缺条件渲染");
  assert.ok(src.includes("src={imageUrl(ckResultUrl)}"), "结果播放器未播产物 url");
});
