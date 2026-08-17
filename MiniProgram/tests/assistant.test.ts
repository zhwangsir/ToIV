import { describe, expect, it } from 'vitest';

import { firstPreviewUrl, previewUrls } from '@/utils/assistant';

/** 模拟 mediaUrl：相对路径拼 base + token query */
const resolve = (p: string): string => `https://api.example.com${p}?token=t1`;

describe('previewUrls（图片整组预览）', () => {
  it('整组经 resolve 解析，顺序保持', () => {
    const urls = previewUrls({ urls: ['/outputs/a.png', '/outputs/b.png'] }, resolve);
    expect(urls).toEqual([
      'https://api.example.com/outputs/a.png?token=t1',
      'https://api.example.com/outputs/b.png?token=t1',
    ]);
  });

  it('空数组原样返回（不产生预览入口）', () => {
    expect(previewUrls({ urls: [] }, resolve)).toEqual([]);
  });
});

describe('firstPreviewUrl（视频/音频首条产物）', () => {
  it('取首条解析', () => {
    expect(firstPreviewUrl({ urls: ['/outputs/v.mp4', '/outputs/v2.mp4'] }, resolve)).toBe(
      'https://api.example.com/outputs/v.mp4?token=t1',
    );
  });

  it('空数组返回 null', () => {
    expect(firstPreviewUrl({ urls: [] }, resolve)).toBeNull();
  });
});
