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
    assert.equal(kindLabel("h3_t2v"), "文生视频");
    assert.equal(kindLabel("h3_i2v"), "图生视频");
    assert.equal(kindLabel("h3_extend_i2v"), "长视频续写");
    assert.equal(kindLabel("controlnet"), "ControlNet");
    assert.equal(kindLabel("inpaint"), "局部重绘");
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
    assert.ok(view.includes("prevRef.current?.delete(item.prompt_id)"), "中止成功须从完成检测基准摘掉,防双 toast");
    assert.ok(view.includes("key={item.id}"), "条目 key 须用 job id(prompt_id 可能空/重复)");
    assert.ok(view.includes("cancelingIds"), "缺中止中防连点状态");
    assert.ok(
      view.includes("aria-label={`中止任务:${item.prompt || item.kind}`}"),
      "中止按钮缺无障碍标签",
    );
  });

  it("中止确认走 ui/Modal 确认门(2026-08-30 收敛,不再用原生 window.confirm)", () => {
    const view = readSrc("components/nav/TaskCenter.tsx");
    assert.ok(!view.includes("window.confirm"), "原生 window.confirm 应已被 Modal 确认门替代");
    assert.ok(view.includes('import { Modal } from "@/components/ui/Modal"'), "未引入 ui/Modal");
    assert.ok(view.includes('title="中止任务"'), "缺中止确认 Modal");
    assert.ok(view.includes("确认中止"), "缺确认中止按钮");
    assert.ok(view.includes("danger"), "中止确认门应为危险态(danger)");
  });

  it("作业从在跑清单消失时先 lookup 查终态,按 done/error/canceled 分别通知", () => {
    const view = readSrc("components/nav/TaskCenter.tsx");
    assert.ok(view.includes("lookupJob"), "消失条目须 lookup 查终态再通知");
    assert.ok(view.includes("Promise.allSettled"), "多条 lookup 须 allSettled(单条抖动不误报)");
    assert.ok(view.includes('job?.status === "done"'), "缺 done 终态分支");
    assert.ok(view.includes('job?.status === "error"'), "缺 error 终态分支");
    assert.ok(view.includes('job?.status === "canceled"'), "缺 canceled 终态分支");
    assert.ok(view.includes("toast.error("), "失败须用错误色 toast(不再一律绿色成功)");
    assert.ok(view.includes("job.error"), "失败原因须透出落库 job.error");
  });

  it("失败条目带「重试」入口(rerun 精确重生)", () => {
    const view = readSrc("components/nav/TaskCenter.tsx");
    assert.ok(view.includes("rerunJob"), "失败重试须走 rerunJob");
    assert.ok(view.includes("taskcenter-item-retry"), "缺重试按钮类名");
    assert.ok(view.includes("最近失败"), "缺失败条目小节");
  });

  it("GenerateView Stop wires cancelJob then gen.reset", () => {
    const view = readSrc("components/generate/GenerateView.tsx");
    assert.ok(view.includes("cancelJob"), "GenerateView must import/call cancelJob");
    assert.ok(view.includes("runningPromptIdRef"), "cancel uses promptId");
    const bar = readSrc("components/generate/PromptBar.tsx");
    assert.ok(bar.includes("停止"), "PromptBar Stop label");
    assert.equal(bar.includes("停止跟踪"), false);
    const panel = readSrc("components/generate/ResultPanel.tsx");
    assert.ok(panel.includes("已中止该作业"), "取消态文案须同步为真中止");
    assert.equal(panel.includes("已停止前端跟踪"), false);
  });
  it("api.ts cancelJob 走 POST /api/jobs/{id}/cancel 并透出后端 detail", () => {
    const api = readSrc("lib/api.ts");
    assert.ok(api.includes("export async function cancelJob"), "api.ts 缺 cancelJob");
    assert.ok(api.includes("/cancel`"), "cancelJob 未命中 /cancel 端点");
    assert.ok(api.includes('method: "POST"'), "cancelJob 应为 POST");
  });
  it("中止按钮样式挂 --err 令牌", () => {
    const css = readSrc("app/styles/nav-account.css");
    assert.ok(css.includes(".taskcenter-item-cancel"), "缺中止按钮样式");
    assert.ok(css.includes("var(--err)"), "中止按钮应使用 --err 危险色令牌");
  });
  it("弹层宽度有硬上限(防 nowrap prompt 撑出视口裁掉中止按钮)", () => {
    const css = readSrc("app/styles/nav-account.css");
    const pop = css.slice(css.indexOf(".taskcenter-pop {"));
    assert.ok(pop.includes("width: 320px"), "弹层须固定 320 宽");
    assert.ok(pop.includes("max-width: calc(100vw - 32px)"), "弹层须限视口上限");
    const item = css.slice(css.indexOf(".taskcenter-item {"));
    assert.ok(item.includes("min-width: 0"), "条目须 min-width:0 让 ellipsis 生效");
  });
});
