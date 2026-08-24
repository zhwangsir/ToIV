/**
 * 360° 旋转查看器(OrbitViewer)+ 环绕序列 batch_id 提交 单测(2026-08-24)
 * node:test 无 DOM,源码断言风格(同 imageEditQwen.test.ts):
 * ① OrbitViewer:帧序(8 方位升序)/ 拖拽映射(pointer capture + 32px 阻尼)/ 键盘箭头 /
 *    方位角读数 / 圆点进度 / 自动播放(800ms,reduced-motion 默认不播)/ 预加载防闪烁
 * ② ImageEditView 触发条件:camera3d + cam3dOrbit + done + 集齐 8 帧才换查看器
 * ③ batch_id:环绕序列 crypto.randomUUID() 生成 + 8 次调用透传;单张 3D 相机不带
 * ④ api.ts 契约:generateQwenEdit 序列化 batch_id
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

/* ── ① OrbitViewer 组件 ── */
test("OrbitViewer:8 帧方位升序 + 拖拽映射(pointer capture + 阻尼)", () => {
  const src = readSrc("components/image-edit/OrbitViewer.tsx");
  assert.ok(src.includes("ORBIT_AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315]"), "帧序应为方位升序");
  const m = src.match(/ORBIT_FRAME_PX = (\d+)/);
  assert.ok(m, "缺拖拽阻尼常量");
  const px = Number(m[1]);
  assert.ok(px >= 24 && px <= 40, `拖拽阻尼应在 24-40px/帧,实际 ${px}`);
  assert.ok(src.includes("setPointerCapture"), "拖拽缺 pointer capture");
  assert.ok(src.includes("e.preventDefault()"), "pointerdown 应 preventDefault 防误选图");
  assert.ok(src.includes("Math.round((e.clientX - d.startX) / ORBIT_FRAME_PX)"), "拖拽距离→帧索引映射缺失");
  assert.ok(src.includes("wrap("), "帧索引应环形取模");
});

test("OrbitViewer:键盘箭头 + 方位角读数 + 圆点进度", () => {
  const src = readSrc("components/image-edit/OrbitViewer.tsx");
  assert.ok(src.includes('e.key === "ArrowLeft"') && src.includes('e.key === "ArrowRight"'), "缺左右箭头键");
  assert.ok(src.includes("ie-orbit-angle"), "缺方位角读数");
  assert.ok(src.includes("°"), "读数应显示角度");
  assert.ok(src.includes("ie-orbit-dot"), "缺小圆点进度");
  assert.ok(src.includes("ie-orbit-prev") && src.includes("ie-orbit-next"), "缺左右微调按钮");
});

test("OrbitViewer:自动播放 800ms/帧,reduced-motion 默认不播,8 帧预加载", () => {
  const src = readSrc("components/image-edit/OrbitViewer.tsx");
  assert.ok(src.includes("ORBIT_AUTOPLAY_MS = 800"), "自动播放应 800ms/帧");
  assert.ok(src.includes("prefers-reduced-motion: reduce"), "缺 reduced-motion 检测");
  assert.ok(src.includes('name={playing ? "pause" : "play"}'), "缺播放/暂停切换");
  assert.ok(src.includes("new Image()"), "缺 8 帧预加载(防切帧闪烁)");
});

test("OrbitViewer:样式走 jsx global + ie- 前缀(styled-jsx 作用域坑 P-2b)", () => {
  const src = readSrc("components/image-edit/OrbitViewer.tsx");
  assert.ok(src.includes("<style jsx global>"), "多组件文件必须 jsx global");
  assert.ok(!/\.orbit-(?!badge)/.test(src.replace(/ie-orbit-/g, "")), "样式类名应带 ie- 前缀");
});

/* ── ② ImageEditView 触发条件 ── */
test("ImageEditView:环绕序列集齐 8 帧且 done 才换旋转查看器,胶片条保留", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  assert.ok(src.includes("OrbitViewer"), "未引入 OrbitViewer");
  assert.ok(src.includes('proc.tool === "camera3d"'), "触发条件缺 tool=camera3d");
  assert.ok(src.includes("cam3dOrbit &&"), "触发条件缺 cam3dOrbit");
  assert.ok(src.includes('proc.status === "done"'), "触发条件缺 status=done");
  assert.ok(
    src.includes("proc.resultPaths.length === CAM3D_AZIMUTHS.length"),
    "触发条件缺 8 帧集齐判断",
  );
  // 查看器受控帧:胶片条点击与拖拽/箭头共用 handleOrbitFrame
  assert.ok(src.includes("handleOrbitFrame"), "缺共用切帧回调");
  assert.ok(src.includes("ie-strip"), "胶片条应保留(与查看器共存)");
});

/* ── ③ batch_id 提交 ── */
test("ImageEditView:环绕序列生成 batch_id 并 8 次透传;单张 3D 相机不带", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  const orbit = src.slice(src.indexOf('tool === "camera3d" && cam3dOrbit'));
  assert.ok(orbit.includes("crypto.randomUUID()"), "环绕序列应生成 batch_id");
  assert.ok(orbit.includes("batchId,"), "8 次 generateQwenEdit 应透传 batchId");
  // 单张 3D 相机(非环绕)不带 batch_id
  const single = src.slice(src.indexOf('case "camera3d"'));
  assert.ok(!single.includes("batchId"), "单张 3D 相机不应带 batch_id");
});

test("api.ts:generateQwenEdit 序列化 batch_id", () => {
  const src = readSrc("lib/api.ts");
  const iface = src.slice(src.indexOf("export interface QwenEditParams"));
  assert.ok(iface.includes("batchId?: string"), "QwenEditParams 缺 batchId 字段");
  const fn = src.slice(src.indexOf("export async function generateQwenEdit"));
  assert.ok(fn.includes("batch_id: params.batchId"), "batch_id 未提交");
});

test("types.ts:JobItem 含 batch_id(列表透出)", () => {
  const src = readSrc("lib/types.ts");
  assert.ok(src.includes("batch_id?: string"), "JobItem 缺 batch_id");
});
