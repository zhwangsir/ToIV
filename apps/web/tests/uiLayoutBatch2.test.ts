/**
 * UI 排版优化批 2 · Team C 领地(2026-08-16 生产截图审计驱动)单测(node:test):
 * ① models:行徽章去重(SAFETENSORS 扩展名徽章删,仅留类型徽章)+ 行高收紧
 * ② settings:账户卡横向紧凑行(头像+邮箱+退出按钮)+ 18+ 徽章与开关收拢
 * ③ agent-runs:进度计数降档(--text-aux 副标位)+ 容器宽 token + 标题两行截断
 * ④ studio:项目副标行(#短id+更新时间+进度)+ 行边框 --border-strong + hover accent
 * ⑤ avatartalk:主区空态三步式(图标→标题→CTA)+ 状态 pill 移页头 + 缩略图统一 3:4
 * (⑥ drama-workbench 四例已随 2026-09-03 W4 drama 死链删除退役)
 * 说明:渲染断言仅用于可在 node 静态渲染的组件(SettingsView 等,effect 不执行);
 * 结构性变更以源码断言钉死(与 uiBViews/uiFixes 同手法)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/** 截取 CSS 规则块(选择器起始到首个换行右花括号)。 */
function cssBlock(css: string, selector: string): string {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `缺少选择器 ${selector}`);
  const j = css.indexOf("\n}", i);
  return css.slice(i, j >= 0 ? j : css.length);
}

/* ── ① models:行徽章去重 + 行高收紧 ── */

test("models:模型行仅保留类型徽章(扩展名徽章已删),行高 padding 减一档", () => {
  const src = readSrc("components/models/ModelsView.tsx");
  assert.ok(!src.includes("mv-model-ext"), "扩展名(SAFETENSORS)徽章应删除(文件名已带后缀)");
  assert.ok(!src.includes("fileExt("), "fileExt 辅助函数应随徽章一并移除");
  assert.equal(
    (src.match(/mv-model-type/g) ?? []).length >= 2,
    true,
    "类型徽章 mv-model-type 保留(渲染 + 样式)",
  );
  const row = cssBlock(src, ".mv-model-row {");
  assert.ok(
    row.includes("padding: var(--space-1) var(--space-2);"),
    `行高密度应收紧一档,实际: ${row}`,
  );
});

/* ── ② settings:账户紧凑行 + 18+ 收拢(渲染断言) ── */

test("settings:账户卡渲染横向紧凑行(头像 → 邮箱 → 退出按钮)", async () => {
  const { SettingsView } = await import("../components/settings/SettingsView");
  const html = renderToStaticMarkup(
    h(SettingsView, { account: "merlin@toiv.local", onLogout: () => {} }),
  );
  assert.match(html, /settings-account-row/);
  assert.match(html, /settings-account-avatar/);
  assert.match(html, /settings-account-mail/);
  assert.match(html, /merlin@toiv\.local/);
  // 行内顺序:头像 → 邮箱 → 退出按钮
  const iRow = html.indexOf("settings-account-row");
  const iAvatar = html.indexOf("settings-account-avatar", iRow);
  const iMail = html.indexOf("settings-account-mail", iRow);
  const iLogout = html.indexOf("退出登录", iRow);
  assert.ok(iAvatar > 0 && iAvatar < iMail, "头像须在邮箱之前");
  assert.ok(iMail < iLogout, "邮箱须在退出按钮之前");
  // 旧单行键值/独立操作条不再用于账户卡
  assert.ok(!html.includes("settings-actions"), "账户卡不再用独立 settings-actions 操作条");
});

