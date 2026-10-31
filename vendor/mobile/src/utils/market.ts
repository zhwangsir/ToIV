/**
 * 市场可用性排序 / 相对验证时间 —— 对齐 apps/web/lib/apps.ts (U5 / U10)
 */
export type MarketAppLike = {
  id: string;
  smoke_status?: string | null;
  smoke_at?: string | null;
};

/** 烟测可用性档:pass 最前,未测最后;稳定排序不打乱同档相对序。 */
export function smokeAvailabilityRank(status?: string | null): number {
  const s = (status || '').trim();
  if (s === 'pass') return 0;
  if (s === 'running') return 1;
  if (s === 'fail' || s === 'timeout') return 2;
  return 3; // 未测 / 空
}

/** 未测卡不置顶:同档保持相对序(U5 2026-09-25 / U10 小程序)。 */
export function sortAppsVerifiedFirst<T extends MarketAppLike>(apps: T[]): T[] {
  return [...apps]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const d = smokeAvailabilityRank(x.a.smoke_status) - smokeAvailabilityRank(y.a.smoke_status);
      return d !== 0 ? d : x.i - y.i;
    })
    .map((x) => x.a);
}

/** 最近验证相对时间(空/非法 → 空串)。 */
export function formatSmokeVerifiedAt(iso?: string | null, now = Date.now()): string {
  if (!iso || !String(iso).trim()) return '';
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const diff = Math.max(0, now - t);
    const min = 60_000;
    const hr = 60 * min;
    const day = 24 * hr;
    if (diff < min) return '刚刚';
    if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return new Date(t).toLocaleDateString('zh-CN');
  } catch {
    return '';
  }
}

/** 双列瀑布：按封面高矮启发式分到较短列（无真实高度时用 id 哈希伪高）。 */
export function splitIntoWaterfallColumns<T extends { id: string; cover_url?: string }>(
  apps: T[],
  columnCount = 2,
): T[][] {
  const cols: T[][] = Array.from({ length: Math.max(1, columnCount) }, () => []);
  const heights = cols.map(() => 0);
  for (const app of apps) {
    let h = 1;
    // 有封面的卡略高，贴 RunningHub 大封面观感
    if ((app.cover_url || '').trim()) h = 1.35;
    // 伪随机抖动，避免两列完全齐平
    let hash = 0;
    for (let i = 0; i < app.id.length; i++) hash = (hash * 31 + app.id.charCodeAt(i)) >>> 0;
    h += (hash % 5) * 0.08;
    let best = 0;
    for (let c = 1; c < cols.length; c++) {
      if (heights[c] < heights[best]) best = c;
    }
    cols[best].push(app);
    heights[best] += h;
  }
  return cols;
}
