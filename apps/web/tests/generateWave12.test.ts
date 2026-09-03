/**
 * Wave-1/Wave-2 前端修复聚合单测(2026-08-30,node:test):
 * ① friendlyError:跟踪超时「请在作品库查看」原样透传,不改写为「请重试」
 * ② trackJob:降级轮询走 lookup 单查;失败透出 job.error;canceled 终态
 * ③ GenerateView:引擎未就绪提示词草稿态回填;enginesError 提升舞台区 ErrorBar + 重试;
 *    canSubmit 禁用原因;pollFinalResult 改 lookup + 超时/失败 toast + 卸载停轮询;
 *    会话历史 localStorage 持久化 + /api/jobs/active 恢复在跑
 * ④ PromptBar:引擎 chip 三态(加载中/加载失败点击重试);禁用原因内联 + title
 * ⑤ ResultPanel:下载按钮;done 零产物失败占位;媒体失败「重新加载」
 * ⑥ api.uploadImage:XHR + uploadTimeoutMs 长超时(图片 60s 底 / 视频 ≥10min)+ onProgress
 * ⑦ ParamField:数值失焦 min/max/step 钳位红字提示;seed 非法明确提示
 * ⑧ RefImageUpload/RefVideoUpload:XHR 进度回调 + progressbar 进度条
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { friendlyError } from "../lib/friendlyError";
import { uploadTimeoutMs } from "../lib/api";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① friendlyError:超时透传「请在作品库查看」 ── */

test("① friendlyError:跟踪超时文案原样透传(不改写为「请重试」)", () => {
  const r = friendlyError("作业跟踪超时,请在作品库查看结果");
  assert.equal(r.message, "作业跟踪超时,请在作品库查看结果");
  assert.equal(r.detail, null, "透传文案不再进 detail 重复");
});

test("① friendlyError:其他超时仍改写为「请重试」(回归)", () => {
  const r = friendlyError("请求超时 (30s),请稍后重试");
  assert.equal(r.message, "生成服务响应超时,请重试");
  assert.equal(r.detail, "请求超时 (30s),请稍后重试");
});

/* ── ② trackJob:lookup 单查 + job.error 透出(行为用例见 trackJob.test.ts ③④+/④++) ── */

test("② trackJob:降级轮询走 lookup 单查,不再全量扫描(源码断言)", () => {
  const src = readSrc("lib/trackJob.ts");
  assert.ok(src.includes("lookupJob(res.prompt_id)"), "降级轮询未走 lookupJob 单查");
  assert.ok(!src.includes("/api/jobs?limit=200"), "全量 200 条扫描残留");
  assert.ok(src.includes("作业跟踪超时,请在作品库查看结果"), "超时文案须保留「作品库」指引");
  assert.ok(src.includes("job.error"), "失败终态须透出 job.error");
  assert.ok(src.includes('job?.status === "canceled"'), "轮询缺 canceled 终态");
});

/* ── ③ GenerateView:草稿态 / 错误条提升 / 禁用原因 / 裁切链轮询 / 历史持久化 ── */

test("③ GenerateView:引擎未就绪提示词进本地草稿,就绪后回填(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("promptDraft"), "缺引擎未就绪本地草稿态");
  assert.ok(src.includes("setPromptDraft(v)"), "onChange 未落入草稿");
  assert.ok(src.includes("promptDraftRefilledRef"), "缺就绪回填一次性守卫");
  // 回填不得覆盖已有输入
  assert.ok(src.includes('(prev[engine.id] ?? "").trim()'), "回填须避让已有输入");
});

