// 任务中心(全量进度体系,2026-08-29):纯函数呈现逻辑
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fmtDuration,
  fmtEta,
  kindLabel,
  statusLineOf,
} from "../components/nav/taskCenterUtils";
import type { ActiveJobItem } from "../lib/api";

function mkItem(overrides: Partial<ActiveJobItem> = {}): ActiveJobItem {
  return {
    id: "j1",
    prompt_id: "p1",
    kind: "h3_t2v",
    status: "running",
    prompt: "a cat",
    worker: "http://w",
    created_at: "2026-08-29T00:00:00",
    wait_sec: 185,
    eta_sec: 450,
    progress: { pct: null, step: null, total: null, queue_pos: null, updated_at: null },
    hold_reason: "",
    nsfw: false,
    ...overrides,
  };
}

describe("kindLabel", () => {
  it("精确命中静态表", () => {
    assert.equal(kindLabel("txt2img"), "文生图");
    assert.equal(kindLabel("drama_char_reference_front"), "角色三视图·正");
  });
  it("前缀归类", () => {
    assert.equal(kindLabel("h3_t2v"), "H3 视频");
    assert.equal(kindLabel("h3_extend_i2v"), "H3 续写");
    assert.equal(kindLabel("wan_i2v"), "Wan 视频");
  });
  it("未命中回落原样", () => {
    assert.equal(kindLabel("mystery_kind"), "mystery_kind");
  });
});

describe("fmtDuration", () => {
  it("分钟级", () => {
    assert.equal(fmtDuration(185), "3:05");
    assert.equal(fmtDuration(0), "0:00");
  });
  it("小时级", () => {
    assert.equal(fmtDuration(3725), "1:02:05");
  });
});

describe("fmtEta", () => {
  it("短时长归一", () => {
    assert.equal(fmtEta(45), "约 1 分钟");
  });
  it("分钟取整", () => {
    assert.equal(fmtEta(450), "约 8 分钟");
  });
  it("小时一位小数", () => {
    assert.equal(fmtEta(5400), "约 1.5 小时");
  });
});

describe("statusLineOf", () => {
  it("held 带原因", () => {
    const item = mkItem({ status: "held", hold_reason: "显存不足" });
    assert.equal(statusLineOf(item), "资源排队中 · 显存不足");
  });
  it("排队位", () => {
    const item = mkItem({
      status: "queued",
      progress: { pct: null, step: null, total: null, queue_pos: 2, updated_at: null },
    });
    assert.equal(statusLineOf(item), "排队第 2 位");
  });
  it("step 进度带步数", () => {
    const item = mkItem({
      progress: { pct: 42, step: 10, total: 24, queue_pos: 0, updated_at: null },
    });
    assert.equal(statusLineOf(item), "生成中 42% (10/24 步)");
  });
  it("无进度回落生成中", () => {
    assert.equal(statusLineOf(mkItem()), "生成中");
  });
});
