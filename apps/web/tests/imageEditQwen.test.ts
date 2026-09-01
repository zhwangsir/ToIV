/**
 * 智能编辑(Qwen-Image-Edit-2509)前端单测(node:test,无 DOM,源码断言风格):
 * ① ImageEditView 第 5 个工具注册 + 三参数控件(编辑指令/相机角度/档位)
 * ② runTool 走 generateQwenEdit + 空指令拦截
 * ③ api.ts 契约:generateQwenEdit 路径/方法/字段(camera 空时不传、fast 透传)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① 工具注册与控件 ── */
test("ImageEditView:第 5 个工具 智能编辑(Qwen) 已注册", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes('"qwenedit"'), "EditTool 缺 qwenedit");
  assert.ok(src.includes('key: "qwenedit"'), "TOOLS 缺 qwenedit 条目");
  assert.ok(src.includes("智能编辑(Qwen)"), "工具标题缺失");
  // 三参数:编辑指令 / 相机角度(含「无」)/ 快速与标准档
  assert.ok(src.includes("编辑指令"), "缺编辑指令输入");
  assert.ok(src.includes("QWEN_CAMERAS"), "缺相机角度预设");
  assert.ok(src.includes("无(仅语义编辑)"), "相机角度缺「无」选项");
  for (const v of ["forward", "rotate_left", "top_down", "wide", "closeup"]) {
    assert.ok(src.includes(`"${v}"`), `相机角度缺 ${v}`);
  }
  assert.ok(src.includes("QWEN_SPEEDS"), "缺档位切换");
  assert.ok(src.includes("快速(Lightning 8 步)"), "缺快速档标签");
  assert.ok(src.includes("标准(20 步"), "缺标准档标签");
});

/* ── ② runTool 调用 ── */
test("ImageEditView:runTool 走 generateQwenEdit 并拦截空指令", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes("generateQwenEdit"), "未引入 generateQwenEdit");
  const qwenCase = src.slice(src.indexOf('case "qwenedit"'));
  assert.ok(qwenCase.includes("请填写编辑指令"), "空指令未拦截");
  assert.ok(qwenCase.includes("positive: qwenPositive.trim()"), "positive 未透传");
  assert.ok(qwenCase.includes("camera: qwenCamera || undefined"), "camera 空值应传 undefined");
  assert.ok(qwenCase.includes('fast: qwenSpeed === "fast"'), "fast 档位映射错误");
});

/* ── ③ api.ts 契约 ── */
test("api.ts:generateQwenEdit 路径与字段", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("export async function generateQwenEdit"), "generateQwenEdit 未导出");
  assert.ok(src.includes("`/api/generate/qwen-edit`"), "路径错误");
  const fn = src.slice(src.indexOf("export async function generateQwenEdit"));
  assert.ok(fn.slice(0, 400).includes('method: "POST"'), "应为 POST");
  assert.ok(fn.includes("positive: params.positive"), "positive 未提交");
  assert.ok(fn.includes("camera: params.camera"), "camera 未提交");
  assert.ok(fn.includes("fast: params.fast"), "fast 未提交");
});

/* ── ④ 作品库选图(2026-08-24,二次创作) ── */
test("ImageEditView:作品库选图接 AssetPicker,转运句柄灌 source", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes("AssetPicker"), "未引入 AssetPicker");
  assert.ok(src.includes("从作品库选择"), "DropZone 缺作品库入口");
  assert.ok(src.includes("handlePickLibrary"), "缺选图回调");
  assert.ok(src.includes('assetType="image"'), "选择器类型应为 image");
  // blob 守卫:作品库选取的签名 URL 不可 revoke
  assert.ok(src.includes('startsWith("blob:")'), "缺 blob: revoke 守卫");
});

test("AvatarGenPanel:人像/音频均可从作品库选取,钉住对方 worker", () => {
  const src = readSrc("components/avatartalk/AvatarGenPanel.tsx");
  assert.ok(src.includes("AssetPicker"), "未引入 AssetPicker");
  assert.ok(src.includes("pickerFor"), "缺 pickerFor 状态");
  assert.ok(src.includes('setPickerFor("image")') && src.includes('setPickerFor("audio")'), "缺两类入口");
  assert.ok(src.includes('kind="avatar"'), "选择器 kind 应为 avatar");
  assert.ok(src.includes("pinWorker"), "缺同机钉定");
});

