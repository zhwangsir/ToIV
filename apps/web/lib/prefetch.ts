/**
 * L3 数据预取(2026-09-01):SideRail 悬停/聚焦 + 首屏空闲预热高频视图数据。
 *
 * 全部走 swr-cache——TTL 内命中零网络,过期后台静默刷新,同键 in-flight 去重,
 * 天然防爆;失败静默(预取是优化,不是功能路径)。
 *
 * 与 preloadView(app/page.tsx)分工:preloadView 预热视图 JS chunk,
 * prefetchView 预热视图首屏数据;两者都挂在 SideRail onItemIntent 上。
 */
import {
  getMe,
  listAgentRuns,
  listAgentSessions,
  listJobs,
  listLocalModels,
  listModels,
  listStudioProjects,
  listTrainJobs,
} from "./api";
import { listApps } from "./apps";
import { fetchEngines } from "./engines";
import { preloadEntities } from "./entities";

/** 视图 → 首屏数据预热函数集(只放各页进屏必拉的高频读)。 */
const WARMERS: Record<string, ReadonlyArray<() => unknown>> = {
  home: [() => getMe(), () => listAgentSessions()],
  assistant: [() => getMe(), () => listAgentSessions()],
  image: [() => fetchEngines(), () => listModels()],
  video: [() => fetchEngines(), () => listModels()],
  audio: [() => fetchEngines(), () => listModels()],
  library: [() => listJobs()],
  entities: [() => preloadEntities()],
  market: [() => listApps()],
  fusion: [() => listApps()],
  resources: [() => listLocalModels(), () => listTrainJobs()],
  "agent-runs": [() => listAgentRuns({ limit: 50 })],
  studio: [() => listStudioProjects()],
};

/** 预热指定视图的首屏数据(悬停/聚焦意图触发)。 */
export function prefetchView(view: string): void {
  const fns = WARMERS[view];
  if (!fns) return;
  for (const fn of fns) {
    try {
      const r = fn() as Promise<unknown> | undefined;
      if (r && typeof r.catch === "function") r.catch(() => undefined);
    } catch {
      /* 预取失败静默 */
    }
  }
}

/** 空闲批量预热(首屏落地后);requestIdleCallback 缺省回退 setTimeout。 */
export function idlePrefetch(views: readonly string[]): void {
  const run = () => {
    for (const v of views) prefetchView(v);
  };
  if (typeof window === "undefined") return;
  const ric = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 4000 });
  else setTimeout(run, 2500);
}
