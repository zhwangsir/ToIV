import { beforeEach, describe, expect, it } from 'vitest';

import {
  assetImageUrl,
  createAsset,
  deleteAsset,
  getAsset,
  listAssets,
  updateAsset,
} from '@/api';
import { setApiBaseOverride } from '@/api/config';
import { setNsfwIntent, setToken } from '@/api/client';
import type { AssetItem } from '@/types/api';
import { enqueueResponse, installMockUni, lastRequest } from './helpers/mock-uni';

const asset: AssetItem = {
  id: 'a1',
  kind: 'character',
  name: '主角卡',
  description: '胶片风少女',
  images: [{ filename: 'f1.png', worker: 'w1' }],
  nsfw: false,
  created_at: '2026-08-14T00:00:00',
  updated_at: '2026-08-14T00:00:00',
};

beforeEach(() => {
  installMockUni();
  setToken(null);
  setApiBaseOverride(null);
  setNsfwIntent(false);
});

describe('listAssets', () => {
  it('无 kind：GET /api/assets', async () => {
    enqueueResponse(200, [asset]);
    const list = await listAssets();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('a1');
    expect(lastRequest().method).toBe('GET');
    expect(lastRequest().url).toContain('/api/assets');
    expect(lastRequest().url).not.toContain('kind=');
  });

  it('带 kind：过滤条件走 query string', async () => {
    enqueueResponse(200, []);
    await listAssets('scene');
    expect(lastRequest().url).toContain('/api/assets?kind=scene');
  });
});

describe('createAsset', () => {
  it('POST /api/assets，body 原样序列化', async () => {
    enqueueResponse(200, asset);
    const body = {
      kind: 'character' as const,
      name: '主角卡',
      description: '胶片风少女',
      images: [{ filename: 'f1.png', worker: 'w1' }],
      nsfw: false,
    };
    const created = await createAsset(body);
    expect(created.id).toBe('a1');
    expect(lastRequest().method).toBe('POST');
    expect(lastRequest().url).toContain('/api/assets');
    expect(lastRequest().data).toEqual(body);
  });

  it('422 detail 数组透传首条 msg（名称/图片数越界兜底）', async () => {
    enqueueResponse(422, {
      detail: [{ msg: 'ensure this value has at most 4 items', type: 'too_long' }],
    });
    await expect(
      createAsset({ kind: 'prop', name: 'x', description: '', images: [], nsfw: false }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'ensure this value has at most 4 items',
    });
  });
});

describe('getAsset', () => {
  it('GET /api/assets/{id}，id 转义', async () => {
    enqueueResponse(200, asset);
    await getAsset('a/1');
    expect(lastRequest().method).toBe('GET');
    expect(lastRequest().url).toContain('/api/assets/a%2F1');
  });

  it('404 人话透传（他人资产/SFW 上下文 nsfw 资产防枚举）', async () => {
    enqueueResponse(404, { detail: '资产不存在' });
    await expect(getAsset('nope')).rejects.toMatchObject({
      status: 404,
      message: '资源不存在或已被清理',
    });
  });
});

describe('updateAsset', () => {
  it('PATCH /api/assets/{id}，差量 body', async () => {
    enqueueResponse(200, { ...asset, name: '改名' });
    const updated = await updateAsset('a1', { name: '改名' });
    expect(updated.name).toBe('改名');
    expect(lastRequest().method).toBe('PATCH');
    expect(lastRequest().url).toContain('/api/assets/a1');
    expect(lastRequest().data).toEqual({ name: '改名' });
  });
});

describe('deleteAsset', () => {
  it('DELETE /api/assets/{id}', async () => {
    enqueueResponse(200, { ok: true, id: 'a1' });
    await deleteAsset('a1');
    expect(lastRequest().method).toBe('DELETE');
    expect(lastRequest().url).toContain('/api/assets/a1');
  });
});

describe('assetImageUrl', () => {
  it('拼代理路径，无 token 时原样', () => {
    const url = assetImageUrl('a1', 0);
    expect(url).toContain('/api/assets/a1/images/0');
    expect(url).not.toContain('token=');
  });

  it('有 token 时自动拼 query（媒体标签无法带请求头）', () => {
    setToken('tk-9');
    const url = assetImageUrl('a1', 3);
    expect(url).toContain('/api/assets/a1/images/3');
    expect(url).toContain('token=tk-9');
  });
});
