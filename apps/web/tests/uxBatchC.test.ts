/**
 * UX 精修批 C 单测(2026-08-30,对照 docs/2026-08-30-ux-research-report.md P1-8/P1-9 + P2):
 * ① lib/agents.listAgents:失败抛错(HTTP/网络),不再静默返回 [](fetch 桩直测 + 源码断言)
 * ② StudioView:项目列表三态(骨架/ErrorBar+重试/空态),不再失败静默成空列表
 * ③ StoryboardStage:删除分镜走 ui/Modal 确认门;AssemblyStage 无分镜引导空态
 * ④ ScriptStage/CastStage:裸 studio-error 收敛 ErrorBar,裸控件收敛 ui/Input
 * ⑤ AvatarTalkView:形象列表不可达提示(与 modelsUnreachable 同标准)+ 结束对话 Modal 确认门
 * ⑥ LiveAssistantPanel:初始四路加载失败错误条+重试;违禁词删除 Modal 确认
 * ⑦ ImageEditView:PageHeader 死引用删除;运行中暴露「取消处理」(360° 环绕同钮覆盖 + 张数进度)
 * ⑧ VideoEditView:PageHeader 死引用删除;「清空重来」Modal 确认;导出耗时提示 + 中止按钮
 * ⑨ SkillMarketView:列表错误态+重试;删除确认 danger;window.prompt 兜底改 Modal;空 <p> 不渲染;
 *    移动端卡片操作钮 ≥44px(--touch-target)
 * ⑩ BottomNav:「更多」抽屉 useFocusTrap(Esc 关闭 + 焦点陷阱 + 焦点回位)+ aria-modal
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

/* ── ① listAgents 失败抛错 ── */

let fetchImpl: typeof fetch | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!fetchImpl) throw new Error("fetchImpl 未设置");
    return fetchImpl(input, init);
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
});

