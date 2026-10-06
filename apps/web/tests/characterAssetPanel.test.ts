/**
 * 角色资产协议 web 侧:lib/api 契约 + CastStage 入口 + CharacterAssetPanel(源码断言)。
 * 协议 docs/ops/CHARACTER_ASSET_PROTOCOL.md(2026-10-06,M1 web 波)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("api.ts:角色资产契约(4 端点)", () => {
  const api = readSrc("lib/api.ts");
  assert.ok(api.includes("getStudioCharacterAsset"), "缺 GET 方法");
  assert.ok(api.includes("putStudioCharacterAsset"), "缺 PUT 方法");
  assert.ok(api.includes("renderStudioCharacterAssetCard"), "缺展示卡方法");
  assert.ok(api.includes("studioCharacterAssetCoveragePlan"), "缺覆盖计划方法");
  assert.ok(
    api.includes("/studio/characters/${cid}/character-asset"),
    "资产路径不对",
  );
  assert.ok(api.includes("StudioCharacterAssetAnchor"), "缺锚点类型");
  assert.ok(
    api.includes("encodeURIComponent(style)"),
    "GET style 须编码",
  );
});

test("CastStage:资产入口与面板挂载", () => {
  const src = readSrc("components/studio/stages/CastStage.tsx");
  assert.ok(src.includes("CharacterAssetPanel"), "未挂资产面板");
  assert.ok(src.includes('data-testid="studio-asset-open"'), "缺资产入口按钮");
  assert.ok(src.includes("assetOpen"), "缺面板开关状态");
});

test("CharacterAssetPanel:协议核心能力齐备", () => {
  const src = readSrc("components/studio/CharacterAssetPanel.tsx");
  // 锚点数据化编辑
  assert.ok(src.includes("ANCHOR_KIND_LABELS"), "缺锚点 kind 词表");
  assert.ok(src.includes("identity_anchors"), "未提交锚点字段");
  assert.ok(src.includes('data-testid="studio-asset-anchor-add"'), "缺加锚点");
  assert.ok(src.includes("anchors.length >= 10"), "锚点须上限 10");
  // 档案编辑
  assert.ok(src.includes("speech_style"), "档案须含口吻字段");
  // 覆盖登记与缺口
  assert.ok(src.includes('studio-asset-chip${tone === "gap" ? " is-gap" : ""}'), "缺缺口 chip 逻辑");
  assert.ok(src.includes("studioCharacterAssetCoveragePlan"), "须接覆盖计划端点");
  // 展示卡
  assert.ok(src.includes('data-testid="studio-asset-card-btn"'), "缺展示卡按钮");
  assert.ok(src.includes("imageUrl(cardUrl)"), "展示卡须经 imageUrl 取图");
  // 版本/溯源展示
  assert.ok(src.includes("derived_from"), "须展示版本溯源");
  assert.ok(src.includes("materialized_now"), "回填提示须消费 materialized_now");
  // 回填零人工:GET 自动物化由服务端负责,前端不提供「创建资产」类入口
  assert.ok(!src.includes("createStudioCharacterAsset"), "不得有创建型入口");
});

test("studio.css:资产面板样式存在且前缀隔离", () => {
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-asset {"), "缺根样式");
  assert.ok(css.includes(".studio-asset-chip.is-gap"), "缺缺口样式");
  assert.ok(css.includes(".studio-asset-card-img"), "缺展示卡预览样式");
});
