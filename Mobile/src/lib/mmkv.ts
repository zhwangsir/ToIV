import { createMMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

/**
 * 全局 MMKV 实例（同步读写，用于客户端全局状态持久化）
 * 🔒 认证 token 禁止落这里 —— token 只走 expo-secure-store（lib/api.ts，开发规范禁令 3）
 */
export const storage = createMMKV({ id: 'toiv-app' });

/** zustand persist 的 MMKV 适配器（MMKV 同步，故 persist 水合也是同步完成） */
export const zustandStorage: StateStorage = {
  getItem: (name) => storage.getString(name) ?? null,
  setItem: (name, value) => {
    storage.set(name, value);
  },
  removeItem: (name) => {
    storage.remove(name);
  },
};
