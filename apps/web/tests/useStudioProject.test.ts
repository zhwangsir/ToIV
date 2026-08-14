/**
 * useStudioProject 静默失败修复单测(node:test + 自制 renderHook,无需 DOM):
 * - withBusy 操作失败:error 透出「操作名失败:原因」、busy 复位、promise 重抛;
 * - clearError 清空 error;
 * - saveShots 失败不吞错、不静默 refresh 覆盖本地编辑。
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useStudioProject } from "../hooks/useStudioProject";
import { flush, renderHook } from "./helpers/renderHook";
import { calls, impl, makeShot, resetImpl } from "./mocks/studioApi";

beforeEach(() => {
  resetImpl();
});

test("挂载后自动加载项目详情", async () => {
  const h = renderHook(() => useStudioProject("p1"));
  await flush();
  assert.equal(h.result.current?.detail?.id, "p1");
  assert.equal(h.result.current?.loading, false);
  assert.equal(h.result.current?.error, null);
  h.unmount();
});

test("renderShot 失败:error 透出、busy 复位、promise 重抛", async () => {
  const h = renderHook(() => useStudioProject("p1"));
  await flush();

  // 进行中:busy 置位
  let resolveRender!: (v: ReturnType<typeof makeShot>) => void;
  impl.renderStudioShot = (sid) =>
    new Promise((r) => {
      resolveRender = r;
    });
  const pending = h.result.current!.renderShot("s1");
  await flush();
  assert.equal(h.result.current?.busy["render:s1"], true, "操作进行中 busy 置位");
  assert.equal(h.result.current?.error, null);
  resolveRender(makeShot("s1"));
  await pending;
  await flush();
  assert.equal(h.result.current?.busy["render:s1"], false, "成功后 busy 复位");
  assert.equal(h.result.current?.error, null);

  // 失败:error 透出 + busy 复位 + 重抛
  impl.renderStudioShot = () => Promise.reject(new Error("GPU 显存不足"));
  await assert.rejects(h.result.current!.renderShot("s1"), /GPU 显存不足/, "失败应重抛");
  await flush();
  assert.equal(h.result.current?.busy["render:s1"], false, "失败后 busy 复位");
  assert.match(
    h.result.current?.error ?? "",
    /生成分镜失败:GPU 显存不足/,
    "error 含操作名与原因",
  );
  h.unmount();
});

test("clearError 清空 error", async () => {
  const h = renderHook(() => useStudioProject("p1"));
  await flush();
  impl.voiceStudioShot = () => Promise.reject(new Error("TTS 引擎离线"));
  await assert.rejects(h.result.current!.voiceShot("s9"));
  await flush();
  assert.match(h.result.current?.error ?? "", /分镜配音失败:TTS 引擎离线/);

  h.result.current!.clearError();
  await flush();
  assert.equal(h.result.current?.error, null);
  h.unmount();
});

test("saveShots 失败:显式标记 error、不静默 refresh、promise 重抛", async () => {
  const h = renderHook(() => useStudioProject("p1"));
  await flush();

  // 成功路径:保存后 refresh 一次
  const loadsBefore = calls.getStudioProject;
  await h.result.current!.saveShots([{ scene: "新场景" }]);
  await flush();
  assert.equal(calls.saveStudioShots, 1);
  assert.equal(calls.getStudioProject, loadsBefore + 1, "保存成功后 refresh");
  assert.equal(h.result.current?.error, null);

  // 失败路径:error 透出 + 不再 refresh(保护本地编辑)+ 重抛
  impl.saveStudioShots = () => Promise.reject(new Error("网络抖动 502"));
  const loadsAfterOk = calls.getStudioProject;
  await assert.rejects(
    h.result.current!.saveShots([{ scene: "未保存的编辑" }]),
    /网络抖动 502/,
    "saveShots 失败应重抛,不吞错",
  );
  await flush();
  assert.match(h.result.current?.error ?? "", /分镜保存失败,请重试或复制内容/);
  assert.match(h.result.current?.error ?? "", /网络抖动 502/);
  assert.equal(
    calls.getStudioProject,
    loadsAfterOk,
    "保存失败不静默 refresh 覆盖本地编辑",
  );
  h.unmount();
});

test("assemble 失败:error 透出且 busy 复位", async () => {
  const h = renderHook(() => useStudioProject("p1"));
  await flush();
  impl.assembleStudio = () => Promise.reject(new Error("ffmpeg 合成失败"));
  await assert.rejects(h.result.current!.assemble());
  await flush();
  assert.equal(h.result.current?.busy["assemble"], false);
  assert.match(h.result.current?.error ?? "", /合成成片失败:ffmpeg 合成失败/);
  h.unmount();
});