test("settings:18+ 徽章与开关收拢于同一行(渲染断言 + 样式间距 --space-2)", async () => {
  const { SettingsView } = await import("../components/settings/SettingsView");
  const html = renderToStaticMarkup(h(SettingsView, { account: "a@b.c", onLogout: () => {} }));
  const iSide = html.indexOf("settings-r18-side");
  assert.ok(iSide > 0, "缺 settings-r18-side 收拢容器");
  const iBadge = html.indexOf("settings-r18-badge", iSide);
  const iSwitch = html.indexOf("settings-r18-switch", iSide);
  assert.ok(iBadge > iSide && iSwitch > iBadge, "徽章与开关须同处收拢容器内");
  // 徽章不再挂在卡片标题里
  const head = html.slice(0, html.indexOf("settings-r18-row"));
  assert.ok(!head.includes("settings-r18-badge"), "18+ 徽章不应留在卡片标题行");

  const css = readSrc("app/styles/settings.css");
  const side = cssBlock(css, ".settings-r18-side {");
  assert.ok(side.includes("gap: var(--space-2);"), "徽章与开关行内间距须为 --space-2");
});

test("settings:账户紧凑行样式(头像 accent-soft 底托 + 邮箱截断)", () => {
  const css = readSrc("app/styles/settings.css");
  const row = cssBlock(css, ".settings-account-row {");
  assert.ok(row.includes("display: flex;") && row.includes("align-items: center;"), row);
  const avatar = cssBlock(css, ".settings-account-avatar {");
  assert.ok(avatar.includes("background: var(--accent-soft);"), "头像底托与分区图标同款");
  const mail = cssBlock(css, ".settings-account-mail {");
  assert.ok(mail.includes("text-overflow: ellipsis;"), "长邮箱须截断");
  assert.ok(!css.includes(".settings-actions"), "settings-actions 死样式应清除");
});

/* ── ③ agent-runs:进度降档 + 容器 token + 标题截断 ── */

test("agent-runs:进度计数降档副标位,右侧大数字栏已撤", () => {
  const page = readSrc("app/agent-runs/page.tsx");
  assert.ok(!page.includes("agent-run-side"), "右侧 Fraunces 大数字栏应移除");
  assert.ok(page.includes("agent-run-progress"), "进度计数保留在副标");
  // 进度与时间戳都在副标行内(区分信息)
  const iSub = page.indexOf("agent-run-sub");
  const iProgress = page.indexOf("agent-run-progress", iSub);
  const iDate = page.indexOf("agent-run-date", iSub);
  assert.ok(iProgress > iSub && iDate > iSub, "进度/时间戳须进副标行");

  const css = readSrc("app/styles/agent-runs.css");
  const progress = cssBlock(css, ".agent-run-progress {");
  assert.ok(progress.includes("font-size: var(--text-aux);"), `进度须降到 aux 档: ${progress}`);
  assert.ok(!progress.includes("--font-display"), "进度不得再用 Fraunces 展示字");
  assert.ok(!progress.includes("--text-title"), "进度不得再占标题档");
  assert.ok(!css.includes(".agent-run-side"), "agent-run-side 死样式应清除");
});

test("agent-runs:容器宽度收编版型令牌(2026-09-04 美化 W4:直连 --layout-wide)", () => {
  const css = readSrc("app/styles/agent-runs.css");
  const shell = cssBlock(css, ".agent-shell {");
  assert.ok(
    shell.includes("max-width: var(--layout-wide);"),
    `容器宽须走 --layout-wide 版型档: ${shell}`,
  );
});

test("agent-runs:历史标题最多两行 ellipsis(stripMarkdown 并存)", () => {
  const page = readSrc("app/agent-runs/page.tsx");
  assert.ok(page.includes("stripMarkdown(r.goal)"), "stripMarkdown 不得移除");
  const css = readSrc("app/styles/agent-runs.css");
  const goal = cssBlock(css, ".agent-run-goal {");
  assert.ok(goal.includes("-webkit-line-clamp: 2;"), "标题须 2 行 clamp");
  assert.ok(!goal.includes("white-space: nowrap"), "单行 nowrap 与两行截断互斥,应移除");
});

/* ── ④ studio:副标行 + 边框/hover ── */

