import { setToken } from '@/lib/api';
import { getJobSseCreds, registerJobSseCreds } from '@/features/jobs/job-sse-registry';
import { storage } from '@/lib/mmkv';

import { useAuthStore } from '../auth';

// expo-secure-store 在 jest 环境无原生实现，用内存 Map 模拟
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

// API 基址固定，避免依赖 expo-constants 真值
jest.mock('@/lib/config', () => ({
  resolveApiBase: () => 'https://api.test',
}));

const mockFetch = jest.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

const USER = { id: 'u1', email: 'a@b.c', role: 'user' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('auth store', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    storage.clearAll();
    await setToken(null);
    useAuthStore.setState({ status: 'restoring', user: null });
  });

  it('无 token：restore 直接落定 signedOut，不发请求', async () => {
    await useAuthStore.getState().restore();
    expect(useAuthStore.getState().status).toBe('signedOut');
    expect(useAuthStore.getState().user).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('有 token 且 /auth/me 通过：signedIn 并缓存用户快照', async () => {
    await setToken('tk-ok');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { user: USER, usage: {} }));

    await useAuthStore.getState().restore();

    expect(useAuthStore.getState().status).toBe('signedIn');
    expect(useAuthStore.getState().user).toEqual(USER);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/auth/me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk-ok');
    // 快照已写入 MMKV
    expect(storage.getString('toiv.cachedUser')).toContain('a@b.c');
  });

  it('/auth/me 返回 401：清 token、清快照、落定 signedOut', async () => {
    await setToken('tk-expired');
    storage.set('toiv.cachedUser', JSON.stringify(USER));
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { detail: 'expired' }));

    await useAuthStore.getState().restore();

    expect(useAuthStore.getState().status).toBe('signedOut');
    expect(useAuthStore.getState().user).toBeNull();
    expect(storage.getString('toiv.cachedUser')).toBeUndefined();
  });

  it('弱网且 /auth/me 不可达：有缓存用户则保持会话（弱网兜底）', async () => {
    await setToken('tk-ok');
    storage.set('toiv.cachedUser', JSON.stringify(USER));
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await useAuthStore.getState().restore();

    expect(useAuthStore.getState().status).toBe('signedIn');
    expect(useAuthStore.getState().user).toEqual(USER);
  });

  it('弱网且无缓存用户：落定 signedOut', async () => {
    await setToken('tk-ok');
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await useAuthStore.getState().restore();

    expect(useAuthStore.getState().status).toBe('signedOut');
  });

  it('signIn 成功：写 secure store + 快照 + signedIn', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { token: 'tk-new', user: USER }));

    await useAuthStore.getState().signIn('a@b.c', 'pw');

    expect(useAuthStore.getState().status).toBe('signedIn');
    expect(useAuthStore.getState().user).toEqual(USER);
    expect(storage.getString('toiv.cachedUser')).toContain('u1');
  });

  it('signOut：清 token 与快照，落定 signedOut', async () => {
    useAuthStore.setState({ status: 'signedIn', user: USER });
    await setToken('tk-x');
    storage.set('toiv.cachedUser', JSON.stringify(USER));

    await useAuthStore.getState().signOut();

    expect(useAuthStore.getState().status).toBe('signedOut');
    expect(useAuthStore.getState().user).toBeNull();
    expect(storage.getString('toiv.cachedUser')).toBeUndefined();
  });

  it('signOut：清空会话内作业 SSE 凭据（M29.3，凭据不跨会话残留）', async () => {
    useAuthStore.setState({ status: 'signedIn', user: USER });
    registerJobSseCreds({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });

    await useAuthStore.getState().signOut();

    expect(getJobSseCreds('p1')).toBeNull();
  });
});
