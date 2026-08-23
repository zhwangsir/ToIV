/**
 * 图生3D(Hunyuan3D)前端单测(node:test,无 DOM,源码断言风格):
 * ① ImageEditView 第 7 个工具注册 + 三参数控件(步数/octree/seed)
 * ② runTool 走 kind=hunyuan3d 重传 + generate3D,参数校验拦截
 * ③ GLB 结果卡:不渲染 <img>,展示「3D 模型已生成」+ 下载
 * ④ api.ts 契约:generate3D 路径/方法
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
test("ImageEditView:第 7 个工具 图生3D(Hunyuan3D) 已注册", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes('"hunyuan3d"'), "EditTool 缺 hunyuan3d");
  assert.ok(src.includes('key: "hunyuan3d"'), "TOOLS 缺 hunyuan3d 条目");
  assert.ok(src.includes("图生3D(Hunyuan3D)"), "工具标题缺失");
  // 三参数:步数(10-100,默认 30)/ octree 分辨率(64-512,默认 256)/ seed 可空
  assert.ok(src.includes("useState(30)"), "步数默认值应为 30");
  assert.ok(src.includes("useState(256)"), "octree 默认值应为 256");
  assert.ok(src.includes("THREED_OCTREES"), "缺 octree 档位预设");
  assert.ok(src.includes("Seed(可选,留空随机)"), "缺 seed 输入");
});

/* ── ② runTool 提交链路 ── */
test("ImageEditView:runTool 走 kind=hunyuan3d 上传 + generate3D", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes("generate3D"), "未引入 generate3D");
  const threedCase = src.slice(src.indexOf('case "hunyuan3d"'));
  assert.ok(threedCase.includes('uploadImage(source.file, "hunyuan3d")'), "源图未按 kind=hunyuan3d 重传");
  assert.ok(threedCase.includes("steps: threedSteps"), "steps 未透传");
  assert.ok(threedCase.includes("octree_resolution: threedOctree"), "octree_resolution 未透传");
  assert.ok(threedCase.includes("步数须在 10-100 之间"), "步数越界未拦截");
  assert.ok(threedCase.includes("seed 须为非负整数"), "非法 seed 未拦截");
});

/* ── ③ GLB 结果卡 ── */
test("ImageEditView:GLB 结果渲染为模型卡(文件名+下载),不进 <img>/胶片条", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes("Model3DResult"), "缺 Model3DResult 组件");
  assert.ok(src.includes("3D 模型已生成"), "缺 3D 结果标题");
  assert.ok(src.includes("下载 GLB"), "缺 GLB 下载按钮");
  assert.ok(src.includes('proc.tool === "hunyuan3d"'), "结果区未按 hunyuan3d 分流");
  // 胶片条只服务图片多结果(360° 环绕),GLB 不得进 <img>
  assert.ok(src.includes('proc.tool !== "hunyuan3d"'), "胶片条未排除 hunyuan3d");
});

/* ── ④ api.ts 契约 ── */
test("api.ts:generate3D 路径与方法", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("export async function generate3D"), "generate3D 未导出");
  const fn = src.slice(src.indexOf("export async function generate3D"));
  assert.ok(fn.includes("`/api/generate/3d`"), "路径错误");
  assert.ok(fn.slice(0, 400).includes('method: "POST"'), "应为 POST");
});
