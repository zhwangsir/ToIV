/**
 * 应用封面地址(lib/api.ts)单测(node:test,无 DOM):
 * 2026-09-27 RH 部分卡封面是 mp4,<img> 加载失败回退图标 → 走 COS 截帧;
 * 外链封面不得附 ?token=(登录凭证不外泄到第三方图床)。
 */
import assert from "node:assert/strict";
import test from "node:test";

const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>([["toiv_token", "secret-token"]]);
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  clear: () => localStore.clear(),
};

const { coverImageUrl, coverVideoUrl, imageUrl, isOwnApiUrl, isVideoCoverUrl } = await import("../lib/api");

const RH_MP4 =
  "https://rh-hk-images.xiaoyaoyou.com/16e1dbe8ff115d1fe0882138cd73962d/2026-03-25/9d285e5b2f8867fd7ea865150c7a7eb3.mp4";
const SNAP = `${RH_MP4}?ci-process=snapshot&time=1&format=jpg&width=768`;

test("识别视频封面(忽略查询串)", () => {
  assert.equal(isVideoCoverUrl(RH_MP4), true);
  assert.equal(isVideoCoverUrl(`${RH_MP4}?imageMogr2/format/jpeg/ignore-error/1`), true);
  assert.equal(isVideoCoverUrl("https://rh-hk-images.xiaoyaoyou.com/a/b.png"), false);
  assert.equal(isVideoCoverUrl("/api/apps/covers/file/appcover-x.jpg"), false);
  assert.equal(isVideoCoverUrl(null), false);
});

test("mp4 封面走 RH COS 截帧,<img> 可显示;原片供悬停播放", () => {
  assert.equal(coverImageUrl(RH_MP4), SNAP);
  assert.equal(coverImageUrl(`${RH_MP4}?imageMogr2/format/jpeg/ignore-error/1`), SNAP);
  assert.equal(coverVideoUrl(`${RH_MP4}?x=1`), RH_MP4);
  assert.equal(coverVideoUrl("https://rh-hk-images.xiaoyaoyou.com/a/b.png"), null);
});

test("外链封面不附登录 token;本服务地址照常附", () => {
  assert.equal(isOwnApiUrl(RH_MP4), false);
  assert.equal(isOwnApiUrl("/api/apps/covers/file/appcover-x.jpg"), true);
  assert.ok(!coverImageUrl("https://rh-hk-images.xiaoyaoyou.com/a/b.png").includes("token="));
  assert.ok(!imageUrl(RH_MP4).includes("token="));
  assert.ok(imageUrl("/api/apps/covers/file/appcover-x.jpg").includes("token=secret-token"));
});
