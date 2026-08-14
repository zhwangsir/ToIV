// Chunk 404 自动恢复(发版防御三件套之二):
// 发版时 .next 被整体替换,用户端旧 HTML 引用的 /_next/static/chunks/*.js 随之
// 失效 → 动态 import 抛 ChunkLoadError(或 <script> 资源 404)。此时页面已处于
// 半残状态,唯一正确的恢复是整页刷新,拿到新 HTML + 新 chunk。
//
// 防死循环:每个 BUILD_ID 只允许自动刷新一次(sessionStorage 一次性标记):
//   · 刷新后拿到新构建 → chunk 恢复一致,正常;
//   · 刷新后仍失败(弱网/反代缓存了旧 HTML)→ 标记已在,不再自动刷,
//     避免把用户卡进无限 reload;
//   · 下一次发版(新 BUILD_ID)→ 键名不同,重新获得一次自动恢复机会。
// sessionStorage 不可用时宁可不自动刷(无防重入能力),把刷新交给用户。

import { resolveRunningBuildId } from "@/lib/releaseWatch";

const STORAGE_KEY_PREFIX = "toiv:chunk-reload:";

function errorMessageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "";
    const message = typeof rec.message === "string" ? rec.message : "";
    return `${name} ${message}`.trim();
  }
  return "";
}

/**
 * 判定是否为「动态 import / chunk 加载失败」报错。
 * 覆盖:Next(webpack) ChunkLoadError / "Loading chunk N failed",
 * Vite 风格 "Failed to fetch dynamically imported module"(Chrome),
 * Safari "Importing a module script failed",Firefox "error loading dynamically imported module"。
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = errorMessageOf(error);
  return (
    /ChunkLoadError/i.test(message) ||
    /Loading chunk [\w-]+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message)
  );
}

/**
 * <script>/<link> 资源级 404 兜底判定:URL 是否指向 Next 构建产物。
 * 旧 HTML 引用的失效 chunk 会以资源 error 事件出现(不带 error 对象),按 URL 识别。
 */
export function isNextChunkAssetUrl(url: unknown): boolean {
  return (
    typeof url === "string" && /\/_next\/static\/[^"'\s]+\.(js|css)(\?|$)/.test(url)
  );
}

export type ChunkRecoveryAction = "ignored" | "reloaded" | "already-reloaded";

export interface ChunkRecoveryDeps {
  /** 本 bundle 构建指纹(null 时以 "unknown" 为键,同一未知构建同样只刷一次)。 */
  buildId: string | null;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  reload: () => void;
}

/** 纯决策核心(无 window 依赖,可单测):chunk 错误 → 每 buildId 仅自动刷新一次。 */
export function createChunkLoadRecovery({
  buildId,
  storage,
  reload,
}: ChunkRecoveryDeps): { handle: (error: unknown) => ChunkRecoveryAction } {
  const markerKey = `${STORAGE_KEY_PREFIX}${buildId ?? "unknown"}`;

  /** 清掉历史构建遗留的一次性标记,避免 sessionStorage 堆积。 */
  const sweepStaleMarkers = (): void => {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(STORAGE_KEY_PREFIX) && key !== markerKey) {
        stale.push(key);
      }
    }
    for (const key of stale) storage.removeItem(key);
  };

  const handle = (error: unknown): ChunkRecoveryAction => {
    if (!isChunkLoadError(error)) return "ignored";
    try {
      if (storage.getItem(markerKey)) return "already-reloaded";
      // 先打标再刷新:即使 reload 被推迟执行,重入也已被挡住
      storage.setItem(markerKey, String(Date.now()));
      sweepStaleMarkers();
    } catch {
      // 存储不可用(隐私模式等)则没有跨刷新记忆,自动刷可能死循环 —— 放弃自动恢复
      return "already-reloaded";
    }
    reload();
    return "reloaded";
  };

  return { handle };
}

let installed = false;

/**
 * 全局安装:unhandledrejection(动态 import 失败走 Promise 拒绝)
 * + error 捕获阶段(同步 ChunkLoadError 与 <script>/<link> 资源 404)。
 * 返回卸载函数;非浏览器环境为 no-op。重复安装幂等。
 */
export function installChunkLoadRecovery(): () => void {
  if (installed || typeof window === "undefined") return () => undefined;
  installed = true;

  const recovery = createChunkLoadRecovery({
    buildId: resolveRunningBuildId(),
    storage: window.sessionStorage,
    reload: () => window.location.reload(),
  });

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (recovery.handle(event.reason) !== "ignored") {
      // 已按恢复流程处理,阻止错误继续冒泡刷屏(Sentry 等仍会经自身钩子收到)
      event.preventDefault();
    }
  };

  const onError = (event: Event) => {
    // ① ErrorEvent 带 error 对象:同步抛出的 ChunkLoadError
    if (event instanceof ErrorEvent && event.error) {
      recovery.handle(event.error);
      return;
    }
    // ② 资源错误(捕获阶段才收得到):旧 HTML 引用的 /_next/static chunk 404
    const target = event.target as HTMLScriptElement | HTMLLinkElement | null;
    if (!target || target === (event.currentTarget as unknown)) return;
    const url =
      target instanceof HTMLScriptElement
        ? target.src
        : target instanceof HTMLLinkElement
          ? target.href
          : null;
    if (isNextChunkAssetUrl(url)) {
      recovery.handle(`Loading chunk failed: ${String(url)}`);
    }
  };

  window.addEventListener("unhandledrejection", onUnhandledRejection);
  window.addEventListener("error", onError, true);

  return () => {
    installed = false;
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.removeEventListener("error", onError, true);
  };
}

export function resetChunkLoadRecoveryForTests(): void {
  installed = false;
}
