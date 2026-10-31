// 发版侦测(发版防御三件套之一,纯逻辑,可单测):
// 轮询 /version.json,把部署侧指纹与本 bundle 烘焙的 NEXT_PUBLIC_BUILD_ID 比对,
// 不一致即「已有新构建」。基线是本 bundle 自己的构建期常量,不是「先拉一次记住」
// 的值,因此无种子竞态:页面加载与首次轮询之间落地的发版也能被捕获。
// 指纹由 next.config.mjs 同源注入(generateBuildId / env),/version.json 运行时
// 读 .next/BUILD_ID,三处必然同值。

/** 轮询间隔:5min 低频(页面隐藏时由 usePoll 暂停,回前台立即补一次)。 */
export const VERSION_POLL_INTERVAL_MS = 300_000;

interface VersionProbePayload {
  buildId?: unknown;
}

/** 本 bundle 的构建指纹;未注入(dev/异常构建)返回 null → 侦测整体停用。 */
export function resolveRunningBuildId(
  raw: string | undefined = process.env.NEXT_PUBLIC_BUILD_ID,
): string | null {
  return raw && raw.trim().length > 0 ? raw : null;
}

/** 部署指纹与本 bundle 指纹是否不同;任一侧取不到都视为一致(不打扰用户)。 */
export function deployedVersionDiffers(
  deployed: string | null,
  running: string | null,
): boolean {
  return deployed !== null && running !== null && deployed !== running;
}

/** 拉取部署侧构建指纹;任何失败(网络/反代/解析)都返回 null,静默等下轮。 */
export async function fetchDeployedBuildId(
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    // cache-bust + no-store:防 CDN/反代(openresty 双入口)给到过期的探针响应
    const res = await fetchFn(`/version.json?_v=${Date.now()}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as VersionProbePayload | null;
    const buildId = data?.buildId;
    return typeof buildId === "string" && buildId.length > 0 ? buildId : null;
  } catch {
    return null;
  }
}
