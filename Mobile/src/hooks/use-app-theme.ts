import { useColorScheme } from 'react-native';

import { useSettingsStore } from '@/stores/settings';
import { elevation, getPalette, radius, spacing, typography } from '@/theme/tokens';
import type { Palette } from '@/theme/tokens';

/** 组件消费的主题包：色板 + 全部设计 Token（指南第三节） */
export interface AppTheme {
  colors: Palette;
  resolvedMode: 'light' | 'dark';
  isDark: boolean;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  elevation: typeof elevation;
}

/**
 * 取当前生效主题。
 * mode='system' 时跟随系统；默认 'light'（浅色优先原则）
 */
export function useAppTheme(): AppTheme {
  const paletteId = useSettingsStore((s) => s.paletteId);
  const mode = useSettingsStore((s) => s.mode);
  const system = useColorScheme();
  const resolvedMode: 'light' | 'dark' =
    mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;
  return {
    colors: getPalette(paletteId, resolvedMode),
    resolvedMode,
    isDark: resolvedMode === 'dark',
    spacing,
    radius,
    typography,
    elevation,
  };
}