test("③ GenerateView:enginesError 提升到舞台区 ErrorBar + 重试按钮(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("generate-engines-error"), "缺舞台区引擎错误条容器");
  assert.ok(src.includes("引擎列表加载失败"), "缺错误条文案");
  assert.ok(src.includes("onEnginesRetry"), "未向 PromptBar 传重试回调");
  assert.ok(src.includes("loadEngines"), "重试未接 loadEngines");
  // 舞台区必须在参数浮板之前渲染(窄屏浮板收起也可见)
  const iStage = src.indexOf("generate-engines-error");
  const iAside = src.indexOf('className="generate-params"');
  assert.ok(iStage > 0 && iStage < iAside, "舞台区错误条须先于参数浮板渲染");
});

test("③ GenerateView:生成按钮禁用原因按 canSubmit 缺失项给出(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("submitBlockReason"), "缺 submitBlockReason");
  assert.ok(src.includes("请先填写提示词"), "缺提示词缺失原因");
  assert.ok(src.includes("请先上传"), "缺参考输入缺失原因");
  assert.ok(src.includes("引擎不可用"), "缺引擎不可用原因");
  assert.ok(src.includes("引擎加载中"), "缺引擎加载中原因");
});

test("③ GenerateView:pollFinalResult 改 lookup 单查 + 超时/失败 toast + 卸载停轮询(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("lookupJob(promptId)"), "裁切链轮询未走 lookupJob");
  assert.ok(!src.includes('apiFetch("/api/jobs?limit=200"'), "裁切链轮询全量扫描残留");
  assert.ok(src.includes("精确裁切未完成,已保留原始时长版本"), "缺超时/失败降级 toast");
  assert.ok(src.includes("mountedRef"), "缺卸载停轮询标记");
});

test("③ GenerateView:会话历史持久化 localStorage + 挂载恢复在跑条目(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("toiv_gen_history_v1"), "缺历史持久化键");
  assert.ok(src.includes("saveJSON(HISTORY_KEY"), "entries 未持久化");
  assert.ok(src.includes("loadJSON<HistoryEntry[]>"), "挂载未读回历史");
  assert.ok(src.includes("fetchActiveJobs"), "恢复未对账 /api/jobs/active");
  assert.ok(src.includes("resumeTracking"), "在跑条目缺恢复跟踪");
});

/* ── ④ PromptBar:引擎 chip 三态 + 禁用原因 ── */

test("④ PromptBar:引擎 chip 区分加载中/加载失败点击重试(源码断言)", () => {
  const src = readSrc("components/generate/PromptBar.tsx");
  assert.ok(src.includes("enginesState"), "缺 enginesState prop");
  assert.ok(src.includes("引擎加载中…"), "缺加载中文案");
  assert.ok(src.includes("引擎加载失败,点击重试"), "缺失败重试文案");
  assert.ok(src.includes("onEnginesRetry"), "缺重试回调");
  assert.ok(src.includes("is-error"), "缺失败态样式钩子");
});

test("④ PromptBar:禁用原因内联提示 + 主按钮 title(源码断言)", () => {
  const src = readSrc("components/generate/PromptBar.tsx");
  assert.ok(src.includes("promptbar-block-reason"), "缺内联原因提示");
  assert.ok(src.includes("submitBlockReason"), "缺 submitBlockReason prop");
  assert.ok(src.includes("title={!canSubmit && submitBlockReason"), "主按钮缺 title 原因透出");
});

/* ── ⑤ ResultPanel:下载 / 空产物占位 / 重新加载 ── */

test("⑤ ResultPanel:结果卡下载按钮 + done 零产物失败占位 + 媒体重新加载(源码断言)", () => {
  const src = readSrc("components/generate/ResultPanel.tsx");
  assert.ok(src.includes('name="download"'), "缺下载图标按钮");
  assert.ok(src.includes("a.download"), "下载未走 a[download]");
  assert.ok(src.includes("未返回产物"), "缺 done 零产物失败占位");
  assert.ok(src.includes('current.paths.length === 0'), "空产物判定缺失");
  assert.ok(src.includes("重新加载"), "媒体失败占位缺「重新加载」动作");
  assert.ok(src.includes("reloadNonce"), "重新加载未强刷 URL(nonce)");
});