test("studio:列表项副标行(#短id + 更新时间 + 进度)区分同名项目", () => {
  const src = readSrc("components/studio/StudioView.tsx");
  assert.ok(src.includes("studio-project-sub"), "缺副标行容器");
  assert.ok(src.includes("studio-project-id"), "缺 #短id");
  assert.ok(src.includes('`#${p.id.slice(0, 6)}`') || src.includes("#{p.id.slice(0, 6)}"), "短id 取前 6 位");
  assert.ok(src.includes("studio-project-stage"), "缺进度信息");
  assert.ok(src.includes("PROJECT_PROGRESS_STEP"), "进度须由状态阶梯推导");
  // 副标行在标题之后
  const iTitle = src.indexOf("studio-project-title");
  const iSub = src.indexOf("studio-project-sub");
  assert.ok(iSub > iTitle, "副标行须在标题之下");
});

test("studio:行边框亮色下加深 --border-strong,hover 统一 .at-card--interactive", () => {
  const css = readSrc("app/styles/studio.css");
  const card = cssBlock(css, ".studio-project-card {");
  assert.ok(card.includes("border-color: var(--border-strong);"), `静止态边框须 strong: ${card}`);
  // 2026-09-04 美化 W3:hover 反馈收编为共享 .at-card--interactive(border-strong+细影+轻抬),
  // 项目卡不再自写 accent 描边 hover 变体(删除钮 reveal 的 :hover 后代选择器不在此列)
  assert.ok(!css.includes(".studio-project-card:hover {"), "hover 须由 .at-card--interactive 供给,不再自写");
  const src = readSrc("components/studio/StudioView.tsx");
  assert.ok(src.includes("at-card at-card--interactive"), "项目卡须接 .at-card--interactive");
});

/* ── ⑤ avatartalk:空态三步式 + 状态移位 + 缩略图比例 ── */

test("avatartalk:主区空态三步式(大号图标 → 标题 → 引导按钮)", () => {
  const src = readSrc("components/avatartalk/AvatarTalkView.tsx");
  const iIcon = src.indexOf("at-placeholder-icon");
  const iTitle = src.indexOf("at-placeholder-title");
  const iCta = src.indexOf("at-placeholder-cta");
  assert.ok(iIcon > 0 && iTitle > iIcon && iCta > iTitle, "空态须为 图标→标题→CTA 三步式");
  // CTA 复用开始对话链路,禁用条件与右栏一致
  assert.ok(src.includes("void startSession()"), "CTA 须接 startSession");
  assert.ok(src.includes("!selectedAvatar || !selectedModel"), "CTA 禁用条件与开始按钮一致");
  const css = readSrc("app/styles/avatartalk.css");
  const cta = cssBlock(css, ".at-placeholder-cta {");
  assert.ok(cta.includes("pointer-events: auto;"), "placeholder 容器无指针事件,CTA 须自愈");
});

test("avatartalk:连接状态 pill 移入页头(舞台浮层已撤)", () => {
  const src = readSrc("components/avatartalk/AvatarTalkView.tsx");
  assert.ok(src.includes("at-conn-badge"), "页头缺 at-conn-badge");
  assert.ok(
    !src.includes('className="at-status-badge"'),
    "实时对话舞台不得再挂 at-status-badge 浮层(生成工作台自有,不在本断言)",
  );
  // pill 在 PageHeader actions 槽内
  const iActions = src.indexOf("actions={");
  const iBadge = src.indexOf("at-conn-badge");
  assert.ok(Math.abs(iBadge - iActions) < 400, "at-conn-badge 须在页头 actions 槽");
  const css = readSrc("app/styles/avatartalk.css");
  assert.ok(css.includes(".at-conn-badge"), "at-conn-badge 样式缺失");
});

test("avatartalk:形象缩略图统一 aspect-ratio 3:4(骨架同步)", () => {
  const css = readSrc("app/styles/avatartalk.css");
  const preview = cssBlock(css, ".at-avatar-preview {");
  assert.ok(preview.includes("aspect-ratio: 3 / 4;"), `缩略图须统一 3:4: ${preview}`);
  const skeleton = cssBlock(css, ".at-avatar-card-skeleton {");
  assert.ok(skeleton.includes("aspect-ratio: 2 / 3;"), "骨架比例须与真实卡同步");
});

