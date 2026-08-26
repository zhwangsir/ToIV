/**
 * P1 全局主体库(2026-08-26)单测(node:test,无 DOM):
 * ① EntitiesView 初始渲染(SSR 首帧):页头标题/新建入口/三类 tab/加载骨架
 * ② EntityPicker 空库态(SSR):空库引导文案 + 页脚按钮
 * ③ 源码断言:三类 tab/卡片网格/新建编辑删除/删除二次确认/三视图槽位(仅角色)
 * ④ GenerateView 接线源码断言:主体引用区/EntityPicker/resolveEntityRefs 钉 worker 注入
 * ⑤ api.ts 契约:listEntities/createEntity/updateEntity/deleteEntity/resolveEntityRefs 路径与方法
 * ⑥ mocks/studioApi.ts 替身可调用(链接期形状)
 * 说明:EntitiesView 经 tests/loader.mjs 把 @/lib/api 映射到 mocks/studioApi.ts;
 * useEffect 不跑,初始渲染 loading=true,骨架与页头可见,正好覆盖①。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EntitiesView } from "../components/entities/EntitiesView";
import { EntityPicker } from "../components/entities/EntityPicker";
import { ToastProvider } from "../components/ui/Toast";
import { entityImpl, entityCalls, listEntities, createEntity, makeEntity, resetEntityImpl } from "./mocks/studioApi";

const h = React.createElement;
const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① EntitiesView 初始渲染(SSR 首帧 = 加载骨架) ── */
test("EntitiesView:页头/新建主体入口/三类 tab/加载骨架渲染", () => {
  const html = renderToStaticMarkup(h(ToastProvider, null, h(EntitiesView, null)));
  assert.match(html, /主体库/, "缺少页头标题");
  assert.match(html, /新建主体/, "缺少新建入口按钮");
  assert.match(html, /角色 \(0\)/, "缺少角色 tab");
  assert.match(html, /场景 \(0\)/, "缺少场景 tab");
  assert.match(html, /道具 \(0\)/, "缺少道具 tab");
  assert.match(html, /ui-loading/, "缺少加载骨架");
});

/* ── ② EntityPicker 空库态(SSR) ── */
test("EntityPicker:空库引导文案 + 页脚引用按钮", () => {
  const html = renderToStaticMarkup(
    h(ToastProvider, null, h(EntityPicker, {
      open: true,
      onClose: () => {},
      selectedIds: [],
      onConfirm: () => {},
    })),
  );
  assert.match(html, /引用主体/, "缺少弹窗标题");
  assert.match(html, /主体库为空/, "空库态未引导先去创建");
});

/* ── ③ EntitiesView 源码断言 ── */
test("EntitiesView:卡片网格/编辑/删除二次确认/三视图仅角色(源码断言)", () => {
  const src = readSrc("components/entities/EntitiesView.tsx");
  assert.ok(src.includes("ent-grid"), "缺卡片网格");
  assert.ok(src.includes("编辑"), "缺编辑入口");
  assert.ok(src.includes("确认删除"), "删除缺二次确认");
  assert.ok(src.includes("preventClose={deleteBusy}"), "删除中未锁弹窗");
  // 三视图(正面/侧面/背面)只在 character 类别渲染:{isCharacter ? ( ... label="三视图"
  assert.ok(src.includes("isCharacter"), "缺角色类别判定");
  const gateIdx = src.indexOf("{isCharacter ? (");
  assert.ok(gateIdx > 0 && src.slice(gateIdx, gateIdx + 600).includes('label="三视图"'),
    "三视图槽位未按角色类别门控");
  // styled-jsx 作用域教训(P-2b):多组件文件必须 global + ent- 前缀
  assert.ok(src.includes("<style jsx global>"), "多组件文件未用 style jsx global");
});

/* ── ④ GenerateView 接线(源码断言) ── */
test("GenerateView:主体引用区 + EntityPicker + resolveEntityRefs 钉 worker 注入(源码断言)", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("主体引用"), "缺主体引用参数区");
  assert.ok(src.includes("EntityPicker"), "未接入主体多选器");
  assert.ok(src.includes("resolveEntityRefs"), "未调 resolve-refs 钉 worker 解析");
  assert.ok(src.includes("entityRefFiles"), "缺 entity→注入文件名映射(chip 移除摘除参考图)");
  // 提示词注入:prompt_hint 空回退 description
  assert.ok(src.includes("e.prompt_hint || e.description"), "prompt_hint 未回退 description");
});

/* ── ⑤ api.ts 契约 ── */
test("api.ts:entities 五端点路径与方法契约(源码断言)", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("apiFetch(`/api/entities${qs}`"), "listEntities 路径错误");
  assert.ok(src.includes("apiFetch(`/api/entities/${id}`"), "单 id 端点路径错误");
  assert.ok(src.includes("apiFetch(`/api/entities/resolve-refs`"), "resolve-refs 路径错误");
  const createIdx = src.indexOf("createEntity");
  assert.ok(src.slice(createIdx, createIdx + 300).includes('method: "POST"'), "createEntity 非 POST");
  const updateIdx = src.indexOf("updateEntity");
  assert.ok(src.slice(updateIdx, updateIdx + 300).includes('method: "PUT"'), "updateEntity 非 PUT");
  const deleteIdx = src.indexOf("deleteEntity");
  assert.ok(src.slice(deleteIdx, deleteIdx + 300).includes('method: "DELETE"'), "deleteEntity 非 DELETE");
});

/* ── ⑥ mock 替身形状(链接期) ── */
test("mocks/studioApi:entities 替身可调用且计数", async () => {
  resetEntityImpl();
  entityImpl.listEntities = async () => [makeEntity("e1", { name: "阿明" })];
  const rows = await listEntities();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "阿明");
  const created = await createEntity({ name: "新主体", kind: "scene" });
  assert.equal(created.kind, "scene");
  assert.equal(entityCalls.listEntities, 1);
  assert.equal(entityCalls.createEntity, 1);
  resetEntityImpl();
});