/* ── ⑥ 上传韧性:长超时估算 + XHR 进度 ── */

test("⑥ uploadTimeoutMs:图片 60s 底 / 大文件按 2MB/s 估算 / 视频 ≥10min / 20min 封顶", () => {
  const img = { name: "a.png", size: 3 * 1024 * 1024, type: "image/png" } as File;
  assert.equal(uploadTimeoutMs(img), 60_000, "小图片 60s 下限");
  const bigImg = { name: "b.png", size: 300 * 1024 * 1024, type: "image/png" } as File;
  assert.equal(uploadTimeoutMs(bigImg), 600_000, ">50MB 按视频档 10min 下限");
  const video = { name: "c.mp4", size: 10 * 1024 * 1024, type: "video/mp4" } as File;
  assert.equal(uploadTimeoutMs(video), 600_000, "视频 ≥10min");
  const huge = { name: "d.mov", size: 1024 * 1024 * 1024 * 4, type: "video/quicktime" } as File;
  assert.equal(uploadTimeoutMs(huge), 20 * 60_000, "20min 封顶");
});

test("⑥ api.ts uploadImage 改 XHR(进度 + 长超时),错误透出后端 detail(源码断言)", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("new XMLHttpRequest()"), "上传未走 XHR");
  assert.ok(src.includes("xhr.upload.onprogress"), "缺上传进度回调");
  assert.ok(src.includes("xhr.timeout = uploadTimeoutMs(file)"), "超时未按文件大小估算");
  assert.ok(src.includes("opts?.onProgress"), "onProgress 未透出");
});

/* ── ⑦ ParamField:数值钳位 + seed 校验 ── */

test("⑦ ParamField:数值失焦按 min/max/step 钳位并红字提示;seed 非法明确提示(源码断言)", () => {
  const src = readSrc("components/generate/ParamField.tsx");
  assert.ok(src.includes("onBlur={onNumberBlur}"), "数值参数缺失焦钳位");
  assert.ok(src.includes("已按下限"), "缺下限钳位提示");
  assert.ok(src.includes("已按上限"), "缺上限钳位提示");
  assert.ok(src.includes("已按步长"), "缺步长对齐提示");
  assert.ok(src.includes("随机种子须为非负整数"), "seed 非法缺明确提示");
  assert.ok(src.includes("error={numError ?? undefined}"), "红字提示未接 Field error 槽");
});

test("⑦b ParamField: images max>1 复用 RefImagesUpload(应用运行页多图上传)", () => {
  const src = readSrc("components/generate/ParamField.tsx");
  assert.ok(src.includes("case \"images\""), "缺 images 分支");
  assert.ok(src.includes("<RefImagesUpload"), "max>1 未复用 RefImagesUpload");
  assert.ok(src.includes("<RefImageUpload"), "max=1 未复用 RefImageUpload");
  assert.ok(src.includes("<RefVideoUpload"), "video 未复用 RefVideoUpload");
  assert.ok(src.includes("<RefAudioUpload"), "audio 未复用 RefAudioUpload");
  assert.ok(src.includes("uploadKind"), "缺 uploadKind(走 /api/upload)");
});

/* ── ⑧ 参考输入上传进度条 ── */

test("⑧ RefImageUpload/RefVideoUpload:XHR onProgress + progressbar 进度条(源码断言)", () => {
  for (const [rel, cls] of [
    ["components/generate/RefImageUpload.tsx", "ref-image-progress"],
    ["components/generate/RefVideoUpload.tsx", "ref-video-progress"],
  ] as const) {
    const src = readSrc(rel);
    assert.ok(src.includes("onProgress"), `${rel} 未接 onProgress`);
    assert.ok(src.includes('role="progressbar"'), `${rel} 缺 progressbar`);
    assert.ok(src.includes(cls), `${rel} 缺 ${cls} 进度条类名`);
    assert.ok(src.includes("aria-valuenow"), `${rel} 进度条缺 aria-valuenow`);
  }
});
