import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { setNsfwIntent as bridgeNsfwIntent } from '@/lib/api';
import { setApiBaseOverride } from '@/lib/config';
import { zustandStorage } from '@/lib/mmkv';
import { DEFAULT_PALETTE_ID } from '@/theme/tokens';

/**
 * 设置 store：色板 / 深浅模式 / API 基址覆盖 / NSFW 意图
 * - 默认浅色（UI/UX 指南 1.2：本项目默认浅色，深色为平等质量可选项）
 * - MMKV 同步持久化，水合在 create() 期间即完成，首帧渲染前生效
 * - apiBaseOverride / nsfwIntent 需桥接回 lib 模块级状态（apiFetch 读取的是模块变量）
 */
export type ThemeMode = 'light' | 'dark' | 'system';

interface SettingsState {
  paletteId: string;
  mode: ThemeMode;
  apiBaseOverride: string | null;
  nsfwIntent: boolean;
  setPalette: (id: string) => void;
  setMode: (mode: ThemeMode) => void;
  setApiBase: (base: string | null) => void;
  setNsfw: (on: boolean) => void;
}

/** 把持久化字段桥接回 lib 模块级状态（恢复或变更时都走这里） */
function applySideEffects(state: {
  apiBaseOverride: string | null;
  nsfwIntent: boolean;
}): void {
  setApiBaseOverride(state.apiBaseOverride);
  bridgeNsfwIntent(state.nsfwIntent);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      paletteId: DEFAULT_PALETTE_ID,
      mode: 'light',
      apiBaseOverride: null,
      nsfwIntent: false,
      setPalette: (id) => set({ paletteId: id }),
      setMode: (mode) => set({ mode }),
      setApiBase: (base) => {
        set({ apiBaseOverride: base });
        applySideEffects({ apiBaseOverride: base, nsfwIntent: useSettingsStore.getState().nsfwIntent });
      },
      setNsfw: (on) => {
        set({ nsfwIntent: on });
        applySideEffects({ apiBaseOverride: useSettingsStore.getState().apiBaseOverride, nsfwIntent: on });
      },
    }),
    {
      name: 'toiv.settings',
      storage: createJSONStorage(() => zustandStorage),
      partialize: (s) => ({
        paletteId: s.paletteId,
        mode: s.mode,
        apiBaseOverride: s.apiBaseOverride,
        nsfwIntent: s.nsfwIntent,
      }),
      onRehydrateStorage: () => (state) => {
        // 冷启动恢复后桥接一次，保证 apiFetch 读到持久化的覆盖值
        if (state) applySideEffects(state);
      },
    },
  ),
);
