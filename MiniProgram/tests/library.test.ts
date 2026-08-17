import { describe, expect, it } from 'vitest';

import type { JobItem } from '@/types/api';
import {
  cardSizePx,
  collectArtifacts,
  columnCount,
  countByFilter,
  isVideoPath,
  kindLabel,
  kindToFilter,
  LIBRARY_PAGE_SIZE,
} from '@/utils/library';

function job(partial: Partial<JobItem>): JobItem {
  return {
    id: 'j1',
    prompt_id: 'p1',
    kind: 'txt2img',
    status: 'done',
    prompt: 'a cat',
    seed: 42,
    created_at: '2026-08-13T10:00:00',
    results: ['outputs/a.png'],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: true,
    ...partial,
  };
}

describe('kindToFilter', () => {
  it('已知 kind 进对应桶', () => {
    expect(kindToFilter('txt2img')).toBe('image');
    expect(kindToFilter('wan_t2v')).toBe('video');
    expect(kindToFilter('ace_audio')).toBe('audio');
    expect(kindToFilter('hunyuan3d')).toBe('3d');
  });

  it('未识别 kind 返回 null（只进全部）', () => {
    expect(kindToFilter('some_new_kind')).toBeNull();
    expect(kindToFilter('')).toBeNull();
  });
});

describe('kindLabel', () => {
  it('已知 kind 中文标签', () => {
    expect(kindLabel('txt2img')).toBe('文生图');
    expect(kindLabel('img2img')).toBe('图生图');
  });

  it('未知兜底「其他」', () => {
    expect(kindLabel('xyz')).toBe('其他');
  });
});

describe('collectArtifacts', () => {
  it('只留 done 且有产物的作业', () => {
    const jobs = [
      job({ id: 'a' }),
      job({ id: 'b', status: 'running' }),
      job({ id: 'c', status: 'done', results: [] }),
      job({ id: 'd', status: 'error' }),
    ];
    expect(collectArtifacts(jobs).map((j) => j.id)).toEqual(['a']);
  });

  it('undefined/空数组 → 空', () => {
    expect(collectArtifacts(undefined)).toEqual([]);
    expect(collectArtifacts([])).toEqual([]);
  });
});

describe('countByFilter', () => {
  it('分桶计数，未识别只进 all', () => {
    const artifacts = [
      job({ id: 'a', kind: 'txt2img' }),
      job({ id: 'b', kind: 'img2img' }),
      job({ id: 'c', kind: 'wan_t2v' }),
      job({ id: 'd', kind: 'unknown_kind' }),
    ];
    expect(countByFilter(artifacts)).toEqual({
      all: 4,
      image: 2,
      video: 1,
      audio: 0,
      '3d': 0,
    });
  });
});

describe('columnCount / cardSizePx', () => {
  it('断点：phone 2 列 / 大屏 3 列 / 平板 4 列', () => {
    expect(columnCount(390)).toBe(2);
    expect(columnCount(431)).toBe(3);
    expect(columnCount(768)).toBe(4);
  });

  it('卡边长均分屏宽', () => {
    // (390 - 32 - 12) / 2 = 173
    expect(cardSizePx(390, 2)).toBe(173);
    // (768 - 32 - 36) / 4 = 175
    expect(cardSizePx(768, 4)).toBe(175);
  });
});

describe('isVideoPath', () => {
  it('视频扩展名', () => {
    expect(isVideoPath('a/b.mp4')).toBe(true);
    expect(isVideoPath('a/b.WEBM')).toBe(true);
    expect(isVideoPath('a/b.png')).toBe(false);
  });
});

describe('LIBRARY_PAGE_SIZE（MP15）', () => {
  it('页大小为 2/3/4 列公倍数，满页任意断点恰好整行填满', () => {
    expect(LIBRARY_PAGE_SIZE % 2).toBe(0);
    expect(LIBRARY_PAGE_SIZE % 3).toBe(0);
    expect(LIBRARY_PAGE_SIZE % 4).toBe(0);
  });

  it('落在后端 limit 契约 1-200 内', () => {
    expect(LIBRARY_PAGE_SIZE).toBeGreaterThanOrEqual(1);
    expect(LIBRARY_PAGE_SIZE).toBeLessThanOrEqual(200);
  });
});
