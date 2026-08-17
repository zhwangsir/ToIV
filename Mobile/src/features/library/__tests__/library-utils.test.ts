import { FILTERS, kindToFilter, kindLabel } from '../library-utils';

describe('kindToFilter', () => {
  it('txt2img → image', () => {
    expect(kindToFilter('txt2img')).toBe('image');
  });
  it('wan_t2v → video', () => {
    expect(kindToFilter('wan_t2v')).toBe('video');
  });
  it('ace_audio → audio', () => {
    expect(kindToFilter('ace_audio')).toBe('audio');
  });
  it('hunyuan3d → 3d', () => {
    expect(kindToFilter('hunyuan3d')).toBe('3d');
  });
  it('未知 kind → null', () => {
    expect(kindToFilter('unknown_xyz')).toBeNull();
  });
});

describe('kindLabel', () => {
  it('常见 kind 返回中文', () => {
    expect(kindLabel('txt2img')).toBe('文生图');
    expect(kindLabel('upscale')).toBe('放大');
    expect(kindLabel('wan_t2v')).toBe('文生视频');
    expect(kindLabel('ace_audio')).toBe('音乐');
  });
  it('未知 kind 返回「其他」', () => {
    expect(kindLabel('xyz')).toBe('其他');
  });
});

describe('FILTERS', () => {
  it('all 的 kinds 为空（表示不过滤）', () => {
    expect(FILTERS.find((f) => f.key === 'all')?.kinds).toEqual([]);
  });
  it('video 包含 longcat_t2v', () => {
    expect(FILTERS.find((f) => f.key === 'video')?.kinds).toContain('longcat_t2v');
  });
});