test("① listAgents:HTTP 500 抛错(带状态码),不再静默返回 []", async () => {
  fetchImpl = (async () =>
    new Response(JSON.stringify({ detail: "数据库连接失败" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const { listAgents } = await import("../lib/agents");
  await assert.rejects(listAgents(), /数据库连接失败/, "HTTP 错误须抛错透出 detail");
});

test("① listAgents:网络异常抛中文提示;成功路径仍归一化返回", async () => {
  fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const { listAgents } = await import("../lib/agents");
  await assert.rejects(listAgents(), /网络异常/, "网络错误须抛中文提示");

  fetchImpl = (async () =>
    new Response(
      JSON.stringify([{ id: "a1", name: "技能A", applies_to: "image,video", sort: 1 }]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  const list = await listAgents();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].applies_to, ["image", "video"], "逗号串须归一化为数组");
});

test("① agents.ts:listAgents 无静默 return [] 兜底(源码断言)", () => {
  const src = readSrc("lib/agents.ts");
  const fn = src.slice(src.indexOf("export async function listAgents"));
  const end = fn.indexOf("export async function getAgent");
  const body = fn.slice(0, end);
  assert.ok(!body.includes("return [];"), "listAgents 仍含静默空数组兜底");
  assert.ok(body.includes("throw"), "listAgents 须在失败路径抛错");
});

/* ── ② StudioView 项目列表三态 ── */

test("② StudioView:项目列表加载骨架 + 失败 ErrorBar/重试,不再静默成空态", () => {
  const src = readSrc("components/studio/StudioView.tsx");
  assert.ok(src.includes("listLoading"), "缺列表加载态");
  assert.ok(src.includes("listError"), "缺列表错误态");
  assert.ok(src.includes("LoadingBlock"), "加载态未走 LoadingBlock 骨架");
  assert.ok(src.includes("studio-list-error"), "失败态缺 ErrorBar+重试行容器");
  assert.ok(/>\s*重试\s*</.test(src), "缺重试按钮");
  assert.ok(!src.includes(".catch(() => setProjects([]))"), "失败静默置空残留");
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-list-error"), "studio.css 缺失败行样式");
});

/* ── ③ StoryboardStage 删除确认 + AssemblyStage 引导空态 ── */

test("③ StoryboardStage:删除分镜走 ui/Modal 确认门(danger)", () => {
  const src = readSrc("components/studio/stages/StoryboardStage.tsx");
  assert.ok(src.includes("confirmDeleteShot"), "缺删除确认态");
  assert.ok(src.includes('from "@/components/ui/Modal"'), "未引入 ui/Modal");
  assert.ok(src.includes("删除分镜"), "缺删除确认弹窗");
  assert.ok(src.includes('variant="danger"'), "确认键未用 danger 变体");
  // onDelete 不再直接删,而是打开确认门
  assert.ok(src.includes("onDelete={() => setConfirmDeleteShot(s)}"), "onDelete 未接确认门");
});

test("③ AssemblyStage:无分镜渲染引导空态(ui/Empty),不渲染空时间轴", () => {
  const src = readSrc("components/studio/stages/AssemblyStage.tsx");
  assert.ok(src.includes('from "@/components/ui/Empty"'), "未引入 ui/Empty");
  assert.ok(src.includes("d.shots.length === 0"), "缺无分镜分支");
  assert.ok(src.includes("还没有分镜可合成"), "缺引导空态标题");
  assert.ok(src.includes("新增分镜"), "引导文案未指路分镜阶段");
});

/* ── ④ stages 裸控件/裸错误收敛 ── */

test("④ ScriptStage/CastStage:studio-error 收敛 ErrorBar,裸控件收敛 ui/Input", () => {
  for (const rel of [
    "components/studio/stages/ScriptStage.tsx",
    "components/studio/stages/CastStage.tsx",
  ]) {
    const src = readSrc(rel);
    assert.ok(!src.includes('className="studio-error"'), `${rel} 仍有裸 studio-error`);
    assert.ok(src.includes('from "@/components/ui/ErrorBar"'), `${rel} 未引入 ErrorBar`);
    assert.ok(src.includes("<ErrorBar"), `${rel} 未渲染 ErrorBar`);
    assert.ok(src.includes('from "@/components/ui/Input"'), `${rel} 未引入 ui/Input`);
    assert.ok(!/<input\n/.test(src), `${rel} 仍有裸 <input>`);
    assert.ok(!/<select\n/.test(src), `${rel} 仍有裸 <select>`);
  }
  // ShotCard(分镜阶段卡片)同样收敛
  const card = readSrc("components/studio/ShotCard.tsx");
  assert.ok(card.includes('from "@/components/ui/Input"'), "ShotCard 未引入 ui/Input");
  assert.ok(!/<input\n/.test(card), "ShotCard 仍有裸 <input>");
  assert.ok(!/<select\n/.test(card), "ShotCard 仍有裸 <select>");
  assert.ok(!/<textarea\n/.test(card), "ShotCard 仍有裸 <textarea>");
});

/* ── ⑤ AvatarTalkView 形象不可达 + 结束对话确认 ── */

test("⑤ AvatarTalkView:形象列表失败标记不可达并与模型同标准提示", () => {
  const src = readSrc("components/avatartalk/AvatarTalkView.tsx");
  assert.ok(src.includes("avatarsUnreachable"), "缺 avatarsUnreachable 状态");
  assert.ok(src.includes("setAvatarsUnreachable(true)"), "catch 未标记不可达");
  assert.ok(src.includes("avatarsUnreachable={avatarsUnreachable}"), "未传入 SetupPanel");
  assert.ok(src.includes("形象列表加载失败"), "缺不可达提示文案");
  // 与模型区同一计数标准:加载中/不可用/n 个可用
  assert.ok(src.includes('"不可用"'), "形象计数缺「不可用」档");
});

test("⑤ AvatarTalkView:「结束对话」红色钮走 Modal 确认门", () => {
  const src = readSrc("components/avatartalk/AvatarTalkView.tsx");
  assert.ok(src.includes("confirmEnd"), "缺结束确认态");
  assert.ok(src.includes("onEnd={() => setConfirmEnd(true)}"), "结束按钮未接确认门");
  assert.ok(src.includes('title="结束对话"'), "缺结束确认弹窗");
  assert.ok(src.includes('from "@/components/ui/Modal"'), "未引入 ui/Modal");
});

/* ── ⑥ LiveAssistantPanel 初始加载错误条 + 违禁词删除确认 ── */

test("⑥ LiveAssistantPanel:初始四路加载失败透出板块名 + 重试", () => {
  const src = readSrc("components/avatartalk/LiveAssistantPanel.tsx");
  assert.ok(src.includes("initError"), "缺初始加载错误态");
  assert.ok(src.includes("loadInitial"), "初始加载未收敛为可重试函数");
  assert.ok(src.includes('markFailed("形象模板")'), "形象模板失败未透出");
  assert.ok(src.includes('markFailed("知识库")'), "知识库失败未透出");
  assert.ok(src.includes('markFailed("违禁词")'), "违禁词失败未透出");
  assert.ok(src.includes("at-live-init-error"), "缺错误条+重试容器");
  assert.ok(/>\s*重试\s*</.test(src), "缺重试按钮");
  assert.ok(!src.includes(".catch(() => {})"), "仍有静默空 catch");
});

test("⑥ LiveAssistantPanel:违禁词删除走 Modal 确认门", () => {
  const src = readSrc("components/avatartalk/LiveAssistantPanel.tsx");
  assert.ok(src.includes("confirmDeleteBanned"), "缺违禁词删除确认态");
  assert.ok(src.includes('onClick={() => setConfirmDeleteBanned(w)}'), "删除钮未接确认门");
  assert.ok(src.includes('title="删除违禁词"'), "缺删除违禁词弹窗");
  assert.ok(src.includes('from "@/components/ui/Modal"'), "未引入 ui/Modal");
});

/* ── ⑦ ImageEditView 取消 ── */

test("⑦ ImageEditView:PageHeader 死引用删除;运行中暴露「取消处理」", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(!src.includes("PageHeader"), "PageHeader 死引用残留");
  assert.ok(src.includes("cancelRun"), "缺 cancelRun");
  assert.ok(src.includes("stopTracking();"), "cancelRun 未复用 stopTracking 基建");
  assert.ok(src.includes("取消处理"), "运行中未暴露取消按钮");
  // 360° 环绕(同一 runTool 链):取消钮覆盖 + 张数进度提示
  assert.ok(src.includes("环绕序列生成中"), "环绕序列缺张数进度提示");
  assert.ok(
    src.includes("{proc.resultPaths.length}/{CAM3D_AZIMUTHS.length}"),
    "环绕进度未按已落地张数显示",
  );
});

/* ── ⑧ VideoEditView 导出中止 + 清空确认 ── */

test("⑧ VideoEditView:PageHeader 死引用删除;「清空重来」Modal 确认", () => {
  const src = readSrc("components/video-edit/VideoEditView.tsx");
  assert.ok(!src.includes("PageHeader"), "PageHeader 死引用残留");
  assert.ok(src.includes("confirmClear"), "缺清空确认态");
  assert.ok(src.includes("onClick={() => setConfirmClear(true)}"), "清空按钮未接确认门");
  assert.ok(src.includes('title="清空重来"'), "缺清空确认弹窗");
  assert.ok(src.includes('from "@/components/ui/Modal"'), "未引入 ui/Modal");
});

test("⑧ VideoEditView:导出 busy 态耗时提示增强 + 中止按钮(迟到结果丢弃)", () => {
  const src = readSrc("components/video-edit/VideoEditView.tsx");
  assert.ok(src.includes("abortRender"), "缺 abortRender");
  assert.ok(src.includes("中止导出"), "busy 态未暴露中止按钮");
  assert.ok(src.includes("elapsedSec"), "缺耗时秒数提示");
  assert.ok(src.includes("已用时"), "进度提示未含已用时");
  assert.ok(src.includes("renderAbortedRef"), "缺中止标志位");
  assert.ok(src.includes("if (renderAbortedRef.current) return;"), "迟到结果未丢弃");
});

/* ── ⑨ SkillMarketView + skills.css ── */

test("⑨ SkillMarketView:列表失败错误态+重试;PageHeader 死引用删除", () => {
  const src = readSrc("components/skills/SkillMarketView.tsx");
  assert.ok(!src.includes("PageHeader"), "PageHeader 死引用残留");
  assert.ok(src.includes("loadError"), "缺列表错误态");
  assert.ok(src.includes("skill-load-error"), "缺错误态+重试容器");
  assert.ok(/>\s*重试\s*</.test(src), "缺重试按钮");
});

test("⑨ SkillMarketView:删除确认键 danger;window.prompt 兜底改 Modal", () => {
  const src = readSrc("components/skills/SkillMarketView.tsx");
  assert.ok(!src.includes("window.prompt"), "window.prompt 兜底残留");
  assert.ok(src.includes("shareFallback"), "缺分享兜底 Modal 态");
  // 删除确认弹窗的确认键必须是 danger
  const modalIdx = src.indexOf('title="删除技能"');
  assert.ok(modalIdx > 0, "缺删除确认弹窗");
  const deleteBlock = src.slice(modalIdx, src.indexOf("</Modal>", modalIdx));
  assert.ok(deleteBlock.includes('variant="danger"'), "删除确认键未用 danger 变体");
  assert.ok(!deleteBlock.includes('variant="primary"'), "删除确认键不得是 primary");
});

test("⑨ SkillMarketView:内置技能区空 empty 文案不渲染空 <p>", () => {
  const src = readSrc("components/skills/SkillMarketView.tsx");
  assert.ok(src.includes('empty=""'), "内置技能区应传空 empty(验证条件渲染)");
  assert.ok(
    src.includes("empty ? (") || src.includes("empty &&"),
    "空 empty 文案未做条件渲染(会产出空 <p>)",
  );
});

test("⑨ skills.css:移动端卡片操作钮 ≥44px(--touch-target),24px 档清除", () => {
  const css = readSrc("app/styles/skills.css");
  const iMedia = css.indexOf("@media (max-width: 575px)");
  assert.ok(iMedia > 0, "缺窄屏媒体查询");
  const block = css.slice(iMedia);
  assert.ok(block.includes("var(--touch-target)"), "移动端操作钮未走 --touch-target(44px)");
  assert.ok(!block.includes("width: 24px"), "24px 触达档残留");
  // 2026-09-04 美化 W4:SkillMarketView 内联 styled-jsx 块已整体删除(与 skills.css
  // 重复且作用域不一致),44px 约束单一来源即本文件级样式;此处只钉「不再复活内联块」
  const view = readSrc("components/skills/SkillMarketView.tsx");
  assert.ok(!view.includes("<style jsx>"), "内联 styled-jsx 块不得复活(与 skills.css 双源漂移)");
  assert.ok(!view.includes("width: 24px"), "24px 档残留");
});

/* ── ⑩ BottomNav 抽屉 a11y ── */

test("⑩ BottomNav:「更多」抽屉 Esc 关闭 + 焦点陷阱(useFocusTrap)+ aria-modal", () => {
  const src = readSrc("components/nav/BottomNav.tsx");
  assert.ok(src.includes('from "@/hooks/useFocusTrap"'), "未引入 useFocusTrap");
  assert.ok(src.includes("useFocusTrap(sheetRef, moreOpen"), "抽屉未接焦点陷阱");
  assert.ok(src.includes("ref={sheetRef}"), "sheet 未挂 ref");
  assert.ok(src.includes("aria-modal={moreOpen || undefined}"), "缺 aria-modal");
  assert.ok(src.includes('role="dialog"'), "缺 role=dialog");
});
