/**
 * 10/8:短剧项目默认竖屏 768×1344@24;不在预设里的项目规格必须保留,不能被「拆解」静默改写。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_FPS, FPS_OPTIONS, RES_PRESETS, resOptionsFor } from "../lib/studioSpec";

test("首项预设=短剧默认竖屏 768×1344,默认帧率 24", () => {
  assert.deepEqual([RES_PRESETS[0].w, RES_PRESETS[0].h], [768, 1344]);
  assert.equal(DEFAULT_FPS, 24);
  assert.ok((FPS_OPTIONS as readonly number[]).includes(DEFAULT_FPS));
});

test("预设内规格:选项不变,下标指向当前规格", () => {
  const opts = resOptionsFor(768, 384);
  assert.equal(opts.length, RES_PRESETS.length);
  assert.equal(opts.findIndex((p) => p.w === 768 && p.h === 384), 1);
});

test("预设外规格(如 1080×1920):作为首项保留,拆解不会回落改写", () => {
  const opts = resOptionsFor(1080, 1920);
  assert.equal(opts.length, RES_PRESETS.length + 1);
  assert.deepEqual([opts[0].w, opts[0].h], [1080, 1920]);
  assert.match(opts[0].label, /当前/);
});

test("缺规格(详情未加载/0):不插自定义项", () => {
  assert.equal(resOptionsFor(undefined, undefined).length, RES_PRESETS.length);
  assert.equal(resOptionsFor(0, 0).length, RES_PRESETS.length);
});
