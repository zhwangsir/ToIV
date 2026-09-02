/**
 * 全局进度条接线源码断言(THEME-INPUT-PROGRESS 二期遗留清零)。
 *
 * 覆盖接线:
 * 1. DubView.doLipsync:三模式 begin(AI 精剪 indeterminate / LatentSync·动漫
 *    determinate)+ 轮询真实进度(latent completed/total、anime progress 0-100)
 *    + lipsyncBusy 落 false 单一收口 genEnd(对治终态分散 6 处)。
 * (useDramaProject autorun 接线断言已随 2026-09-03 W4 drama 死链删除退役)
 *
 * 行为本体(generationBus begin 幂等/progress 夹取/end no-op)由
 * generationBus.test.ts 18 例覆盖;本文件锁定「接线存在且语义正确」防回归。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dubViewSrc = readFileSync("components/dub/DubView.tsx", "utf8");

// ── DubView.doLipsync ────────────────────────────────────────
test("DubView:进度条三模式 begin 接线", () => {
  // AI 精剪(同步,indeterminate)
  assert.match(dubViewSrc, /genBegin\("dub-lipsync", "AI 精剪"\)/);
  // LatentSync / 动漫(后台轮询,determinate 真实进度)
  assert.match(dubViewSrc, /"LatentSync 对口型"/);
  assert.match(dubViewSrc, /"动漫对口型"/);
  assert.match(dubViewSrc, /\{ determinate: true \}/);
});

test("DubView:轮询报真实进度(latent completed/total,anime progress)", () => {
  assert.match(
    dubViewSrc,
    /genProgress\("dub-lipsync", \(s\.completed \/ s\.total\) \* 100\)/,
  );
  assert.match(dubViewSrc, /genProgress\("dub-lipsync", s\.progress\)/);
});

test("DubView:lipsyncBusy 落 false 单一收口 genEnd", () => {
  // 收口 effect:if (!lipsyncBusy) genEnd("dub-lipsync")
  assert.match(dubViewSrc, /if \(!lipsyncBusy\) genEnd\("dub-lipsync"\)/);
  // 终态分散处不各自 genEnd(收口唯一):doLipsync 函数体 finally 只复位 busy
  const finallyBlocks = dubViewSrc.match(/finally \{[\s\S]*?\}/g) ?? [];
  const lipsyncFinally = finallyBlocks.find((b) => b.includes("setLipsyncBusy(false)"));
  assert.ok(lipsyncFinally, "highlights 分支应有 finally 复位 busy");
  assert.ok(!lipsyncFinally.includes('genEnd("dub-lipsync")'), "finally 内不应直接 genEnd(由 useEffect 收口)");
});

