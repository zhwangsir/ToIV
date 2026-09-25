/**
 * U1 作业失败自愈纯函数单测(node:test)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AppItem } from "../lib/apps";
import {
  jobCardCanRerun,
  jobKindToAppCategory,
  pickSimilarPassApps,
  plainJobErrorReason,
  stripErrorNoise,
} from "../lib/jobSelfheal";

function app(over: Partial<AppItem> & { id: string; name: string }): AppItem {
  return {
    description: "",
    icon: "box",
    category: "image",
    params_schema: [],
    bindings: {},
    workflow_json: null,
    output_kind: "image",
    is_builtin: false,
    is_nsfw: false,
    is_public: true,
    is_mine: false,
    usage_count: 0,
    sort: 0,
    cover_url: null,
    author: null,
    rh_webapp_id: null,
    rh_webapp_url: null,
    source_links: [],
    use_case: "",
    featured: false,
    smoke_status: "pass",
    ...over,
  };
}

test("stripErrorNoise:截断 Traceback 取末行异常消息", () => {
  const raw = `Traceback (most recent call last):\n  File "x.py", line 1\nRuntimeError: CUDA out of memory`;
  assert.equal(stripErrorNoise(raw), "CUDA out of memory");
});

test("plainJobErrorReason:OOM → 大白话;空 → 兜底", () => {
  assert.match(plainJobErrorReason("CUDA out of memory"), /显存不足/);
  assert.match(plainJobErrorReason(null, "VRAM 不足"), /显存不足/);
  assert.match(plainJobErrorReason(""), /生成失败/);
  assert.match(plainJobErrorReason("missing model foo.safetensors"), /缺少模型/);
});

test("plainJobErrorReason:友好超时不改写含作品库指引的文案", () => {
  const msg = "作业跟踪超时,请在作品库查看结果";
  assert.equal(plainJobErrorReason(msg), msg);
});

test("jobKindToAppCategory:引擎与 app_* 映射", () => {
  assert.equal(jobKindToAppCategory("txt2img"), "image");
  assert.equal(jobKindToAppCategory("h3_t2v"), "video");
  assert.equal(jobKindToAppCategory("app_video"), "video");
  assert.equal(jobKindToAppCategory("unknown_xyz"), "all");
});

test("pickSimilarPassApps:只取 pass、排除自身、同 use_case 优先", () => {
  const apps = [
    app({ id: "a1", name: "原卡", use_case: "portrait", smoke_status: "pass" }),
    app({ id: "a2", name: "同类PASS", use_case: "portrait", smoke_status: "pass" }),
    app({ id: "a3", name: "异类PASS", use_case: "landscape", category: "video", output_kind: "video", smoke_status: "pass" }),
    app({ id: "a4", name: "失败卡", use_case: "portrait", smoke_status: "fail" }),
    app({ id: "a5", name: "私有", use_case: "portrait", is_public: false, smoke_status: "pass" }),
  ];
  const picks = pickSimilarPassApps({
    excludeAppId: "a1",
    useCase: "portrait",
    category: "image",
    apps,
    limit: 3,
  });
  assert.deepEqual(
    picks.map((p) => p.id),
    ["a2"],
  );
});

test("pickSimilarPassApps:无种子维度时返回任意 PASS", () => {
  const apps = [
    app({ id: "x", name: "X", smoke_status: "pass" }),
    app({ id: "y", name: "Y", smoke_status: "timeout" }),
  ];
  const picks = pickSimilarPassApps({ apps, limit: 5 });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].id, "x");
});

test("jobCardCanRerun:白名单 ∧ hasParams ∧ 非进行中", () => {
  assert.equal(jobCardCanRerun({ kind: "txt2img", status: "error", hasParams: true }), true);
  assert.equal(jobCardCanRerun({ kind: "txt2img", status: "error", hasParams: false }), false);
  assert.equal(jobCardCanRerun({ kind: "app_image", status: "error", hasParams: true }), false);
  assert.equal(jobCardCanRerun({ kind: "h3_t2v", status: "running", hasParams: true }), false);
});
