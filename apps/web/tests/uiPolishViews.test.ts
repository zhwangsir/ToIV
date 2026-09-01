/**
 * 视图批 1 UI 排版优化单测(2026-08-16,Team B:工作台+首页+融合+作品库):
 * ① stage.css 空态降权:主标题 display 档 → --text-title,描述行 --text-body + --leading-loose,
 *    引导卡序号墨丸化(accent 墨底白字),段控轨道下沉
 * ② GenerateView 引擎说明(2026-08-17 T2 重构):描述/出处收进 ⓘ 说明卡(Popover+EngineInfoCard),
 *    面板首屏不再平铺;卡内渲染断言见 generateInspector.test.ts
 * ③ AudioView 页头一致:页头已移除,生成/编辑段控独立窄行并带图标
 * ④ 首页门户:引擎胶囊行补「引擎状态」语义化小标题;门户垂直节奏收紧(顶距 --space-6)
 * ⑤ FusionView:旗舰卡补流程步骤行辅助信息;线稿水印转向 text-primary 混色;pills 描边提强
 * ⑥ 作品库:splitCardTitle 元信息串拆分(标题/副标);卡脚副标行;工具行四组三条 hairline
 * 说明:node 无 DOM,断言分两类——源码结构断言(fs.readFileSync)与纯函数直测(splitCardTitle)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { splitCardTitle } from "../lib/libraryQuery";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/** 提取 CSS 选择器规则块(首个匹配;@media 内的同名覆盖块不影响基础档断言)。 */
function cssBlock(css: string, selector: string): string {
  const m = css.match(new RegExp(`\\${selector} \\{[^}]*\\}`));
  assert.ok(m, `缺少 ${selector} 规则块`);
  return m[0];
}

/* ── ① 工作台空态降权(stage.css) ── */
test("stage.css 空态:主标题降标题档(无 display 档残留),描述行升正文档", () => {
  const css = readSrc("app/styles/stage.css");
  const display = cssBlock(css, ".empty-display");
  assert.ok(display.includes("font-size: var(--text-title)"), "空态主标题未降到 --text-title");
  assert.ok(!display.includes("--text-display"), "空态主标题仍有 display 档残留");
  assert.ok(display.includes("var(--font-semibold)"), "空态主标题字重须 semibold");

  const desc = cssBlock(css, ".empty-tip-desc");
  assert.ok(desc.includes("font-size: var(--text-body)"), "步骤卡正文未升到 --text-body");
  assert.ok(desc.includes("var(--leading-loose, 1.7)"), "步骤卡正文行高未走 --leading-loose 兜底写法");
  assert.ok(desc.includes("var(--text-secondary)"), "步骤卡正文色未提到 secondary(对比不足)");
});

test("stage.css 空态:引导卡序号墨丸化(accent 墨底白字圆丸)", () => {
  const css = readSrc("app/styles/stage.css");
  const num = cssBlock(css, ".empty-tip-num");
  assert.ok(num.includes("background: var(--accent)"), "序号未上墨丸(accent 底)");
  assert.ok(num.includes("color: var(--text-on-accent)"), "序号未用 on-accent 白字");
  assert.ok(num.includes("border-radius: var(--radius-full)"), "序号未圆丸化");
});

test("stage.css 参数浮板段控:轨道下沉一档(canvas 底 + 强描边,未选中项层级拉开)", () => {
  const css = readSrc("app/styles/stage.css");
  const seg = cssBlock(css, ".generate-group-seg");
  assert.ok(seg.includes("background: var(--bg-canvas)"), "段控轨道未下沉到 canvas");
  assert.ok(seg.includes("border-color: var(--border-strong)"), "段控轨道描边未提强");
});

/* ── ② 引擎说明卡(GenerateView;2026-08-17 T2 重构:描述/出处自面板首屏收进 ⓘ 说明卡) ── */
test("GenerateView 引擎说明:ⓘ 按钮 + Popover 承载 EngineInfoCard,首屏不再平铺出处(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("engine-info-btn"), "引擎行缺 ⓘ 说明按钮");
  assert.ok(src.includes("EngineInfoCard"), "未接入引擎说明卡组件");
  assert.ok(src.includes("engine-info-pop"), "说明卡浮层缺实底覆盖类");
  assert.ok(src.includes("<Popover"), "说明卡未走 ui/Popover 承载");
  // 面板首屏不再平铺描述/出处(全部收进说明卡,EngineInfoCard 渲染断言见 generateInspector.test.ts)
  assert.ok(!src.includes("engine-source-details"), "旧内联出处折叠残留");
  assert.ok(!src.includes("engine-desc"), "旧内联引擎描述残留");
});

/* ── ③ 音频页头一致(AudioView) ── */
test("AudioView 无页头:生成/编辑段控独立窄行且带图标(2026-08-18 页头移除改版)", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  // 页头整体移除:灵动岛已指示当前板块,工作台首屏全给内容
  assert.ok(!src.includes("PageHeader"), "AudioView 页头应已移除");
  assert.ok(src.includes('className="audio-mode-row"'), "段控窄行缺失");
  assert.ok(src.includes('aria-label="音频模式"'), "段控 aria-label 缺失");
  assert.ok(
    src.includes('name={k === "gen" ? "sparkles" : "scissors"}'),
    "段控按钮未补图标",
  );
  // 内嵌生成台不再传已退役的 hideHeader
  assert.ok(!src.includes("hideHeader"), "hideHeader prop 已退役,不应再传");
});

