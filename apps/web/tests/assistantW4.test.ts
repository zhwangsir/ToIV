/**
 * W4(2026-08-31)视觉焕新 + 紧凑化单测(node:test,无 DOM):
 * ① ParticleField 微粒场:数量/速度红线、reduced-motion、可见性暂停、主题联动、指针/水波/汇聚 API
 * ② 胶片条:flattenVisualFrames 纯函数、renderAvFrames 单帧 hero/多帧条、消息与作业卡接线
 * ③ 首页紧凑化:页头去标题描述(纯图标按钮)、MODEL_DESC 退役、场景/快捷 chip 化、作品库去重
 * ④ token 纪律:globals.css W4 token 块、assistant.css 粒子分层(z-0/1/2 + pointer-events none)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

// ── window/localStorage 替身:必须在导入组件模块前装好(同 assistantPortal.test.ts 纪律) ──
const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  clear: () => localStore.clear(),
};

const {
  flattenVisualFrames,
  renderAvFrames,
  aggregateJobFrames,
  messagesToChat,
  SCENE_CAPSULES,
  OFFLINE_ENTRIES,
} = await import("../components/assistant/AssistantView");
const {
  PARTICLE_CAP,
  SPEED_CAP,
  RIPPLE_SPEED,
  particleCountForWidth,
  parseCssColor,
} = await import("../components/assistant/ParticleField");

/* ── ① ParticleField 微粒场 ── */

test("W4 微粒场:数量/速度红线(用户视觉红线硬约束)", () => {
  // 总数硬上限 300,实际投放远低于上限
  assert.equal(PARTICLE_CAP, 300, "微粒总数硬上限须为 300");
  assert.ok(particleCountForWidth(1920) <= 300 && particleCountForWidth(1920) >= 100);
  assert.ok(particleCountForWidth(390) < particleCountForWidth(1440), "窄屏应减量");
  assert.ok(particleCountForWidth(99999) <= 300, "任何宽度不超上限");
  // 速度红线 1.2,实现取克制值
  assert.ok(SPEED_CAP < 1.2, `漂移速度上限 ${SPEED_CAP} 须低于红线 1.2`);
  assert.ok(RIPPLE_SPEED <= 3, "水波扩散应慢速");
});

test("W4 微粒场:parseCssColor 解析 hex/rgb,坏输入回退", () => {
  assert.deepEqual(parseCssColor("#17181A"), [23, 24, 26]);
  assert.deepEqual(parseCssColor("#fff"), [255, 255, 255]);
  assert.deepEqual(parseCssColor("rgb(12, 107, 52)"), [12, 107, 52]);
  assert.deepEqual(parseCssColor("rgba(1,2,3,0.5)"), [1, 2, 3]);
  assert.deepEqual(parseCssColor("not-a-color"), [138, 143, 152]);
});

test("W4 微粒场:源码纪律(reduced-motion / 可见性暂停 / 主题联动 / 交互 API)", () => {
  const src = readSrc("components/assistant/ParticleField.tsx");
  assert.ok(src.includes("prefers-reduced-motion"), "缺 reduced-motion 静态降级");
  assert.ok(src.includes("visibilitychange"), "缺标签页隐藏暂停");
  assert.ok(src.includes("ResizeObserver"), "缺容器尺寸跟随");
  assert.ok(src.includes("MutationObserver"), "缺主题切换重取色");
  assert.ok(src.includes('attributeFilter: ["data-theme", "data-mode", "data-pure-black"]'), "主题监听属性不全");
  assert.ok(src.includes("requestAnimationFrame"), "缺 rAF 主循环");
  // 交互三件套:水波 / 汇聚锚点 / 指针缓随
  assert.ok(src.includes("ripple("), "缺水波 API");
  assert.ok(src.includes("setAttractor"), "缺汇聚锚点 API");
  assert.ok(src.includes("pointermove"), "缺指针跟随");
  // 双色即收(主 accent + 次 muted),不引入彩虹
  assert.ok(src.includes("--particle-primary"), "缺主色 token 读取");
  assert.ok(src.includes("--particle-secondary"), "缺次色 token 读取");
});

/* ── ② 胶片条 ── */

