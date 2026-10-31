import { beforeEach, describe, expect, it } from 'vitest';

import {
  apiFetch,
  DEFAULT_TIMEOUT_MS,
  getToken,
  LONG_TIMEOUT_MS,
  mediaUrl,
  setNsfwIntent,
  setToken,
} from '@/api/client';
import { DEFAULT_API_BASE, resolveApiBase, setApiBaseOverride } from '@/api/config';
import {
  enqueueResponse,
  installMockUni,
  lastRequest,
  setRequestError,
} from './helpers/mock-uni';

beforeEach(() => {
  installMockUni();
  setToken(null);
  setApiBaseOverride(null);
  setNsfwIntent(false);
});

describe('token 存取', () => {
  it('setToken 写入 storage 并更新内存镜像', () => {
    setToken('abc');
    expect(getToken()).toBe('abc');
    expect(uni.getStorageSync('toiv_token')).toBe('abc');
  });

  it('setToken(null) 清除 token', () => {
    setToken('abc');
    setToken(null);
    expect(getToken()).toBeNull();
    expect(uni.getStorageSync('toiv_token')).toBe('');
  });
});

describe('resolveApiBase', () => {
  it('默认回落 DEFAULT_API_BASE', () => {
    expect(resolveApiBase()).toBe(DEFAULT_API_BASE);
  });

  it('用户覆盖优先', () => {
    setApiBaseOverride('https://api.example.com');
    expect(resolveApiBase()).toBe('https://api.example.com');
  });

  it('空白覆盖视为无效', () => {
    setApiBaseOverride('   ');
    expect(resolveApiBase()).toBe(DEFAULT_API_BASE);
  });
});

describe('mediaUrl', () => {
  it('相对路径拼 base 并附带 token', () => {
    setToken('tk');
    expect(mediaUrl('/output/a.png')).toBe(`${DEFAULT_API_BASE}/output/a.png?token=tk`);
  });

  it('绝对 http 地址不拼 base 但仍带 token', () => {
    setToken('tk');
    expect(mediaUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png?token=tk',
    );
  });

  it('无 token 原样返回拼接结果', () => {
    expect(mediaUrl('output/a.png')).toBe(`${DEFAULT_API_BASE}/output/a.png`);
  });

  it('空串原样返回', () => {
    expect(mediaUrl('')).toBe('');
  });
});

describe('apiFetch', () => {
  it('GET 成功返回 JSON，携带 Authorization 与 JSON Accept', async () => {
    setToken('tk');
    enqueueResponse(200, { ok: true });
    const res = await apiFetch<{ ok: boolean }>('/api/test');
    expect(res.ok).toBe(true);
    const call = lastRequest();
    expect(call.method).toBe('GET');
    expect(call.header.Authorization).toBe('Bearer tk');
    expect(call.header.Accept).toBe('application/json');
    expect(call.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('POST body 自动设 Content-Type json', async () => {
    enqueueResponse(200, {});
    await apiFetch('/api/x', { method: 'POST', body: { a: 1 } });
    expect(lastRequest().header['Content-Type']).toBe('application/json');
    expect(lastRequest().data).toEqual({ a: 1 });
  });

  it('long 请求放宽超时到 180s', async () => {
    enqueueResponse(200, {});
    await apiFetch('/api/x', { long: true });
    expect(lastRequest().timeout).toBe(LONG_TIMEOUT_MS);
  });

  it('nsfw 意图注入 X-NSFW 头（全局与单次覆盖）', async () => {
    setNsfwIntent(true);
    enqueueResponse(200, {});
    await apiFetch('/api/a');
    expect(lastRequest().header['X-NSFW']).toBe('1');

    enqueueResponse(200, {});
    await apiFetch('/api/b', { nsfw: false });
    expect(lastRequest().header['X-NSFW']).toBeUndefined();
  });

  it('401 抛 ApiError(401) 人话文案', async () => {
    enqueueResponse(401, {});
    await expect(apiFetch('/api/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      message: '登录已过期，请重新登录',
    });
  });

  it('后端 detail 作为兜底文案', async () => {
    enqueueResponse(400, { detail: '参数不合法' });
    await expect(apiFetch('/api/x')).rejects.toMatchObject({
      status: 400,
      message: '参数不合法',
    });
  });

  it('500 走通用服务不可用文案', async () => {
    enqueueResponse(500, {});
    await expect(apiFetch('/api/x')).rejects.toMatchObject({
      status: 500,
      message: '服务暂时不可用，请稍后重试',
    });
  });

  it('网络 fail → ApiError(0)', async () => {
    setRequestError('request:fail');
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ status: 0 });
  });

  it('超时 fail → 超时文案', async () => {
    setRequestError('request:fail timeout');
    await expect(apiFetch('/api/x')).rejects.toMatchObject({
      status: 0,
      message: '请求超时，请检查网络后重试',
    });
  });

  it('204 返回 undefined', async () => {
    enqueueResponse(204, '');
    const res = await apiFetch<undefined>('/api/x');
    expect(res).toBeUndefined();
  });
});
