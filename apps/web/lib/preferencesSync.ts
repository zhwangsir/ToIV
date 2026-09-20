/**
 * 偏好跨端同步(2026-09-21 作品库):服务端为准 + localStorage 写穿。
 * 登录拉一次覆盖本地;本地变更防抖推送;离线时 localStorage 兜底,下次登录合并。
 * 合并策略 last-write-wins(单用户足够);服务端返回空串字段=未同步过,不覆盖本地。
 */
import { fetchPreferences, pushPreferences } from "./api";

let pullDone = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pending: { favorites?: string; views?: string; density?: string; style_cards?: string } = {};

/** 登录/进作品库时调用:服务端非空字段覆盖本地对应存储。 */
export async function pullPreferences(apply: {
  favorites?: (json: string) => void;
  views?: (json: string) => void;
  density?: (v: string) => void;
  styleCards?: (json: string) => void;
}): Promise<void> {
  try {
    const remote = await fetchPreferences();
    if (remote.favorites) apply.favorites?.(remote.favorites);
    if (remote.views) apply.views?.(remote.views);
    if (remote.density) apply.density?.(remote.density);
    if (remote.style_cards) apply.styleCards?.(remote.style_cards);
    pullDone = true;
  } catch {
    /* 离线/未登录:localStorage 兜底,不打扰 */
  }
}

/** 本地变更后调用:2s 防抖推送(合并同窗口多次变更)。 */
export function schedulePush(patch: typeof pending): void {
  pending = { ...pending, ...patch };
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const body = pending;
    pending = {};
    pushPreferences(body).catch(() => {
      /* 失败留 localStorage 兜底,下次 pull 合并 */
    });
  }, 2000);
}

/** 测试/登出用:重置拉取标记。 */
export function resetSyncState(): void {
  pullDone = false;
}