test("W4 胶片条:flattenVisualFrames 只收 image/video,空 url 跳过", () => {
  const frames = flattenVisualFrames([
    { type: "image", urls: ["a.png", "", "b.png"] },
    { type: "video", urls: ["c.mp4"] },
    { type: "audio", urls: ["d.mp3"] },
    { type: "model3d", urls: ["e.glb"] },
  ]);
  assert.deepEqual(frames, [
    { type: "image", url: "a.png" },
    { type: "image", url: "b.png" },
    { type: "video", url: "c.mp4" },
  ]);
  assert.deepEqual(flattenVisualFrames([]), []);
});

test("W4 胶片条:单帧 hero 直出,≥2 帧成条(导轨/帧号/语义)", () => {
  // 单帧:走 renderAvMedia 的 hero 分支,不出胶片条
  const single = renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderAvFrames([{ type: "image", url: "x.png" }], "t")),
  );
  assert.ok(single.includes("av-media-img"), "单帧应 hero 直出");
  assert.ok(!single.includes("av-filmstrip"), "单帧不应成条");
  // 零帧:不渲染
  assert.equal(renderAvFrames([], "t"), null);
  // 三帧:胶片条 + 帧号 01/02/03 + group 语义
  const strip = renderToStaticMarkup(
    React.createElement(React.Fragment, null, renderAvFrames([
      { type: "image", url: "1.png" },
      { type: "image", url: "2.png" },
      { type: "video", url: "3.mp4" },
    ], "t")),
  );
  assert.ok(strip.includes("av-filmstrip"), "多帧应成胶片条");
  assert.ok(strip.includes('aria-label="产物胶片条"'), "胶片条缺语义标签");
  for (const no of ["01", "02", "03"]) {
    assert.ok(strip.includes(`>${no}<`), `缺帧号 ${no}`);
  }
  assert.ok(strip.includes("<video"), "视频帧缺失");
});

test("W4 胶片条:消息媒体与作业卡产物均接线 AvMediaList/AvJobResults", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("<AvMediaList media={msg.media} />"), "消息媒体未走胶片条分流");
  assert.ok(src.includes("<AvJobResults kind={j.kind} results={j.results} jobId={j.jobId} />"), "作业卡产物未走胶片条分流");
  // 打孔列在 wrapper(不随横向滚动)
  assert.ok(src.includes(".av-filmstrip::before"), "缺打孔列样式");
  assert.ok(src.includes("scroll-snap-type: x mandatory"), "胶片条缺 scroll-snap");
});

/* ── ③ 首页紧凑化 ── */

test("W4 紧凑化:页头去标题/描述,操作钮纯图标化", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(!src.includes("av-header-main"), "页头主标题块应移除");
  assert.ok(!src.includes("av-header-title"), "页头标题应移除(CornerNav 已指示板块)");
  assert.ok(!src.includes("av-header-desc"), "页头描述应移除");
  assert.ok(!src.includes("<span>历史</span>"), "历史按钮应纯图标化");
  assert.ok(!src.includes("<span>新建</span>"), "新建按钮应纯图标化");
  assert.ok(src.includes("av-tb-btn--icon"), "缺纯图标按钮档");
  // 可发现性不丢:title/aria-label 保留
  assert.ok(src.includes('aria-label="对话历史"'), "历史按钮 aria-label 缺失");
  assert.ok(src.includes('aria-label="新对话"'), "新建按钮 aria-label 缺失");
});

test("W4 紧凑化:MODEL_DESC 退役 + 场景/快捷 chip 化 + 作品库去重", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(!src.includes("MODEL_DESC"), "陈旧 MODEL_DESC 常量应退役");
  assert.ok(!src.includes("模型说明"), "设置面板「模型说明」组应移除(模型名实时胶囊已够)");
  // 场景 chip 行(icon+短语,无 desc 渲染;desc 收进 title 提示)
  assert.ok(src.includes("av-scene-row"), "缺场景 chip 行");
  assert.ok(src.includes("av-scene-chip"), "缺场景 chip");
  assert.ok(!src.includes("av-scene-desc"), "场景卡描述文案应移除");
  assert.ok(src.includes("title={c.desc}"), "场景 desc 应收进 title 提示");
  // 快捷 chip 行(不再铺长 prompt 预览)
  assert.ok(src.includes("av-quick-row"), "缺快捷 chip 行");
  assert.ok(!src.includes("av-quick-desc"), "快捷卡 prompt 预览应移除");
  // 作品库不再占场景入口(与最近作品区重复)
  assert.ok(!SCENE_CAPSULES.some((c) => c.view === "library"), "作品库应从场景入口去重");
});

