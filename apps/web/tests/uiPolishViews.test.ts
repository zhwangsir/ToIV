/**
 * 视图批 1 UI 排版优化单测(2026-08-16,Team B:工作台+首页+融合+作品库):
 * ① stage.css 空态降权:主标题 display 档 → --text-title,描述行 --text-body + --leading-loose,
 *    引导卡序号墨丸化(accent 墨底白字),段控轨道下沉
 * ② GenerateView 引擎说明(2026-08-17 T2 重构):描述/出处收进 ⓘ 说明卡(Popover+EngineInfoCard),
 *    面板首屏不再平铺;卡内渲染断言见 generateInspector.test.ts
 * ③ AudioView 页头一致:PageHeader 不再夹带段控,生成/编辑段控移到内容区首行并补图标
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
test("AudioView 页头:PageHeader 不夹带段控,生成/编辑段控在内容区首行且带图标", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  const header = src.match(/<PageHeader[\s\S]*?\/>/);
  assert.ok(header, "AudioView 缺 PageHeader");
  assert.ok(!header[0].includes("actions="), "音频页头仍夹带段控(与图片/视频工作台不一致)");
  assert.ok(header[0].includes('kicker="SOUND ATELIER"'), "音频页头 kicker 缺失");
  // 段控移到内容区首行(页头之后),按钮带图标(与 图像|视频 段控同语言)
  const iHeaderEnd = src.indexOf("/>", src.indexOf("<PageHeader"));
  const iModeRow = src.indexOf('className="audio-mode-row"');
  assert.ok(iModeRow > iHeaderEnd, "段控行未位于页头之后");
  assert.ok(src.includes('aria-label="音频模式"'), "段控 aria-label 缺失");
  assert.ok(
    src.includes('name={k === "gen" ? "sparkles" : "scissors"}'),
    "段控按钮未补图标",
  );
});

/* ── ④ 首页门户(AssistantView + assistant.css) ── */
test("首页门户:引擎胶囊行补「引擎状态」语义化小标题(labelledby 关联)", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes('className="av-eng-block"'), "引擎胶囊行缺语义块容器");
  assert.ok(src.includes('className="av-eng-label"'), "缺「引擎状态」可见小标题");
  assert.ok(src.includes('aria-labelledby="av-eng-label"'), "胶囊行未关联可见标签");
  assert.ok(!src.includes('aria-label="引擎状态"'), "旧 aria-label 残留(与可见标签重复播报)");

  const css = readSrc("app/styles/assistant.css");
  const label = cssBlock(css, ".av-eng-label");
  assert.ok(label.includes("font-size: var(--text-label)"), "引擎状态小标题未走 label 档");
  assert.ok(label.includes("var(--text-muted)"), "引擎状态小标题未走 muted");
});

test("首页门户:垂直节奏收紧(顶距 --space-6),底部呼吸保留(提示词卡不被裁)", () => {
  const css = readSrc("app/styles/assistant.css");
  const portal = cssBlock(css, ".av-empty.av-portal");
  assert.ok(portal.includes("padding-top: var(--space-6)"), "门户顶距未收到 --space-6");
  assert.ok(portal.includes("padding-bottom: var(--space-12)"), "门户底部呼吸被误删");
  assert.ok(portal.includes("gap: var(--space-5)"), "门户区隔未收紧到 --space-5");
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
