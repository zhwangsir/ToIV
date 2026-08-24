/**
 * 格式自动识别 + 浏览器内 3D 预览(2026-08-24)单测(node:test,无 DOM,源码断言风格):
 * ① lib/mediaKind.mediaKindOf:扩展名优先/kind 兜底矩阵
 * ② ui/ModelViewer:懒加载动态 import、camera-controls、失败占位、SSR 占位
 * ③ LibraryView:灯箱 model3d 分支(mediaKindOf 判定)+ 网格 3D 角标不 <img> 加载 glb
 * ④ AssistantView renderAvMedia:model3d 内联 ModelViewer + 下载链接保留
 * ⑤ ImageEditView Model3DResult:内联 ModelViewer
 * ⑥ mediaTypeForJob 已收敛为 mediaKindOf 薄封装(单一事实源)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { mediaKindOf } from "../lib/mediaKind";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① mediaKindOf 矩阵:扩展名优先 ── */
test("mediaKindOf:扩展名优先识别(model3d/audio/video/image)", () => {
  // 3D
  assert.equal(mediaKindOf("a.glb"), "model3d");
  assert.equal(mediaKindOf("a.gltf"), "model3d");
  assert.equal(mediaKindOf("/api/images?f=a.GLB&sig=x"), "model3d");
  // 音频
  for (const ext of ["mp3", "wav", "flac", "ogg", "m4a", "aac"]) {
    assert.equal(mediaKindOf(`a.${ext}`), "audio", ext);
  }
  // 视频
  for (const ext of ["mp4", "webm", "mov", "m4v"]) {
    assert.equal(mediaKindOf(`a.${ext}`), "video", ext);
  }
  // 图片
  for (const ext of ["png", "jpg", "jpeg", "webp", "gif", "avif"]) {
    assert.equal(mediaKindOf(`a.${ext}`), "image", ext);
  }
  // 扩展名优先于冲突的 kind(防 glb 落进 <img>)
  assert.equal(mediaKindOf("a.glb", "txt2img"), "model3d");
  assert.equal(mediaKindOf("a.mp3", "txt2img"), "audio");
  assert.equal(mediaKindOf("a.mp4", "txt2img"), "video");
});

/* ── ①b mediaKindOf 矩阵:无扩展名时 kind 兜底 ── */
test("mediaKindOf:无扩展名回退 kind 映射", () => {
  assert.equal(mediaKindOf("/api/images/abc?sig=x", "h3_t2v"), "video");
  assert.equal(mediaKindOf("/api/images/abc?sig=x", "manju_voice"), "audio");
  assert.equal(mediaKindOf("/api/images/abc?sig=x", "hunyuan3d"), "model3d");
  assert.equal(mediaKindOf("/api/images/abc?sig=x", "cad_preview"), "model3d");
  assert.equal(mediaKindOf("/api/images/abc?sig=x", "txt2img"), "image");
  assert.equal(mediaKindOf("", "unknown_kind"), "image");
  assert.equal(mediaKindOf(""), "image");
});

/* ── ② ModelViewer 组件封装 ── */
test("ModelViewer:懒加载动态 import + 轨道控制 + 失败/加载占位", () => {
  const src = readSrc("components/ui/ModelViewer.tsx");
  assert.ok(src.includes('import("@google/model-viewer")'), "未动态 import model-viewer");
  assert.ok(src.includes("useEffect"), "动态 import 须在 effect 内(SSR 占位)");
  assert.ok(src.includes("camera-controls"), "缺 camera-controls");
  assert.ok(src.includes("auto-rotate"), "缺 auto-rotate");
  assert.ok(src.includes('loading="lazy"'), "缺 loading=lazy");
  assert.ok(src.includes("LoadingBlock"), "未就绪未渲染 LoadingBlock");
  assert.ok(src.includes("3D 模型加载失败"), "缺加载失败错误占位");
  assert.ok(src.includes("IntrinsicElements"), "缺 model-viewer JSX 类型声明");
  // 高度由调用方容器定:组件自身 100%
  assert.ok(src.includes('width: "100%", height: "100%"'), "查看器未 100% 充满容器");
});

/* ── ③ LibraryView:灯箱 model3d 分支 + 网格 3D 角标 ── */
test("LibraryView:灯箱 model3d 分支用 mediaKindOf 判定,音频分支保留", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes('mediaKind === "model3d"'), "灯箱缺 model3d 分支");
  assert.ok(src.includes("ModelViewer"), "灯箱未接 ModelViewer");
  assert.ok(src.includes("lib-lb-model3d"), "灯箱 3D 查看器缺舞台样式类");
  assert.ok(src.includes('mediaKind === "audio"'), "灯箱音频分支缺失");
  assert.ok(src.includes('mediaKind === "video"'), "灯箱视频分支缺失");
  assert.ok(src.includes("mediaKindOf(mediaUrl, job.kind)"), "灯箱未用统一 helper 判定");
});

test("LibraryView:网格 3D 作业图标占位 + 「3D」角标,不 <img> 加载 glb", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes("lib-3d-badge"), "缺 3D 角标");
  assert.ok(
    src.includes('mediaKindOf(job.results[0], job.kind) === "model3d"'),
    "网格 3D 判定未走 mediaKindOf",
  );
  // 3D 分支在 ImageThumb 之前短路(三处网格:文件夹/主网格/回收站)
  const matches = src.match(/is3d \? \(/g) ?? [];
  assert.ok(matches.length >= 3, `3D 网格分支应覆盖 3 处,实得 ${matches.length}`);
});

/* ── ④ AssistantView renderAvMedia ── */
test("AssistantView:model3d 分支内联 ModelViewer + 下载链接保留", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  const branch = src.slice(src.indexOf('m.type === "model3d"'));
  assert.ok(branch.includes("ModelViewer"), "model3d 分支未接 ModelViewer");
  assert.ok(branch.includes("av-media-3d"), "缺查看器高度容器类");
  assert.ok(branch.includes("下载 3D 模型"), "下载链接未保留");
});

/* ── ⑤ ImageEditView Model3DResult ── */
test("ImageEditView:Model3DResult 下载卡上方内联 ModelViewer", () => {
  const src = readSrc("components/image-edit/ImageEditView.tsx");
  const card = src.slice(src.indexOf("function Model3DResult"));
  assert.ok(card.includes("ModelViewer"), "Model3DResult 未接 ModelViewer");
  assert.ok(card.includes("ie-model3d-viewer"), "缺查看器容器类");
  assert.ok(card.indexOf("ie-model3d-viewer") < card.indexOf("ie-model3d-body"), "查看器应在信息区上方");
  assert.ok(card.includes("下载 GLB"), "下载按钮未保留");
});

/* ── ⑥ mediaTypeForJob 收敛 ── */
test("AssistantView:mediaTypeForJob 收敛为 mediaKindOf 薄封装", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  const fn = src.slice(src.indexOf("export function mediaTypeForJob"));
  assert.ok(fn.slice(0, 300).includes("mediaKindOf(url, kind)"), "mediaTypeForJob 未收敛到 mediaKindOf");
});
