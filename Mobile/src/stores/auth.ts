import { create } from 'zustand';

import { resetJobSseRegistry } from '@/features/jobs/job-sse-registry';
import { ApiError, fetchMe, getToken, login, logout } from '@/lib/api';
import { storage } from '@/lib/mmkv';
import type { AppUser } from '@/types/api';

/**
 * 认证 store：会话恢复 / 登录 / 登出
 * - token 只存 expo-secure-store（经 lib/api 读写），本 store 不直接触碰
 * - user 快照缓存到 MMKV：弱网时 restore 用缓存兜底保持会话，避免把人踢出
 * - 不走 zustand persist：恢复是异步流程（SecureStore + /auth/me 校验），persist 的同步水合语义不匹配
 */
const CACHED_USER_KEY = 'toiv.cachedUser';

export type AuthStatus = 'restoring' | 'signedOut' | 'signedIn';

interface AuthState {
  status: AuthStatus;
  user: AppUser | null;
  /** 冷启动调用一次：SecureStore 取 token → /auth/me 校验 → 落定终态 */
  restore: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

function readCachedUser(): AppUser | null {
  const raw = storage.getString(CACHED_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AppUser;
  } catch {
    // 缓存损坏按无缓存处理
    return null;
  }
}

function writeCachedUser(user: AppUser | null): void {
  if (user) storage.set(CACHED_USER_KEY, JSON.stringify(user));
  else storage.remove(CACHED_USER_KEY);
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: 'restoring',
  user: null,

  restore: async () => {
    const token = await getToken();
    if (!token) {
      set({ status: 'signedOut', user: null });
      return;
    }
    try {
      const me = await fetchMe();
      writeCachedUser(me.user);
      set({ status: 'signedIn', user: me.user });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // token 失效：清干净再踢回登录页
        await logout();
        writeCachedUser(null);
        set({ status: 'signedOut', user: null });
        return;
      }
      // 弱网/服务不可达：有缓存用户则保持会话（状态诚实由页面横幅表达）
      const cached = readCachedUser();
      if (cached) set({ status: 'signedIn', user: cached });
      else set({ status: 'signedOut', user: null });
    }
  },

  signIn: async (email, password) => {
    const result = await login(email, password);
    writeCachedUser(result.user);
    set({ status: 'signedIn', user: result.user });
  },

  signOut: async () => {
    resetJobSseRegistry(); // M29：会话内作业 SSE 凭据随会话清空
    await logout();
    writeCachedUser(null);
    set({ status: 'signedOut', user: null });
  },
}));
