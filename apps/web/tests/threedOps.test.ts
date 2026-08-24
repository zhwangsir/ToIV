/**
 * 3D 调整(/api/3d/ops)前端单测(node:test,无 DOM,源码断言风格):
 * ① api.ts 契约:threeDOps 路径/方法/longRequest
 * ② 作品库灯箱 3D 分支:ThreeDOpsBar 材质预设 + 快照/旋转视频按钮,<style jsx global> + t3dops- 前缀(P-2b)
 * ③ ImageEditView 图生3D 结果卡:「渲染旋转视频」入口(source 句柄解析自签名 URL)
 * ④ libraryQuery:threed_render/threed_material 进 3D 筛选桶 + 中文短名
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

/* ── ① api.ts 契约 ── */
test("api.ts:threeDOps 路径/方法/长超时", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("export async function threeDOps"), "threeDOps 未导出");
  const fn = src.slice(src.indexOf("export async function threeDOps"));
  assert.ok(fn.includes("`/api/3d/ops`"), "路径错误");
  assert.ok(fn.slice(0, 400).includes('method: "POST"'), "应为 POST");
  assert.ok(fn.includes("longRequest: true"), "旋转视频耗时长,须 longRequest");
  assert.ok(src.includes('kind: "threed_render" | "threed_material"'), "ThreeDOpsResult 类型缺失");
});

/* ── ② 作品库灯箱 3D 操作条 ── */
test("LibraryView:灯箱 3D 分支挂 ThreeDOpsBar(材质预设+快照+旋转视频)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("threeDOps"), "未引入 threeDOps");
  assert.ok(src.includes("function ThreeDOpsBar"), "缺 ThreeDOpsBar 组件");
  assert.ok(
    src.includes('mediaKind === "model3d" && <ThreeDOpsBar'),
    "灯箱 3D 分支未挂载操作条",
  );
  // 材质预设 6 档
  for (const p of ["clay", "matte", "metal", "glossy", "wireframe", "normal"]) {
    assert.ok(src.includes(`value: "${p}"`), `缺材质预设 ${p}`);
  }
  assert.ok(src.includes("渲染快照"), "缺渲染快照按钮");
  assert.ok(src.includes("渲染旋转视频"), "缺渲染旋转视频按钮");
  assert.ok(src.includes('job_id: job.id'), "操作条未以 job_id 为来源");
  assert.ok(src.includes("invalidateJobs()"), "成功后未失效作品库缓存");
  // P-2b:样式必须 global + 前缀(子组件拿不到主组件 styled-jsx 作用域)
  assert.ok(src.includes("<style jsx global>"), "灯箱操作条样式未走 jsx global");
  assert.ok(src.includes(".t3dops-bar"), "缺 t3dops- 前缀样式");
});

/* ── ③ ImageEditView 3D 结果卡旋转视频入口 ── */
test("ImageEditView:Model3DResult 挂渲染旋转视频(source 句柄自签名 URL 解析)", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes("threeDOps"), "未引入 threeDOps");
  const card = src.slice(src.indexOf("function Model3DResult"));
  assert.ok(card.includes("渲染旋转视频"), "结果卡缺旋转视频入口");
  assert.ok(card.includes('qs.get("filename")') && card.includes('qs.get("worker")'),
    "未从签名 URL 解析 source 句柄");
  assert.ok(card.includes('format: "mp4"'), "旋转视频未指定 mp4");
  assert.ok(card.includes("invalidateJobs()"), "成功后未失效作品库缓存");
});

/* ── ④ libraryQuery 筛选/短名 ── */
test("libraryQuery:threed_render/threed_material 进 3D 桶且有中文短名", () => {
  const src = readSrc("lib/libraryQuery.ts");
  assert.ok(src.includes('"threed_material"') && src.includes('"threed_render"'),
    "3D 筛选桶未收录新 kind");
  assert.ok(src.includes('threed_material: "3D 材质"'), "缺 threed_material 短名");
  assert.ok(src.includes('threed_render: "3D 渲染"'), "缺 threed_render 短名");
});
