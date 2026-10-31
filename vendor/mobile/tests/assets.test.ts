import { describe, expect, it } from 'vitest';

import type { AssetItem } from '@/types/api';
import {
  appendAssetImage,
  ASSET_IMAGES_MAX,
  assetKindLabel,
  ASSET_KINDS,
  assetToDraft,
  buildAssetPatch,
  filterAssetsByKind,
  validateAssetDraft,
} from '@/utils/assets';

function makeAsset(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    id: 'a1',
    kind: 'character',
    name: '主角卡',
    description: '胶片风',
    images: [{ filename: 'f1.png', worker: 'w1' }],
    nsfw: false,
    created_at: '2026-08-14T00:00:00',
    updated_at: '2026-08-14T00:00:00',
    ...overrides,
  };
}

describe('资产类别字典', () => {
  it('四类齐全：角色/场景/道具/风格', () => {
    expect(ASSET_KINDS.map((k) => k.key)).toEqual(['character', 'scene', 'prop', 'style']);
  });

  it('assetKindLabel 中文映射，未知 kind 原样返回', () => {
    expect(assetKindLabel('character')).toBe('角色');
    expect(assetKindLabel('style')).toBe('风格');
    expect(assetKindLabel('unknown')).toBe('unknown');
  });
});

describe('filterAssetsByKind', () => {
  const list = [
    makeAsset({ id: 'a1', kind: 'character' }),
    makeAsset({ id: 'a2', kind: 'scene' }),
    makeAsset({ id: 'a3', kind: 'character' }),
  ];

  it('all 不过滤', () => {
    expect(filterAssetsByKind(list, 'all')).toHaveLength(3);
  });

  it('按 kind 过滤', () => {
    const chars = filterAssetsByKind(list, 'character');
    expect(chars.map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(filterAssetsByKind(list, 'prop')).toHaveLength(0);
  });
});

describe('validateAssetDraft（本地先验）', () => {
  it('名称为空（含纯空格）拦截', () => {
    expect(validateAssetDraft({ name: '', images: [{}] })).toBe('请填写资产名称');
    expect(validateAssetDraft({ name: '   ', images: [{}] })).toBe('请填写资产名称');
  });

  it('名称超 100 字拦截', () => {
    expect(validateAssetDraft({ name: 'x'.repeat(101), images: [{}] })).toContain('100');
  });

  it('图片 0 张拦截', () => {
    expect(validateAssetDraft({ name: 'ok', images: [] })).toBe('请至少上传 1 张参考图');
  });

  it('图片超 4 张拦截', () => {
    const images = Array.from({ length: ASSET_IMAGES_MAX + 1 }, () => ({}));
    expect(validateAssetDraft({ name: 'ok', images })).toContain('4');
  });

  it('合法草稿通过（空串）', () => {
    expect(validateAssetDraft({ name: '主角卡', images: [{}] })).toBe('');
  });
});

describe('assetToDraft（编辑回显映射）', () => {
  it('字段逐项回显，图片句柄原样保留（不重新上传）', () => {
    const asset = makeAsset({
      kind: 'scene',
      name: '雨夜霓虹',
      description: '赛博街区',
      nsfw: true,
      images: [
        { filename: 'a.png', worker: 'w1' },
        { filename: 'b.png', worker: 'w1' },
      ],
    });
    expect(assetToDraft(asset)).toEqual({
      kind: 'scene',
      name: '雨夜霓虹',
      description: '赛博街区',
      nsfw: true,
      images: [
        { filename: 'a.png', worker: 'w1' },
        { filename: 'b.png', worker: 'w1' },
      ],
    });
  });
});

describe('buildAssetPatch（部分更新差量）', () => {
  const original = makeAsset();

  it('无变更 → 空 patch', () => {
    expect(buildAssetPatch(original, assetToDraft(original))).toEqual({});
  });

  it('仅改名 → 只带 name（trim 后比较）', () => {
    const draft = { ...assetToDraft(original), name: '  新名字  ' };
    expect(buildAssetPatch(original, draft)).toEqual({ name: '新名字' });
  });

  it('kind / nsfw / description 差量', () => {
    const draft = {
      ...assetToDraft(original),
      kind: 'style' as const,
      nsfw: true,
      description: '新描述',
    };
    expect(buildAssetPatch(original, draft)).toEqual({
      kind: 'style',
      nsfw: true,
      description: '新描述',
    });
  });

  it('图片增删/换序 → 带 images；同内容不带', () => {
    const removed = { ...assetToDraft(original), images: [] };
    expect(buildAssetPatch(original, removed)).toEqual({ images: [] });
    const same = assetToDraft(original);
    expect(buildAssetPatch(original, same).images).toBeUndefined();
  });
});

describe('appendAssetImage（创作页多图字段追加拦截）', () => {
  const first = { filename: 'f1.png', worker: 'w1' };

  it('空字段直接追加', () => {
    const res = appendAssetImage([], first, 4);
    expect(res).toEqual({ ok: true, images: [first] });
  });

  it('同 worker 追加成功（资产多张图可重复点选）', () => {
    const second = { filename: 'f2.png', worker: 'w1' };
    const res = appendAssetImage([first], second, 4);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.images).toHaveLength(2);
  });

  it('达上限拦截（wan-vace 1-4 张）', () => {
    const full = Array.from({ length: 4 }, (_, i) => ({ filename: `f${i}.png`, worker: 'w1' }));
    expect(appendAssetImage(full, { filename: 'x.png', worker: 'w1' }, 4)).toEqual({
      ok: false,
      reason: 'limit',
    });
  });

  it('跨 worker 拦截（资产句柄已带落点，混钉破坏生成同机）', () => {
    expect(appendAssetImage([first], { filename: 'x.png', worker: 'w2' }, 4)).toEqual({
      ok: false,
      reason: 'worker',
    });
  });
});
