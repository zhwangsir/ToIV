/**
 * 设置 store：主题预设 / 深浅模式 / 自定义强调色 / API 基址 / NSFW 意图
 * P4 2026-09-07：对齐 web 主题系统 v9（minimal/cinema/paper/graphite + accent）
 * - 默认 minimal + light（浅色优先）
 * - 旧 palette-* 持久化值在 restore 时迁移到 v9 预设
 * - uni storage 持久化，启动时恢复并桥接回 api 模块级状态
 */
import { defineStore } from 'pinia';

import { setNsfwIntent as bridgeNsfwIntent } from '@/api/client';
import { setApiBaseOverride } from '@/api/config';
import {
  DEFAULT_THEME_ID,
  isAccentHex,
  normalizeThemeId,
  type ThemePresetId,
} from '@/theme/tokens';
import { getJson, setJson } from '@/utils/storage';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'toiv.settings';

interface SettingsState {
  /** v9 预设 id（持久化字段名仍用 paletteId 兼容旧 storage） */
  paletteId: ThemePresetId;
  mode: ThemeMode;
  /** 自定义强调色 hex6；null = 主题默认 */
  accentCustom: string | null;
  apiBaseOverride: string | null;
  nsfwIntent: boolean;
}

interface PersistedSettings {
  paletteId?: string;
  themeId?: string;
  mode?: ThemeMode;
  accentCustom?: string | null;
  apiBaseOverride?: string | null;
  nsfwIntent?: boolean;
}

function persist(state: SettingsState): void {
  const snapshot: PersistedSettings = {
    paletteId: state.paletteId,
    themeId: state.paletteId,
    mode: state.mode,
    accentCustom: state.accentCustom,
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
    paletteId: DEFAULT_THEME_ID,
    mode: 'light',
    accentCustom: null,
    apiBaseOverride: null,
    nsfwIntent: false,
  }),

  getters: {
    themeId(state): ThemePresetId {
      return state.paletteId;
    },
  },

  actions: {
    /** 冷启动恢复一次（App onLaunch）：读 storage → 填 state → 桥接副作用 */
    restore() {
      const saved = getJson<PersistedSettings>(STORAGE_KEY);
      if (saved) {
        const rawId = saved.themeId ?? saved.paletteId;
        this.paletteId = normalizeThemeId(rawId);
        this.mode = saved.mode ?? 'light';
        this.accentCustom = isAccentHex(saved.accentCustom ?? null)
          ? (saved.accentCustom as string)
          : null;
        this.apiBaseOverride = saved.apiBaseOverride ?? null;
        this.nsfwIntent = saved.nsfwIntent ?? false;
      }
      applySideEffects(this);
      // 写回规范化后的 id，完成旧色板迁移落盘
      persist(this);
    },

    setTheme(id: string) {
      this.paletteId = normalizeThemeId(id);
      persist(this);
    },

    /** @deprecated 用 setTheme；保留别名兼容旧调用 */
    setPalette(id: string) {
      this.setTheme(id);
    },

    setMode(mode: ThemeMode) {
      this.mode = mode;
      persist(this);
    },

    setAccentCustom(hex: string | null) {
      this.accentCustom = isAccentHex(hex) ? hex : null;
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
