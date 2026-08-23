/**
 * avatar-talk(LongCat-Avatar 数字人)统一工作台提交链路单测(node:test + fetch 桩):
 * ① submitEngineGeneration 路由到 POST /api/avatar/talk,载荷对齐 AvatarGenPanel
 *    参照实现(image/audio/worker/positive + 秒数直传 duration_sec,无 num_frames)
 * ② 缺参考图/驱动音频 → 提交前拦截报错(后端契约两者必填且同 worker)
 * ③ 注册表归一:后端把「驱动音频」声明为 text 类型(仅 hint),fetchEngines /
 *    refreshEngines 归一为 audio 类型,GenerateView 才渲染 RefAudioUpload
 * 回归锚点:此前 submitEngineGeneration 无 avatar-talk 分支,统一工作台选该引擎
 * 提交必抛「尚未接入提交链路」(断链)。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  engineNeedsAudio,
  fetchEngines,
  refreshEngines,
  submitEngineGeneration,
  type EngineInfo,
  type EngineParam,
} from "../lib/engines";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** 与后端 engine_registry._avatar_talk_params() 同形(text 类型的 audio 参数)。 */
const AVATAR_TALK_PARAMS: EngineParam[] = [
  { key: "images", label: "人像首帧", type: "images", default: null },
  { key: "audio", label: "驱动音频", type: "text", default: "", hint: "wav / mp3,经 /api/upload 上传" },
  { key: "width", label: "宽度", type: "number", default: 480 },
  { key: "height", label: "高度", type: "number", default: 832 },
  { key: "duration", label: "时长(秒)", type: "number", default: 3.7 },
  { key: "fps", label: "帧率", type: "number", default: 25 },
  { key: "steps", label: "采样步数", type: "number", default: 12 },
  { key: "seed", label: "随机种子", type: "text", default: "" },
];

function avatarEngine(over?: Partial<EngineInfo>): EngineInfo {
  return {
    id: "avatar-talk",
    label: "LongCat-Avatar 数字人",
    kind: "video",
    available: true,
    nsfw: false,
    params: AVATAR_TALK_PARAMS,
    ...over,
  };
}

/** 归一后的引擎形态(fetchEngines 输出,GenerateView 实际拿到并传给 submit 的形态)。 */
function normalizedAvatarEngine(): EngineInfo {
  return avatarEngine({
    params: AVATAR_TALK_PARAMS.map((p) =>
      p.key === "audio" ? { ...p, type: "audio" as const, max: 1 } : p,
    ),
  });
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
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    const payload = String(input).includes("/api/models/engines")
      ? { engines: [avatarEngine()] }
      : { prompt_id: "p1", client_id: "c1", worker: "http://w", seed: 7 };
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

test("① avatar-talk 提交:路由 /api/avatar/talk,载荷含 image/audio/worker,秒数直传 duration_sec", async () => {
  await submitEngineGeneration({
    engine: normalizedAvatarEngine(),
    positive: "数字人开场白",
    values: { width: "480", height: "832", duration: "6.5", fps: "25", steps: "12", seed: "" },
    refImage: { filename: "face.png", worker: "http://pool1" },
    refAudio: { filename: "voice.wav", worker: "http://pool1" },
  });
  assert.equal(fetchCalls.length, 1, "仅一次提交请求");
  assert.ok(fetchCalls[0].url.endsWith("/api/avatar/talk"), "路由必须为 /api/avatar/talk");
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.image, "face.png");
  assert.equal(body.audio, "voice.wav");
  assert.equal(body.worker, "http://pool1", "worker 取参考图落点(上传时已互钉)");
  assert.equal(body.positive, "数字人开场白");
  assert.equal(body.duration_sec, 6.5, "时长秒数直传(后端统一策略层换算帧数)");
  assert.equal(body.fps, 25);
  assert.equal(body.steps, 12);
  assert.equal("num_frames" in body, false, "不得携带 num_frames");
});

test("② 缺参考图/驱动音频:提交前拦截,不发请求", async () => {
  await assert.rejects(
    submitEngineGeneration({
      engine: normalizedAvatarEngine(),
      positive: "x",
      values: {},
      refAudio: { filename: "voice.wav", worker: "http://pool1" },
    }),
    /请先上传参考图/,
  );
  await assert.rejects(
    submitEngineGeneration({
      engine: normalizedAvatarEngine(),
      positive: "x",
      values: {},
      refImage: { filename: "face.png", worker: "http://pool1" },
    }),
    /请先上传驱动音频/,
  );
  assert.equal(fetchCalls.length, 0, "拦截期不得发出提交请求");
});

test("③ 注册表归一:text 类型 audio 参数 → audio 类型(fetchEngines 与 refreshEngines 同口径)", async () => {
  const list = await fetchEngines();
  const eng = list.find((e) => e.id === "avatar-talk");
  assert.ok(eng, "注册表应含 avatar-talk 引擎");
  const audioParam = engineNeedsAudio(eng!);
  assert.ok(audioParam, "归一后 audio 参数应被识别为上传型(engineNeedsAudio)");
  assert.equal(audioParam!.key, "audio");
  assert.equal(audioParam!.hint, "wav / mp3,经 /api/upload 上传", "归一只改类型,hint 保留");

  // 其它引擎不受影响(text 参数原样保留)
  const raw = avatarEngine().params.find((p) => p.key === "audio");
  assert.equal(raw!.type, "text", "测试夹具未归一(对照)");

  const refreshed = await refreshEngines();
  assert.ok(engineNeedsAudio(refreshed.find((e) => e.id === "avatar-talk")!), "refresh 同口径归一");
});
