// ToIV Studio PWA service worker（C6 第一步：安装壳 + 深链离线可达）
//
// 策略刻意保守：
//   · 只拦 GET、同源、/studio/ 前缀内的请求；/studio/api/** 一律直连不碰（认证态动态数据绝不缓存）；
//   · 导航请求（深链/刷新）network-first，离线回退到预缓存的 SPA 壳（index.html）；
//   · /studio/static/** 与 /studio/assets/**（构建产物文件名带 hash，immutable）cache-first；
//   · 版本号 bump 即旧缓存整体淘汰；更新流程：浏览器下次启动 activate 清旧 → 新壳在下个导航生效。
const VERSION = "studio-v3";
const SHELL_CACHE = `studio-shell-${VERSION}`;
const ASSET_CACHE = `studio-assets-${VERSION}`;
const SHELL = ["/studio/", "/studio/index.html", "/studio/manifest.webmanifest", "/studio/icons/pwa-192.png", "/studio/icons/pwa-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      // 首次注册（无 controller）activate 自然接管；更新时停在 waiting 由页面
      // 「刷新更新」按钮发 SKIP_WAITING 激活（C6 更新提示流）——这里不再无条件 skipWaiting。
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      for (const name of await caches.keys()) {
        if (!keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/studio/")) return;
  if (url.pathname.startsWith("/studio/api/")) return; // 动态认证数据不缓存

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match("/studio/index.html")) || (await cache.match("/studio/")) || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/studio/static/") || url.pathname.startsWith("/studio/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const resp = await fetch(req);
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
      })(),
    );
  }
});
