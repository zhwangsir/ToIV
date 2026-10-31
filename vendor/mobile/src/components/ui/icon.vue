<script setup lang="ts">
/**
 * Lucide 图标统一封装（全项目唯一图标入口，开发规范禁令 1）
 * 小程序无内联 SVG：构建 data:image/svg+xml URI 经 <image> 渲染
 * 颜色以 stroke 注入 SVG 字符串，支持主题变量实参
 */
import { computed } from 'vue';

import { useAppTheme } from '@/composables/use-app-theme';
import type { Palette } from '@/theme/tokens';

import { ICON_PATHS } from './icons.generated';

const props = withDefaults(
  defineProps<{
    /** 白名单图标名（kebab-case，见 scripts/gen-icons.mjs） */
    name: string;
    /** 边长（rpx），默认 40rpx ≈ 20pt */
    size?: number;
    /** 描边色：支持字面量 / var(--color-*) / currentColor（=主题正文色） */
    color?: string;
    /** 描边宽度，默认 Lucide 标准 2 */
    strokeWidth?: number;
  }>(),
  {
    size: 40,
    color: 'currentColor',
    strokeWidth: 2,
  },
);

/**
 * data-URI SVG 在独立文档上下文渲染，CSS 变量与 currentColor 均不可达，
 * 必须在这里把 var(--color-*) / currentColor 折算成当前色板的具体 hex
 */
const VAR_TOKEN_MAP: Record<string, keyof Palette> = {
  '--color-bg': 'bg',
  '--color-surface': 'surface',
  '--color-border': 'border',
  '--color-text': 'text',
  '--color-text-secondary': 'textSecondary',
  '--color-accent': 'accent',
  '--color-accent-soft': 'accentSoft',
  '--color-success': 'success',
  '--color-warning': 'warning',
  '--color-danger': 'danger',
};

const { palette } = useAppTheme();

const resolvedColor = computed(() => {
  const raw = props.color.trim();
  if (raw === 'currentColor') return palette.value.text;
  const match = /^var\(\s*(--color-[\w-]+)\s*\)$/.exec(raw);
  if (match) {
    const key = VAR_TOKEN_MAP[match[1]];
    if (key) return palette.value[key];
  }
  return raw;
});

const src = computed(() => {
  const inner = ICON_PATHS[props.name];
  if (!inner) {
    console.warn(`[Icon] 未登记的图标: ${props.name}（请到 scripts/gen-icons.mjs 白名单登记）`);
    return '';
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"` +
    ` stroke="${resolvedColor.value}" stroke-width="${props.strokeWidth}"` +
    ` stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
});

const style = computed(() => ({
  width: `${props.size}rpx`,
  height: `${props.size}rpx`,
}));
</script>

<template>
  <image
    class="ui-icon"
    :src="src"
    :style="style"
    mode="aspectFit"
  />
</template>

<style scoped>
.ui-icon {
  display: inline-block;
  vertical-align: middle;
}
</style>
