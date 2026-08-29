/**
 * wan-nsfw-i2v(Wan2.2 I2V R18,Civitai 爆款配方复刻)web 侧单测(node:test + fetch 桩):
 * ① 提交链路由到 /api/generate/video,参考图 filename/worker 互钉透传;
 * ② duration 秒 → 4n+1 帧就近吸附(3s→49 / 5s→81 / 7.5s→121 上限),固定 16fps;
 * ③ resolution 预设换算宽高;loras(name+strength)与 full_quality 透传;
 * ④ 未选 LoRA → 省略 loras 字段(后端 AI 选配)。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { submitEngineGeneration, type EngineInfo } from "../lib/engines";

interface FetchCall {
  url: string;
  method: string;
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
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response(
      JSON.stringify({ prompt_id: "p1", client_id: "c1", worker: "http://w", seed: 7 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

function _engine(): EngineInfo {
  return {
    id: "wan-nsfw-i2v",
    label: "Wan2.2 图生视频(R18)",
    kind: "video",
    available: true,
    nsfw: true,
    params: [
      { key: "images", label: "参考图", type: "images", max: 1, default: null },
    ],
  };
}

test("wan-nsfw-i2v payload:路由 /api/generate/video,图/worker 互钉,5s→81 帧", async () => {
  await submitEngineGeneration({
    engine: _engine(),
    positive: "nsfwsks, d0gg1e, ...",
    values: {
      resolution: "832x480",
      duration: "5",
      seed: "",
      negative: "低质量",
      loras: [
        { name: "NSFW-22-H-e8.safetensors", strength: 0.8 },
        { name: "DR34ML4Y_I2V_14B_LOW_V2.safetensors", strength: 0.7 },
      ],
      full_quality: false,
    },
    refImage: { filename: "ref.png", worker: "http://w" },
  });
  assert.ok(fetchCalls[0].url.endsWith("/api/generate/video"));
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.image, "ref.png");
  assert.equal(body.worker, "http://w");
  assert.equal(body.width, 832);
  assert.equal(body.height, 480);
  assert.equal(body.length, 81); // 5s×16fps=80 → 就近 4n+1 = 81
  assert.equal(body.fps, 16);
  assert.equal(body.negative, "低质量");
  assert.equal(body.full_quality, false);
  assert.deepEqual(body.loras, [
    { name: "NSFW-22-H-e8.safetensors", strength: 0.8 },
    { name: "DR34ML4Y_I2V_14B_LOW_V2.safetensors", strength: 0.7 },
  ]);
});

test("wan-nsfw-i2v payload:3s→49 / 7.5s→121(上限),时长缺省回落 5s", async () => {
  for (const [sec, frames] of [["3", 49], ["7.5", 121]] as const) {
    fetchCalls = [];
    await submitEngineGeneration({
      engine: _engine(),
      positive: "x",
      values: { resolution: "704x1280", duration: sec, seed: "" },
      refImage: { filename: "ref.png", worker: "http://w" },
    });
    const body = fetchCalls[0].body as Record<string, unknown>;
    assert.equal(body.length, frames, `${sec}s 应吸附 ${frames} 帧`);
    assert.equal(body.width, 704);
    assert.equal(body.height, 1280);
  }
  // 缺省 duration → 5s → 81 帧
  fetchCalls = [];
  await submitEngineGeneration({
    engine: _engine(),
    positive: "x",
    values: { seed: "" },
    refImage: { filename: "ref.png", worker: "http://w" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.length, 81);
  assert.equal(body.width, 832); // 缺省分辨率回落 832×480
  assert.equal("loras" in body, false); // 未选 LoRA → 省略字段,后端 AI 选配
});

test("wan-nsfw-i2v payload:满血档开关透传 full_quality=true", async () => {
  await submitEngineGeneration({
    engine: _engine(),
    positive: "x",
    values: { duration: "5", resolution: "832x480", seed: "42", full_quality: true },
    refImage: { filename: "ref.png", worker: "http://w" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.full_quality, true);
  assert.equal(body.seed, 42);
});

test("wan-nsfw-i2v 无参考图 → 本地报错不发请求", async () => {
  await assert.rejects(
    () =>
      submitEngineGeneration({
        engine: _engine(),
        positive: "x",
        values: { seed: "" },
      }),
    /请先上传参考图/,
  );
  assert.equal(fetchCalls.length, 0);
});

test("wan-nsfw-i2v payload: loras [] sends off; omit/null stays auto", async () => {
  await submitEngineGeneration({
    engine: _engine(),
    positive: "x",
    values: { seed: "", loras: [] },
    refImage: { filename: "ref.png", worker: "http://w" },
  });
  let body = fetchCalls[0].body as Record<string, unknown>;
  assert.deepEqual(body.loras, [], "explicit [] is off");

  fetchCalls = [];
  await submitEngineGeneration({
    engine: _engine(),
    positive: "x",
    values: { seed: "", loras: null },
    refImage: { filename: "ref.png", worker: "http://w" },
  });
  body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal("loras" in body, false, "null omits field = auto");
});
