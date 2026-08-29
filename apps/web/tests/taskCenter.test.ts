// 任务中心(全量进度体系,2026-08-29):纯函数呈现逻辑
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fmtDuration,
  fmtEta,
  kindLabel,
  statusLineOf,
} from "../components/nav/taskCenterUtils";
import type { ActiveJobItem } from "../lib/api";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

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

/* ── 中止按钮(2026-08-29):源码断言 ── */

describe("任务中止接线", () => {
  it("TaskCenter 条目渲染中止按钮并经 cancelJob 调后端", () => {
    const view = readSrc("components/nav/TaskCenter.tsx");
    assert.ok(view.includes("cancelJob"), "TaskCenter 未导入 cancelJob");
    assert.ok(view.includes("taskcenter-item-cancel"), "缺中止按钮类名");
    assert.ok(view.includes("window.confirm"), "中止前须二次确认");
    assert.ok(view.includes("cancelingIds"), "缺中止中防连点状态");
    assert.ok(
      view.includes("aria-label={`中止任务:${item.prompt || item.kind}`}"),
      "中止按钮缺无障碍标签",
    );
  });
  it("api.ts cancelJob 走 POST /api/jobs/{id}/cancel 并透出后端 detail", () => {
    const api = readSrc("lib/api.ts");
    assert.ok(api.includes("export async function cancelJob"), "api.ts 缺 cancelJob");
    assert.ok(api.includes("/cancel`"), "cancelJob 未命中 /cancel 端点");
    assert.ok(api.includes('method: "POST"'), "cancelJob 应为 POST");
  });
  it("中止按钮样式挂 --err 令牌", () => {
    const css = readSrc("app/styles/cornernav.css");
    assert.ok(css.includes(".taskcenter-item-cancel"), "缺中止按钮样式");
    assert.ok(css.includes("var(--err)"), "中止按钮应使用 --err 危险色令牌");
  });
  it("弹层宽度有硬上限(防 nowrap prompt 撑出视口裁掉中止按钮)", () => {
    const css = readSrc("app/styles/cornernav.css");
    const pop = css.slice(css.indexOf(".taskcenter-pop {"));
    assert.ok(pop.includes("width: 320px"), "弹层须固定 320 宽");
    assert.ok(pop.includes("max-width: calc(100vw - 32px)"), "弹层须限视口上限");
    const item = css.slice(css.indexOf(".taskcenter-item {"));
    assert.ok(item.includes("min-width: 0"), "条目须 min-width:0 让 ellipsis 生效");
  });
});
