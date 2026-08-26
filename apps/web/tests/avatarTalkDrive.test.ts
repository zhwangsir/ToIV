/**
 * 数字人前端:形象库(avatar 资产模板)+ TTS 直通(drive_text)单测(node:test + fetch 桩):
 * ① buildAvatarTalkPayload 音频模式:字段与历史完全一致(无 drive_text/voice/speed)
 * ② 文本模式:drive_text/voice/speed 三字段,无 audio;trim 与语速夹取生效
 * ③ clampSpeed / driveTextReady 边界
 * ④ listAvatarAssets:GET /api/assets?kind=avatar 带鉴权,数组直返
 * ⑤ createAvatarAsset:POST /api/assets,载荷 {kind:"avatar",green_screen:false,...}
 * ⑥ AvatarGenPanel 源码断言:形象模板区(列表/选中填充/存为模板/空态引导/绿幕标记)、
 *    驱动源段控互斥(上传音频|文本驱动)、文本输入 2000 字上限与语速滑块
 * 回归锚点:此前形象图只能每次重传、驱动源只有上传音频一路。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";

import {
  buildAvatarTalkPayload,
  clampSpeed,
  driveTextReady,
  DRIVE_TEXT_MAX,
  SPEED_DEFAULT,
  type AvatarTalkBaseArgs,
} from "../lib/avatarTalk";
import { createAvatarAsset, listAvatarAssets } from "../lib/api";

const testDir = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(testDir, "..", rel), "utf8");
}

const BASE: AvatarTalkBaseArgs = {
  image: "face.png",
  worker: "http://pool1",
  positive: "  数字人开场白  ",
  negative: "",
  width: 480,
  height: 832,
  duration_sec: 3.7,
  fps: 25,
  steps: 12,
  shift: 12,
  cfg: 1.0,
  dmd_lora_strength: 1.0,
  seed: null,
};

// ── ①② payload 构建:音频/文本两路互斥 ──

test("① 音频模式:字段与历史完全一致,不带 drive_text/voice/speed", () => {
  const p = buildAvatarTalkPayload(BASE, { mode: "audio", audio: "voice.wav" });
  assert.equal(p.image, "face.png");
  assert.equal(p.audio, "voice.wav");
  assert.equal(p.worker, "http://pool1");
  assert.equal(p.positive, "数字人开场白", "positive 去首尾空白");
  assert.equal(p.duration_sec, 3.7);
  assert.equal(p.fps, 25);
  assert.equal(p.steps, 12);
  assert.equal(p.seed, null);
  assert.equal("negative" in p, false, "空负向不携带(与历史一致)");
  assert.equal("drive_text" in p, false);
  assert.equal("voice" in p, false);
  assert.equal("speed" in p, false);
});

test("② 文本模式:drive_text/voice/speed 三字段,无 audio;trim 与语速夹取", () => {
  const p = buildAvatarTalkPayload(BASE, {
    mode: "text",
    driveText: "  大家好,我是数字人。 ",
    voice: "  https://ref/voice.wav  ",
    speed: 1.6,
  });
  assert.equal("audio" in p, false, "文本模式不得携带 audio(后端互斥 400)");
  assert.equal(p.drive_text, "大家好,我是数字人。");
  assert.equal(p.voice, "https://ref/voice.wav");
  assert.equal(p.speed, 1.6);
  // 默认音色:空字符串原样透传(后端空=默认音色)
  const def = buildAvatarTalkPayload(BASE, { mode: "text", driveText: "hi", voice: "", speed: 1 });
  assert.equal(def.voice, "");
  assert.equal(def.speed, 1);
  // 语速越界夹取
  const clamped = buildAvatarTalkPayload(BASE, { mode: "text", driveText: "hi", voice: "", speed: 9 });
  assert.equal(clamped.speed, 2.0);
});

test("③ clampSpeed / driveTextReady 边界", () => {
  assert.equal(clampSpeed(0.1), 0.5);
  assert.equal(clampSpeed(3), 2.0);
  assert.equal(clampSpeed(Number.NaN), SPEED_DEFAULT);
  assert.equal(clampSpeed(1.03), 1.05, "0.05 粒度吸附");
  assert.equal(driveTextReady("你好"), true);
  assert.equal(driveTextReady("   "), false, "全空白不可提交");
  assert.equal(driveTextReady("x".repeat(DRIVE_TEXT_MAX)), true);
  assert.equal(driveTextReady("x".repeat(DRIVE_TEXT_MAX + 1)), false, "超 2000 字拒绝");
});

// ── ④⑤ 形象模板资产 API(fetch 桩)──

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
    const payload = String(input).includes("kind=avatar")
      ? [
          {
            id: "a1",
            kind: "avatar",
            name: "小雅",
            description: "",
            images: [{ filename: "face.png", worker: "http://pool1" }],
            nsfw: false,
            green_screen: false,
            ref_audio: "",
            created_at: "",
            updated_at: "",
          },
        ]
      : { id: "a2", kind: "avatar", name: "新模板" };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

test("④ listAvatarAssets:GET /api/assets?kind=avatar 带 Bearer,数组直返", async () => {
  const list = await listAvatarAssets();
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes("/api/assets?kind=avatar"), "路由须带 kind=avatar 过滤");
  assert.equal(fetchCalls[0].method, "GET");
  assert.equal(fetchCalls[0].headers.Authorization, "Bearer tok-test");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "a1");
  assert.equal(list[0].images[0].filename, "face.png");
  assert.equal(list[0].green_screen, false);
});

test("⑤ createAvatarAsset:POST /api/assets,kind=avatar 且默认 green_screen=false", async () => {
  await createAvatarAsset({
    name: "新模板",
    images: [{ filename: "face.png", worker: "http://pool1" }],
  });
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes("/api/assets"));
  assert.equal(fetchCalls[0].method, "POST");
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.kind, "avatar");
  assert.equal(body.name, "新模板");
  assert.equal(body.green_screen, false, "默认非绿幕");
  assert.deepEqual(body.images, [{ filename: "face.png", worker: "http://pool1" }]);
  assert.equal(fetchCalls[0].headers.Authorization, "Bearer tok-test");
});

// ── ⑥ 组件接线(源码断言)──

test("⑥ AvatarGenPanel:形象模板区 + 驱动源段控互斥 + 文本模式字段接线", () => {
  const src = readSrc("components/avatartalk/AvatarGenPanel.tsx");
  // 形象模板区:拉取/选中填充/存为模板/空态引导/绿幕标记
  assert.ok(src.includes("形象模板"), "缺形象模板区标题");
  assert.ok(src.includes("listAvatarAssets()"), "未拉取 /api/assets?kind=avatar");
  assert.ok(src.includes("applyTemplate(t)"), "模板卡未接选中填充");
  assert.ok(src.includes("avatarAssetImageUrl(t.id, 0)"), "模板缩略图未走资产图回显端点");
  assert.ok(src.includes("createAvatarAsset({"), "存为模板未调创建接口");
  assert.ok(src.includes("存为模板"), "缺「存为模板」按钮");
  assert.ok(src.includes("green_screen: false"), "存为模板默认 green_screen=false");
  assert.ok(src.includes("绿幕"), "模板卡缺绿幕标记");
  assert.ok(src.includes("暂无形象模板"), "缺空列表引导文案");
  // 驱动源段控:上传音频 | 文本驱动(互斥由 UI 保证)
  assert.ok(src.includes('"上传音频"') || src.includes("上传音频"), "缺上传音频选项");
  assert.ok(src.includes("文本驱动"), "缺文本驱动选项");
  assert.ok(src.includes('aria-label="驱动源"'), "驱动源段控缺可访问名");
  assert.ok(src.includes("driveMode === \"audio\""), "缺模式条件渲染");
  // 文本模式输入:≤2000 字 + 语速滑块 + 音色可选
  assert.ok(src.includes("maxLength={DRIVE_TEXT_MAX}"), "驱动文本缺 2000 字上限");
  assert.ok(src.includes('type="range"'), "语速缺滑块");
  assert.ok(src.includes("音色(可选)"), "缺音色可选输入");
  // 提交:两路经 buildAvatarTalkPayload 分流(音频字段不变/文本带 drive_text)
  assert.ok(src.includes('mode: "audio"'), "音频模式未走 audio 分支");
  assert.ok(src.includes('mode: "text"'), "文本模式未走 text 分支");
  assert.ok(src.includes("buildAvatarTalkPayload("), "提交未统一走 payload 构建器");
});
