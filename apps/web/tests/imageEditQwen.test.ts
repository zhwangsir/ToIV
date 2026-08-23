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
