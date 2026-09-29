import { describe, expect, it } from 'vitest';

import {
  formatSmokeVerifiedAt,
  smokeAvailabilityRank,
  sortAppsVerifiedFirst,
  splitIntoWaterfallColumns,
} from '@/utils/market';

describe('market 可用性排序 (U10)', () => {
  it('smokeAvailabilityRank 档位', () => {
    expect(smokeAvailabilityRank('pass')).toBe(0);
    expect(smokeAvailabilityRank('running')).toBe(1);
    expect(smokeAvailabilityRank('fail')).toBe(2);
    expect(smokeAvailabilityRank('timeout')).toBe(2);
    expect(smokeAvailabilityRank('')).toBe(3);
    expect(smokeAvailabilityRank(null)).toBe(3);
  });

  it('sortAppsVerifiedFirst: pass 置顶,未测沉底,同档保序', () => {
    const apps = [
      { id: 'a', smoke_status: '' },
      { id: 'b', smoke_status: 'pass' },
      { id: 'c', smoke_status: 'fail' },
      { id: 'd', smoke_status: 'pass' },
      { id: 'e', smoke_status: 'timeout' },
    ];
    expect(sortAppsVerifiedFirst(apps).map((x) => x.id)).toEqual(['b', 'd', 'c', 'e', 'a']);
  });

  it('formatSmokeVerifiedAt 相对时间', () => {
    const now = Date.parse('2026-09-29T10:00:00+08:00');
    expect(formatSmokeVerifiedAt(null, now)).toBe('');
    expect(formatSmokeVerifiedAt('2026-09-29T09:59:30+08:00', now)).toBe('刚刚');
    expect(formatSmokeVerifiedAt('2026-09-29T09:30:00+08:00', now)).toBe('30 分钟前');
    expect(formatSmokeVerifiedAt('2026-09-28T10:00:00+08:00', now)).toBe('1 天前');
  });

  it('splitIntoWaterfallColumns 双列不丢卡', () => {
    const apps = [
      { id: '1', cover_url: 'x' },
      { id: '2', cover_url: '' },
      { id: '3', cover_url: 'y' },
      { id: '4', cover_url: '' },
    ];
    const cols = splitIntoWaterfallColumns(apps, 2);
    expect(cols).toHaveLength(2);
    expect(cols.flat().map((a) => a.id).sort()).toEqual(['1', '2', '3', '4']);
  });
});
