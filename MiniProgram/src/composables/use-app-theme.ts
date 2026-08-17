/**
 * 应用主题 composable
 * - 小程序无法运行时改全局 CSS 变量，改为每页根节点 :style="themeVars" 注入
 * - mode=system 跟随 uni.getSystemInfoSync().theme（不支持的平台回落 light）
 * - 浅色优先：默认 palette-01 + light
 */
import { computed } from 'vue';

import { useSettingsStore } from '@/stores/settings';
import { getPalette, radius, spacing, toRpx, typography } from '@/theme/tokens';

function systemIsDark(): boolean {
  try {
    const info = uni.getSystemInfoSync() as { theme?: string };
    return info.theme === 'dark';
  } catch {
    return false;
  }
}

export function useAppTheme() {
  const settings = useSettingsStore();

  const isDark = computed(() =>
    settings.mode === 'system' ? systemIsDark() : settings.mode === 'dark',
  );

  const palette = computed(() => getPalette(settings.paletteId, isDark.value ? 'dark' : 'light'));

  /** 页面根节点注入用 CSS 变量表（rpx 单位） */
  const themeVars = computed(() => ({
    '--color-bg': palette.value.bg,
    '--color-surface': palette.value.surface,
    '--color-border': palette.value.border,
    '--color-text': palette.value.text,
    '--color-text-secondary': palette.value.textSecondary,
    '--color-accent': palette.value.accent,
    '--color-accent-soft': palette.value.accentSoft,
    '--color-success': palette.value.success,
    '--color-warning': palette.value.warning,
    '--color-danger': palette.value.danger,
    '--space-1': toRpx(spacing[1]),
    '--space-2': toRpx(spacing[2]),
    '--space-3': toRpx(spacing[3]),
    '--space-4': toRpx(spacing[4]),
    '--space-5': toRpx(spacing[5]),
    '--space-6': toRpx(spacing[6]),
    '--space-8': toRpx(spacing[8]),
    '--radius-sm': toRpx(radius.sm),
    '--radius-md': toRpx(radius.md),
    '--radius-lg': toRpx(radius.lg),
    '--radius-xl': toRpx(radius.xl),
    '--font-display': toRpx(typography.display.fontSize),
    '--font-title': toRpx(typography.title.fontSize),
    '--font-heading': toRpx(typography.heading.fontSize),
    '--font-body': toRpx(typography.body.fontSize),
    '--font-caption': toRpx(typography.caption.fontSize),
  }));

  return { isDark, palette, themeVars };
}