test("W4 微粒场接线:门户挂载 + 水波/汇聚驱动 + popup 不挂载", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("ParticleField"), "未导入/挂载 ParticleField");
  assert.ok(src.includes("onPortalClick"), "门户点击未接水波");
  assert.ok(src.includes("chipAttractorHandlers"), "chip 悬停未接汇聚锚点");
  assert.ok(src.includes("av-portal-vignette"), "缺径向暗角层");
  // 粒子场挂在 av-portal 容器内(页形态空态),popup 极简空态分支不含挂载点
  const portalIdx = src.indexOf('av-empty av-portal"');
  assert.ok(portalIdx > 0, "缺 av-portal 容器");
  const mount = "<ParticleField ref={particleFieldRef} />";
  const fieldIdx = src.indexOf(mount);
  assert.ok(fieldIdx > portalIdx, "粒子场应挂在门户容器之内");
  assert.ok(src.slice(0, portalIdx).lastIndexOf(mount) < 0, "粒子场不应出现在门户容器之前(popup 分支)");
  const popupIdx = src.indexOf("av-popup-empty");
  assert.ok(popupIdx > 0 && popupIdx < portalIdx, "popup 空态应先于门户出现且不含粒子场");
});

/* ── ⑤ 产物聚合 + 破图修复 + 面板修复(生产实测抓获) ── */

test("W4 聚合:同消息 ≥2 done 作业的视觉产物合并一条胶片条", () => {
  const mk = (jobId: string, results: string[], status = "done") =>
    ({ jobId, kind: "txt2img", status, label: "", results }) as const;
  // 4 个 done 图像卡 → 4 帧聚合
  const agg = aggregateJobFrames([
    mk("a", ["/api/images?filename=1.png&sig=x"]),
    mk("b", ["/api/images?filename=2.png&sig=x"]),
    mk("c", ["/api/images?filename=3.png&sig=x"]),
    mk("d", ["/api/images?filename=4.png&sig=x"]),
  ]);
  assert.equal(agg.length, 4);
  // 单 done 卡不聚合(保持卡内 hero)
  assert.deepEqual(aggregateJobFrames([mk("a", ["/x.png"])]), []);
  // 进行中卡不参与;done 不足 2 帧不聚合
  assert.deepEqual(aggregateJobFrames([
    mk("a", ["/x.png"]),
    { jobId: "b", kind: "txt2img", status: "running", label: "" },
  ] as never), []);
  // 纯音频作业不产生视觉帧
  assert.deepEqual(aggregateJobFrames([
    { jobId: "a", kind: "music", status: "done", label: "", results: ["/api/images?filename=1.mp3&sig=x"] },
    { jobId: "b", kind: "music", status: "done", label: "", results: ["/api/images?filename=2.mp3&sig=x"] },
  ] as never), []);
});

test("W4 破图修复:renderAvMedia/renderAvFrames 渲染时经 imageUrl 补 token", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  // /api/images 强制登录态(Bearer 或 ?token=),<img> 无法带请求头 → 渲染时必须补 token
  assert.ok(src.includes("imageUrl(m.urls[0])"), "renderAvMedia 未补 token");
  assert.ok(src.includes("const src = imageUrl(f.url)"), "renderAvFrames 未补 token");
  // 接线:消息媒体/作业卡组聚合组件
  assert.ok(src.includes("aggregateJobFrames"), "缺产物聚合函数");
  assert.ok(src.includes("<AvJobCards jobs={msg.jobs}"), "作业卡未走聚合组件");
});

test("W4 面板修复:页形态面板 Esc 统一关闭 + 桌面端顶让位 chrome 带", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  // Esc 同时收敛三面板(此前仅 popup 抽屉响应 Esc)
  assert.ok(/Escape"\)[\s\S]{0,120}setDocsOpen\(false\)/.test(src), "页形态面板缺 Esc 关闭");
  // 桌面端面板顶让位 56px(账户头像带),窄屏恢复全高
  assert.ok(/\.av-panel \{[^}]*top: 56px/.test(src), "面板未让位顶部 chrome 带");
  assert.ok(/max-width: 1023px\)[\s\S]{0,80}\.av-panel \{[\s\S]{0,40}top: 0/.test(src), "窄屏面板应恢复全高");
});

