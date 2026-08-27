import {
  ASSET_IMAGE_MAX,
  ASSET_KINDS,
  ASSET_NAME_MAX,
  ASSET_UPLOAD_KIND,
  assetKindIcon,
  assetKindLabel,
  buildAssetPatch,
  imageExtOf,
  validateAssetDraft,
  validateImagePick,
} from '../asset-utils';
import type { AssetItem } from '@/types/api';

describe('资产类别注册表（M13）', () => {
  it('四类齐备且顺序对齐后端 Literal 声明', () => {
    expect(ASSET_KINDS.map((k) => k.key)).toEqual(['character', 'scene', 'prop', 'style']);
  });

  it('assetKindLabel 中文短标签，未知 kind 兜底「其他」', () => {
    expect(assetKindLabel('character')).toBe('角色');
    expect(assetKindLabel('scene')).toBe('场景');
    expect(assetKindLabel('prop')).toBe('道具');
    expect(assetKindLabel('style')).toBe('风格');
    expect(assetKindLabel('unknown')).toBe('其他');
  });

  it('assetKindIcon 注册表图标，未知 kind 兜底 Layers', () => {
    expect(assetKindIcon('character')).toBe('UserRound');
    expect(assetKindIcon('style')).toBe('Palette');
    expect(assetKindIcon('unknown')).toBe('Layers');
  });

  it('常量与后端边界同源：图片 ≤4 / 名称 ≤100 / 上传 kind=img2img（无能力门槛）', () => {
    expect(ASSET_IMAGE_MAX).toBe(4);
    expect(ASSET_NAME_MAX).toBe(100);
    expect(ASSET_UPLOAD_KIND).toBe('img2img');
  });
});

describe('imageExtOf（扩展名推断）', () => {
  it('fileName 优先', () => {
    expect(imageExtOf('a.PNG', undefined)).toBe('png');
    expect(imageExtOf('b.jpeg', 'image/png')).toBe('jpeg');
  });

  it('fileName 缺失时按 mimeType 推断', () => {
    expect(imageExtOf(null, 'image/webp')).toBe('webp');
    expect(imageExtOf(undefined, 'image/jpeg')).toBe('jpg');
  });

  it('识别不出返回空串（交给白名单拦截）', () => {
    expect(imageExtOf(null, undefined)).toBe('');
    expect(imageExtOf('noext', 'application/octet-stream')).toBe('');
  });
});

describe('validateImagePick（单张选图先验）', () => {
  it('合法 jpg/png/webp 且 ≤20MB 通过', () => {
    expect(validateImagePick({ fileName: 'a.png', fileSize: 1024 })).toBeNull();
    expect(validateImagePick({ fileName: null, mimeType: 'image/webp' })).toBeNull();
  });

  it('拒绝白名单外扩展名（gif）', () => {
    expect(validateImagePick({ fileName: 'a.gif', mimeType: 'image/gif' })).toBe(
      '仅支持 jpg / png / webp 图片',
    );
  });

  it('拒绝 >20MB；fileSize 缺失时不拦截（后端兜底）', () => {
    expect(
      validateImagePick({ fileName: 'a.png', fileSize: 21 * 1024 * 1024 }),
    ).toBe('图片超过 20MB 上限');
    expect(validateImagePick({ fileName: 'a.png' })).toBeNull();
  });
});

describe('validateAssetDraft（表单先验：上限与必填）', () => {
  const img = { filename: 'a.png', worker: 'w1' };

  it('名称空（含全空白 trim 后）拦截', () => {
    expect(validateAssetDraft({ name: '   ', images: [img] })).toBe('请填写资产名称');
  });

  it('名称超 100 字拦截', () => {
    expect(validateAssetDraft({ name: 'x'.repeat(101), images: [img] })).toBe(
      '名称不能超过 100 字',
    );
  });

  it('图片 0 张拦截', () => {
    expect(validateAssetDraft({ name: '女主-A', images: [] })).toBe('请至少添加 1 张参考图');
  });

  it('图片超 4 张拦截（后端硬上限同源）', () => {
    expect(validateAssetDraft({ name: '女主-A', images: [img, img, img, img, img] })).toBe(
      '参考图最多 4 张',
    );
  });

  it('1-4 张 + 名称合规放行', () => {
    expect(validateAssetDraft({ name: '女主-A', images: [img] })).toBeNull();
    expect(validateAssetDraft({ name: '女主-A', images: [img, img, img, img] })).toBeNull();
  });
});

describe('buildAssetPatch（编辑态部分更新映射）', () => {
  const original: AssetItem = {
    id: 'as-1',
    kind: 'character',
    name: '女主-A',
    description: '银发蓝瞳',
    images: [
      { filename: 'a.png', worker: 'http://w1' },
      { filename: 'b.png', worker: 'http://w1' },
    ],
    nsfw: false,
    created_at: '2026-08-14T10:00:00',
    updated_at: '2026-08-14T10:00:00',
  };
  const sameDraft = {
    kind: 'character' as const,
    name: '女主-A',
    description: '银发蓝瞳',
    images: [
      { filename: 'a.png', worker: 'http://w1' },
      { filename: 'b.png', worker: 'http://w1' },
    ],
    nsfw: false,
  };

  it('无任何变化返回空 patch（调用侧据此省一次请求）', () => {
    expect(buildAssetPatch(original, sameDraft)).toEqual({});
  });

  it('名称/description 先 trim 再比对（尾部空白不算变化）', () => {
    expect(buildAssetPatch(original, { ...sameDraft, name: '女主-A  ' })).toEqual({});
    expect(buildAssetPatch(original, { ...sameDraft, description: '银发蓝瞳\n' })).toEqual({});
  });

  it('单字段变化仅携带该字段', () => {
    expect(buildAssetPatch(original, { ...sameDraft, name: '女主-B' })).toEqual({
      name: '女主-B',
    });
    expect(buildAssetPatch(original, { ...sameDraft, kind: 'scene' })).toEqual({ kind: 'scene' });
    expect(buildAssetPatch(original, { ...sameDraft, nsfw: true })).toEqual({ nsfw: true });
  });

  it('images 按 (filename, worker) 有序逐项比对：换人/换序/增删均整体替换', () => {
    // 换 worker
    expect(
      buildAssetPatch(original, {
        ...sameDraft,
        images: [
          { filename: 'a.png', worker: 'http://w2' },
          { filename: 'b.png', worker: 'http://w1' },
        ],
      }),
    ).toEqual({
      images: [
        { filename: 'a.png', worker: 'http://w2' },
        { filename: 'b.png', worker: 'http://w1' },
      ],
    });
    // 删一张
    expect(
      buildAssetPatch(original, { ...sameDraft, images: [{ filename: 'a.png', worker: 'http://w1' }] }),
    ).toEqual({ images: [{ filename: 'a.png', worker: 'http://w1' }] });
  });

  it('多字段同时变化合并进同一 patch', () => {
    expect(
      buildAssetPatch(original, {
        ...sameDraft,
        name: '女主-B',
        kind: 'style',
        description: '',
        nsfw: true,
      }),
    ).toEqual({ name: '女主-B', kind: 'style', description: '', nsfw: true });
  });
});
