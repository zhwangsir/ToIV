/**
 * 设置 store：色板 / 深浅模式 / API 基址覆盖 / NSFW 意图（对齐 Mobile stores/settings.ts）
 * - 默认浅色（UI/UX 指南：本项目默认浅色，深色为平等质量可选项）
 * - uni storage 持久化，启动时恢复并桥接回 api 模块级状态
 */
import { defineStore } from 'pinia';

import { setNsfwIntent as bridgeNsfwIntent } from '@/api/client';
import { setApiBaseOverride } from '@/api/config';
import { DEFAULT_PALETTE_ID } from '@/theme/tokens';
import { getJson, setJson } from '@/utils/storage';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'toiv.settings';

interface SettingsState {
  paletteId: string;
  mode: ThemeMode;
  apiBaseOverride: string | null;
  nsfwIntent: boolean;
}

interface PersistedSettings {
  paletteId: string;
  mode: ThemeMode;
  apiBaseOverride: string | null;
  nsfwIntent: boolean;
}

function persist(state: SettingsState): void {
  const snapshot: PersistedSettings = {
    paletteId: state.paletteId,
    mode: state.mode,
    apiBaseOverride: state.apiBaseOverride,
    nsfwIntent: state.nsfwIntent,
  };
  setJson(STORAGE_KEY, snapshot);
}

/** 把字段桥接回 api 模块级状态（恢复或变更时都走这里） */
function applySideEffects(state: {
  apiBaseOverride: string | null;
  nsfwIntent: boolean;
}): void {
  setApiBaseOverride(state.apiBaseOverride);
  bridgeNsfwIntent(state.nsfwIntent);
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({
    paletteId: DEFAULT_PALETTE_ID,
    mode: 'light',
    apiBaseOverride: null,
    nsfwIntent: false,
  }),

  actions: {
    /** 冷启动恢复一次（App onLaunch）：读 storage → 填 state → 桥接副作用 */
    restore() {
      const saved = getJson<PersistedSettings>(STORAGE_KEY);
      if (saved) {
        this.paletteId = saved.paletteId ?? DEFAULT_PALETTE_ID;
        this.mode = saved.mode ?? 'light';
        this.apiBaseOverride = saved.apiBaseOverride ?? null;
        this.nsfwIntent = saved.nsfwIntent ?? false;
      }
      applySideEffects(this);
    },

    setPalette(id: string) {
      this.paletteId = id;
      persist(this);
    },

    setMode(mode: ThemeMode) {
      this.mode = mode;
      persist(this);
    },

    setApiBase(base: string | null) {
      this.apiBaseOverride = base;
      applySideEffects(this);
      persist(this);
    },

    setNsfw(on: boolean) {
      this.nsfwIntent = on;
      applySideEffects(this);
      persist(this);
    },
  },
});