test("W4 token:globals.css 注入胶片条/微粒 token;粒子分层 pointer-events none", () => {
  const css = readSrc("app/globals.css");
  for (const tok of ["--film-frame-w", "--film-frame-h", "--film-rail-bg", "--film-perf-color", "--particle-primary", "--particle-secondary"]) {
    assert.ok(css.includes(tok), `globals.css 缺 token ${tok}`);
  }
  const acss = readSrc("app/styles/assistant.css");
  assert.ok(acss.includes(".av-particle-field"), "assistant.css 缺粒子场层");
  assert.ok(/\.av-particle-field\s*\{[^}]*pointer-events:\s*none/.test(acss), "粒子场必须 pointer-events none(不挡内容交互)");
  assert.ok(acss.includes(".av-portal-vignette"), "缺径向暗角样式");
  assert.ok(acss.includes("z-index: 2"), "内容层未浮于粒子之上");
  // 旧场景大卡样式已清除
  assert.ok(!acss.includes(".av-scene-card"), "旧场景大卡 CSS 应清除");
});

/* ── ⑦ W4 回放修复:空工具轮空气泡 + 异步产物回放 ── */

test("W4 回放:纯工具轮 assistant 不生成空气泡,tool 媒体并入可见气泡", () => {
  const row = (id: number, role: string, content: string, media: { type: string; urls: string[] }[] = []) =>
    ({ id, role, content, tool_calls: null, media, created_at: "2026-08-31T13:00:00Z" }) as never;
  const msgs = messagesToChat([
    row(1, "user", "画四张猫"),
    row(2, "assistant", ""),            // 工具轮(推理碎片不落库后 content 为空)
    row(3, "assistant", ""),            // 第二个工具轮
    row(4, "tool", "ok", [
      { type: "image", urls: ["/a.png"] },
      { type: "image", urls: ["/b.png"] },
    ]),
    row(5, "assistant", "画好了"),
  ]);
  // 无空内容 assistant 气泡(此前渲染成常驻打字点)
  assert.equal(msgs.filter((m) => m.role === "assistant" && !m.content).length > 0, true, "媒体承载气泡允许空内容");
  assert.equal(msgs.filter((m) => m.role === "assistant" && !m.content && !(m.media?.length)).length, 0, "不允许无内容又无媒体的空气泡");
  // 媒体并入一条气泡,且双帧可进胶片条
  const withMedia = msgs.find((m) => (m.media?.length ?? 0) > 0);
  assert.ok(withMedia, "tool 媒体未并入气泡");
  assert.equal(withMedia!.media!.length, 2);
  assert.equal(msgs[msgs.length - 1].content, "画好了");
});

/* ── ⑥ W5 降级路径:助手离线 → 场景卡门户 ── */

test("W5 降级:探活失败置离线,门户隐藏对话框、展开全量工作台导航", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  // 探活哨兵复用 getLlmModel(null=离线)
  assert.ok(src.includes("setLlmOffline(!info)"), "缺探活离线判定");
  assert.ok(src.includes("const [llmOffline, setLlmOffline]"), "缺 llmOffline 状态");
  // 离线分支:role=alert 提示 + OFFLINE_ENTRIES 全量导航;对话框让位
  assert.ok(src.includes("llmOffline ? ("), "缺离线分支");
  assert.ok(src.includes('role="alert"'), "离线提示缺 alert 语义");
  assert.ok(src.includes("助手暂时离线"), "缺离线提示文案");
  assert.ok(src.includes("OFFLINE_ENTRIES.map"), "离线态未展开全量导航");
  // 全量导航覆盖工作台层高频页
  for (const v of ["image", "video", "audio", "studio", "avatartalk", "dub", "imageEdit", "videoEdit", "canvas", "library", "entities", "market"]) {
    assert.ok(OFFLINE_ENTRIES.some((e) => e.view === v), `离线导航缺 ${v}`);
  }
  // 离线导航不含系统层(admin/观测/设置不堆给普通用户)
  for (const v of ["admin", "observability", "settings"]) {
    assert.ok(!OFFLINE_ENTRIES.some((e) => e.view === v), `离线导航不应含 ${v}`);
  }
});
