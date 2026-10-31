/**
 * 认证 store：会话恢复 / 登录 / 登出（语义对齐 Mobile stores/auth.ts）
 * - token 只经 api/client 读写（uni storage），本 store 不直接触碰
 * - user 快照缓存到 storage：弱网时 restore 用缓存兜底保持会话，避免把人踢出
 */
import { defineStore } from 'pinia';

import { ApiError, getToken } from '@/api/client';
import { fetchMe, login, logout, wechatLogin } from '@/api';
import type { AppUser } from '@/types/api';
import { getJson, setJson, remove } from '@/utils/storage';

const CACHED_USER_KEY = 'toiv.cachedUser';

export type AuthStatus = 'restoring' | 'signedOut' | 'signedIn';

interface AuthState {
  status: AuthStatus;
  user: AppUser | null;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    status: 'restoring',
    user: null,
  }),

  getters: {
    isLoggedIn: (s) => s.status === 'signedIn',
  },

  actions: {
    /** 冷启动调用一次：storage 取 token → /auth/me 校验 → 落定终态 */
    async restore() {
      const token = getToken();
      if (!token) {
        this.status = 'signedOut';
        this.user = null;
        return;
      }
      try {
        const me = await fetchMe();
        setJson(CACHED_USER_KEY, me.user);
        this.status = 'signedIn';
        this.user = me.user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // token 失效：清干净再踢回登录页
          logout();
          remove(CACHED_USER_KEY);
          this.status = 'signedOut';
          this.user = null;
          return;
        }
        // 弱网/服务不可达：有缓存用户则保持会话（状态诚实由页面横幅表达）
        const cached = getJson<AppUser>(CACHED_USER_KEY);
        if (cached) {
          this.status = 'signedIn';
          this.user = cached;
        } else {
          this.status = 'signedOut';
          this.user = null;
        }
      }
    },

    async signIn(email: string, password: string) {
      const result = await login(email, password);
      setJson(CACHED_USER_KEY, result.user);
      this.status = 'signedIn';
      this.user = result.user;
    },

    /** 微信登录（MP31 保留备查）：code 换 token，状态落定与 signIn 逐行对齐 */
    async signInWithWechat(code: string) {
      const result = await wechatLogin(code);
      setJson(CACHED_USER_KEY, result.user);
      this.status = 'signedIn';
      this.user = result.user;
    },

    signOut() {
      logout();
      remove(CACHED_USER_KEY);
      this.status = 'signedOut';
      this.user = null;
    },
  },
});