/* ── ④ 首页门户(Studio Console v1,2026-08-31)── */
test("首页空态:极简 console 形态(铭牌+输入框+模型行),门户区块全退役", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("av-console-wordmark"), "缺 TOIV 铭牌");
  assert.ok(src.includes("av-console-model"), "缺模型行");
  assert.ok(!src.includes("av-eng-block"), "引擎胶囊条应退役");
  assert.ok(!src.includes("av-works"), "最近作品区应退役");

  const css = readSrc("app/styles/assistant.css");
  // 门户容器回归垂直居中(基座 .av-empty 承载,override 不再压 flex-start)
  const portal = cssBlock(css, ".av-empty.av-portal");
  assert.ok(!portal.includes("flex-start"), "空态应居中而非顶对齐");
  assert.ok(portal.includes("min-height: 100%"), "空态须撑满对话区才能垂直居中(生产实测贴顶回归)");
  assert.ok(!css.includes(".av-eng-label"), "引擎状态小标题样式应退役");
});

/* ── ⑤ 融合(FusionView + fusion.css) ── */
test("融合:旗舰卡补流程步骤行辅助信息(数据驱动 flow)", () => {
  const src = readSrc("components/fusion/FusionView.tsx");
  assert.ok(src.includes("flow?: string[]"), "FusionApp 缺 flow 辅助信息字段");
  assert.ok(/flow:\s*\[/.test(src), "旗舰卡数据缺 flow 步骤");
  assert.ok(src.includes('className="fusion-card-flow"'), "流程步骤行未渲染");
  assert.ok(src.includes("fusion-card-flow-num"), "流程步骤缺衬线序号");

  const css = readSrc("app/styles/fusion.css");
  const flow = cssBlock(css, ".fusion-card-flow");
  assert.ok(flow.includes("border-top: 1px solid var(--border-subtle)"), "流程行缺 hairline 顶分隔");
});

test("融合:线稿水印转向 text-primary 混色(亮色可辨),pills 描边提强", () => {
  const css = readSrc("app/styles/fusion.css");
  const deco = cssBlock(css, ".fusion-card-deco");
  assert.ok(deco.includes("var(--text-primary)"), "线稿水印未转向 text-primary 混色");
  assert.ok(!deco.includes("var(--accent) 15%"), "旧 accent 15% 隐形线稿残留");

  const tag = cssBlock(css, ".fusion-tag");
  assert.ok(tag.includes("border-color: var(--border-strong)"), "pills 描边未提强到 border-strong");
});

/* ── ⑥ 作品库(splitCardTitle + 卡脚结构 + 工具行) ── */
test("splitCardTitle:超分元信息串拆分(标题=语义首段,副标=元信息)", () => {
  const out = splitCardTitle({
    kind: "video_upscale",
    prompt: "视频超分 4K · 1344×768 → 3840×2160 · 48帧@24fps",
  });
  assert.equal(out.title, "视频超分 4K");
  assert.equal(out.meta, "1344×768 → 3840×2160 · 48帧@24fps");
});

test("splitCardTitle:普通提示词不拆(用户文本含「 · 」不误伤),无副标", () => {
  const userPrompt = splitCardTitle({ kind: "txt2img", prompt: "一只猫 · 赛博朋克 · 夜景" });
  assert.equal(userPrompt.title, "一只猫 · 赛博朋克 · 夜景");
  assert.equal(userPrompt.meta, null);
  // 超分作业无元信息分段(初始「视频超分 4K」)也不出副标
  const noMeta = splitCardTitle({ kind: "video_upscale", prompt: "视频超分 4K" });
  assert.equal(noMeta.title, "视频超分 4K");
  assert.equal(noMeta.meta, null);
  // 空 prompt 兜底
  assert.equal(splitCardTitle({ kind: "video_upscale", prompt: "" }).title, "");
});

test("LibraryView 卡脚:标题/副标结构 + library.css 副标规则", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("splitCardTitle(job)"), "卡片未接 splitCardTitle 拆分");
  assert.ok(src.includes('className="lib-card-sub"'), "副标元信息行未渲染");
  assert.ok(src.includes("cardText.title"), "标题位未用拆分后的语义首段");

  const css = readSrc("app/styles/library.css");
  const sub = cssBlock(css, ".lib-card-sub");
  assert.ok(sub.includes("font-size: var(--text-label)"), "副标未走 label 档");
  assert.ok(sub.includes("var(--text-muted)"), "副标未走 muted");
  // 来源+时间戳提色(审计 P2 偏淡)
  const kind = cssBlock(css, ".lib-kind");
  assert.ok(kind.includes("color: var(--text-secondary)"), "来源标注未提到 secondary");
  const time = cssBlock(css, ".lib-time");
  assert.ok(time.includes("color: var(--text-secondary)"), "时间戳未提到 secondary");
});
