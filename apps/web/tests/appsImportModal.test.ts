/**
 * 应用市场 M5 智能导入视图单测(node:test + react-dom/server 静态渲染 + 源码断言,
 * 同 appsViews.test.ts 范式):
 * ① AppImportModal 静态渲染:open 时第一步(拖拽上传区 + 粘贴域 + 开始解析);
 *    open=false 不渲染(Modal 返回 null)
 * ② 三步流转源码断言:input → parsing(分步提示 + preventClose)→ preview
 * ③ 错误分支:JSON.parse 即时红字 / 503·429 归一文案 + 重试 + 返回修改
 * ④ 草稿预览:ParamField 复用、overrides 三字段可改、warnings 黄条
 * ⑤ 确认链:confirmImport(draft_id, buildImportOverrides) → toast + onImported 刷新
 * ⑥ AppMarketView 接线:「智能导入」按钮 loggedIn 门控 + Modal 挂载
 * ⑦ apps.css:apps-import-* 类齐全 + token 纪律(零 hex + warn token)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppImportModal } from "../components/apps/AppImportModal";
import { ToastProvider } from "../components/ui/Toast";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

const modalSrc = () => readSrc("components/apps/AppImportModal.tsx");

/* ── ① 静态渲染 ── */

test("AppImportModal open 渲染第一步:拖拽上传区 + 粘贴域 + 开始解析", () => {
  const html = renderToStaticMarkup(
    h(ToastProvider, null, h(AppImportModal, { open: true, onClose: () => {}, onImported: () => {} })),
  );
  assert.ok(html.includes("智能导入工作流"), "缺 Modal 标题");
  assert.ok(html.includes("拖拽 .json 工作流文件到此处,或点击选择文件"), "缺拖拽上传区");
  assert.ok(html.includes('type="file"'), "缺文件点选 input");
  assert.ok(html.includes("或粘贴工作流 JSON"), "缺粘贴域");
  assert.ok(html.includes("开始解析"), "缺第一步提交按钮");
});

test("AppImportModal open=false 不渲染(Modal 返回 null)", () => {
  const html = renderToStaticMarkup(
    h(ToastProvider, null, h(AppImportModal, { open: false, onClose: () => {}, onImported: () => {} })),
  );
  assert.ok(!html.includes("modal-overlay"), "关闭时不应渲染弹层");
});

/* ── ② 三步流转 ── */

test("AppImportModal 三步流转:input → parsing → preview(源码)", () => {
  const src = modalSrc();
  assert.ok(src.includes('useState<Step>("input")'), "初始步应为 input");
  assert.ok(src.includes('setStep("parsing")'), "提交后应进 parsing");
  assert.ok(src.includes('setStep("preview")'), "草稿返回后应进 preview");
  assert.ok(src.includes('step === "input" &&'), "缺第一步渲染分支");
  assert.ok(src.includes('step === "parsing" &&'), "缺第二步渲染分支");
  assert.ok(src.includes('step === "preview" && draft &&'), "缺第三步渲染分支");
  // 分步提示:解析节点 → AI 包装中(LLM 10-30s)
  assert.ok(src.includes("解析节点"), "缺「解析节点」分步提示");
  assert.ok(src.includes("AI 包装中"), "缺「AI 包装中」分步提示");
  // 解析进行中防误关(请求在途)
  assert.ok(src.includes("preventClose={busy || confirming}"), "parsing/confirming 应防误关");
});

/* ── ③ 错误分支 ── */

test("AppImportModal JSON.parse 失败即时红字(Field error 槽,源码)", () => {
  const src = modalSrc();
  assert.ok(src.includes("JSON 解析失败:"), "缺 JSON 解析失败红字");
  assert.ok(src.includes("JSON.parse(text)"), "粘贴/上传文本应即时 parse 校验");
  assert.ok(src.includes("error={parseError ?? undefined}"), "parseError 应接 Field error 红字槽");
  assert.ok(src.includes("工作流须为 JSON 对象"), "非对象 JSON(数组/标量)应拒绝");
  assert.ok(src.includes("仅支持 .json 工作流文件"), "非 .json 文件应拒绝");
});

test("AppImportModal 解析失败错误态:503/429 归一文案 + 重试 + 返回修改(源码)", () => {
  const src = modalSrc();
  assert.ok(src.includes("submitError"), "缺 submitError 错误态");
  assert.ok(src.includes("重试"), "缺重试按钮");
  assert.ok(src.includes("返回修改"), "缺返回修改(回第一步)");
  assert.ok(src.includes('role="alert"'), "错误应 role=alert 可读");
  // 503/429 文案由 lib/apps 归一(importWorkflow 长请求档)
  const lib = readSrc("lib/apps.ts");
  assert.ok(lib.includes("AI 包装服务暂不可用"), "lib 缺 503 专属文案");
  assert.ok(lib.includes("每分钟限 5 次"), "lib 缺 429 限流文案");
  assert.ok(lib.includes("res.status === 503 || res.status === 429"), "lib 缺 503/429 分支");
  assert.ok(lib.includes("longRequest: true"), "LLM 10-30s 应走 longRequest 超时档");
});