test("AvatarGenPanel:正向提示词接 OptimizeButton(kind=video, engine=avatar-talk)", () => {
  const src = readSrc("components/avatartalk/AvatarGenPanel.tsx");
  assert.ok(src.includes('from "@/components/ui/OptimizeButton"'), "未引入 OptimizeButton");
  assert.ok(src.includes('kind="video"'), "kind 应为 video");
  assert.ok(src.includes('engine="avatar-talk"'), "engine 应为 avatar-talk");
  assert.ok(src.includes("setPositive(text)"), "优化结果未回填正向提示词");
  assert.ok(src.includes("setNegative(neg)"), "negative 未回填高级参数负向");
});

test("page.tsx:导航数据不突变模块级常量(观测重复 bug 回归)", () => {
  const src = readSrc("app/page.tsx");
  assert.ok(!src.includes("islandItems.push("), "导航数组不得 push 突变(2026-08-24 观测×7)");
  assert.ok(!src.includes("bottomNavMoreItems.push("), "bottomNavMoreItems 不得 push 突变");
  assert.ok(!src.includes("RAIL_ITEMS.push("), "RAIL_ITEMS 不得 push 突变");
  // Studio Console v1:admin 项经 isAdmin 三元生成新数组(非共享常量追加)
  assert.ok(src.includes("railAdminItems"), "缺 railAdminItems");
});

/* ── ⑤ 3D 相机(2511,2026-08-24) ── */
test("ImageEditView:3D 相机工具注册 + 罗盘/俯仰/距离/环绕控件", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes('"camera3d"'), "EditTool 缺 camera3d");
  assert.ok(src.includes('key: "camera3d"'), "TOOLS 缺 camera3d 条目");
  assert.ok(src.includes("3D 相机(360°)"), "工具标题缺失");
  assert.ok(src.includes("CAM3D_AZIMUTHS"), "缺方位预设");
  assert.ok(src.includes("ie-cam3d-compass"), "缺方位罗盘");
  assert.ok(src.includes("cam3dOrbit"), "缺环绕序列开关");
  assert.ok(src.includes("ie-strip"), "缺环绕胶片条");
});

test("ImageEditView:camera3d 提交携带 azimuth/elevation/distance,环绕走 8 方位循环", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  const single = src.slice(src.indexOf('case "camera3d"'));
  assert.ok(single.includes("azimuth: cam3dAzimuth"), "单视角未传 azimuth");
  assert.ok(single.includes("elevation: cam3dElevation"), "未传 elevation");
  assert.ok(single.includes("distance: cam3dDistance"), "未传 distance");
  const orbit = src.slice(src.indexOf('tool === "camera3d" && cam3dOrbit'));
  assert.ok(orbit.includes("for (const az of CAM3D_AZIMUTHS)"), "环绕未遍历 8 方位");
  assert.ok(orbit.includes("TrackJobAbortError"), "环绕缺 abort 静默处理");
});

test("api.ts:generateQwenEdit 支持 3D 相机字段", () => {
  const src = readSrc("lib/api.ts");
  const fn = src.slice(src.indexOf("export async function generateQwenEdit"));
  assert.ok(fn.includes("azimuth: params.azimuth"), "azimuth 未提交");
  assert.ok(fn.includes("elevation: params.elevation"), "elevation 未提交");
  assert.ok(fn.includes("distance: params.distance"), "distance 未提交");
});

/* ── ⑥ AI 优化覆盖(2026-08-24,kind=qwen_edit 指令方言) ── */
test("ImageEditView:编辑指令与 3D 相机附加指令均接 OptimizeButton(kind=qwen_edit)", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes('from "@/components/ui/OptimizeButton"'), "未引入 OptimizeButton");
  // 两处接入:编辑指令(qwenPositive)+ 附加指令(cam3dNote)
  assert.ok(src.includes('kind="qwen_edit"'), "缺 kind=qwen_edit");
  const occurrences = src.split('kind="qwen_edit"').length - 1;
  assert.ok(occurrences >= 2, `kind=qwen_edit 应至少出现 2 次(编辑指令+附加指令),实际 ${occurrences}`);
  assert.ok(
    src.includes("onOptimized={(text) => setQwenPositive(text)}"),
    "优化结果未回填编辑指令",
  );
  assert.ok(
    src.includes("onOptimized={(text) => setCam3dNote(text)}"),
    "优化结果未回填附加指令",
  );
  // 标签行布局:标签 + 按钮同行
  assert.ok(src.includes("ie-field-head"), "缺字段头布局类");
});