/* ── ④ 草稿预览 ── */

test("AppImportModal 预览复用 generate/ParamField 渲染 params_schema,不私造仿写件(源码)", () => {
  const src = modalSrc();
  assert.ok(
    src.includes('import { ParamField } from "@/components/generate/ParamField"'),
    "应直接复用 generate/ParamField",
  );
  assert.ok(src.includes("<ParamField"), "params_schema 应经 ParamField 渲染");
  assert.ok(!/function AppImportParamField|const AppImportParamField/.test(src), "不应私造参数渲染件");
  assert.ok(src.includes("该工作流未识别出可调参数"), "缺零参数空态");
});

test("AppImportModal 信息卡:名称/描述/图标可改(overrides)+ 分类/产出展示 + warnings 黄条(源码)", () => {
  const src = modalSrc();
  // overrides 三字段可改
  assert.ok(src.includes("名称"), "缺名称编辑");
  assert.ok(src.includes("描述"), "缺描述编辑");
  assert.ok(src.includes("图标(lucide 名)"), "缺图标编辑");
  // 分类/产出/参数数只读展示
  assert.ok(src.includes("appCategoryLabel(draft.category)"), "缺分类展示");
  assert.ok(src.includes("OUTPUT_KIND_LABEL[draft.output_kind]"), "缺产出类型展示");
  // warnings 黄条
  assert.ok(src.includes("apps-import-warnings"), "缺 warnings 容器");
  assert.ok(src.includes("draft.warnings.map"), "warnings 应逐条渲染");
  assert.ok(src.includes("apps-import-warning"), "缺单条 warning 黄条");
});

/* ── ⑤ 确认链 ── */

test("AppImportModal 确认链:confirmImport(draft_id, 差异 overrides) → toast + 关闭 + onImported(源码)", () => {
  const src = modalSrc();
  assert.ok(
    src.includes("confirmImport(draft.draft_id, buildImportOverrides(draft, edits))"),
    "confirm 应只上送与草稿不同的 overrides",
  );
  assert.ok(src.includes("toast.success"), "上架成功应 toast");
  assert.ok(src.includes("handleClose()"), "成功后应关闭弹窗");
  assert.ok(src.includes("onImported(app)"), "成功后应回调刷新市场");
  assert.ok(src.includes("确认上架"), "缺确认上架按钮");
  // 404 草稿过期:confirmError + 重新导入回第一步
  assert.ok(src.includes("confirmError"), "缺 confirm 错误态");
  assert.ok(src.includes("重新导入"), "404 草稿过期应给「重新导入」回第一步");
});

/* ── ⑥ AppMarketView 接线 ── */

test("AppMarketView 「智能导入」按钮:仅登录态可见 + Modal 接线 + 导入成功刷新(源码)", () => {
  const src = readSrc("components/apps/AppMarketView.tsx");
  assert.ok(src.includes('import { AppImportModal } from "./AppImportModal"'), "未挂载 AppImportModal");
  assert.ok(src.includes("智能导入"), "缺「智能导入」按钮");
  assert.ok(src.includes("{loggedIn && ("), "按钮应仅登录态渲染");
  assert.ok(src.includes('import { getToken, TOKEN_KEY } from "@/lib/api"'), "登录态应读 token");
  assert.ok(src.includes("useCrossTabSync(TOKEN_KEY"), "跨页退出登录应同步隐藏按钮");
  assert.ok(src.includes("<AppImportModal"), "缺 Modal 渲染");
  assert.ok(src.includes("onImported={() => void refresh()}"), "导入成功应刷新市场列表(我的区)");
});

/* ── ⑦ apps.css ── */

test("apps.css:apps-import-* 类齐全 + token 纪律(零 hex + warn 黄条 token)", () => {
  const css = readSrc("app/styles/apps.css");
  for (const cls of [
    ".apps-import-drop",
    ".apps-import-json",
    ".apps-import-progress",
    ".apps-import-steps",
    ".apps-import-preview",
    ".apps-import-form",
    ".apps-import-info",
    ".apps-import-warnings",
    ".apps-import-warning",
    ".apps-import-confirm-error",
  ]) {
    assert.ok(css.includes(cls), `apps.css 缺 ${cls} 定义`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "apps.css 存在硬编码 hex 色值");
  assert.ok(css.includes("var(--warn-soft)"), "warnings 黄条应走 warn-soft token");
  assert.ok(css.includes("var(--warn)"), "warnings 文字应走 warn token");
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*(1024|1280)px\)/, "断点须 -1 约定");
});
