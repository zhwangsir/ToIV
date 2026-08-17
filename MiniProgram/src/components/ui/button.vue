<script setup lang="ts">
/**
 * 按钮（四态完备：默认/按压/禁用/加载，对齐 Mobile Button 语义）
 * 变体：primary（强调填充）/ secondary（描边）/ ghost（无框）
 * 尺寸：md 48pt 高 / sm 36pt 高；触碰热区不低于 48pt
 * 事件契约：对外只发 click——uni 编译器把模板 @tap 统一映射成 onClick prop，
 * 组件若 emit('tap') 父级永远收不到（tap ∉ 映射后事件名）
 */
import { computed } from 'vue';

import Icon from './icon.vue';

const props = withDefaults(
  defineProps<{
    label?: string;
    variant?: 'primary' | 'secondary' | 'ghost';
    size?: 'md' | 'sm';
    disabled?: boolean;
    loading?: boolean;
    block?: boolean;
    icon?: string;
  }>(),
  {
    variant: 'primary',
    size: 'md',
    disabled: false,
    loading: false,
    block: false,
  },
);

const emit = defineEmits<{ click: [] }>();

const interactive = computed(() => !props.disabled && !props.loading);

/** 图标色与 label 的 CSS color 对齐（data-URI SVG 拿不到 currentColor，需显式变量） */
const iconColor = computed(() => {
  if (props.variant === 'primary') return 'var(--color-surface)';
  if (props.variant === 'ghost') return 'var(--color-accent)';
  return 'var(--color-text)';
});

function handleTap() {
  if (!interactive.value) return;
  emit('click');
}
</script>

<template>
  <view
    class="ui-btn"
    :class="[
      `ui-btn--${variant}`,
      `ui-btn--${size}`,
      { 'ui-btn--block': block, 'ui-btn--disabled': !interactive },
    ]"
    :hover-class="interactive ? 'ui-btn--pressed' : 'none'"
    @tap="handleTap"
  >
    <Icon
      v-if="loading"
      name="loader-circle"
      :size="size === 'md' ? 36 : 28"
      :color="iconColor"
      class="ui-btn__spin"
    />
    <Icon
      v-else-if="icon"
      :name="icon"
      :size="size === 'md' ? 36 : 28"
      :color="iconColor"
    />
    <text class="ui-btn__label">
      <slot>{{ label }}</slot>
    </text>
  </view>
</template>

<style scoped lang="scss">
.ui-btn {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border-radius: var(--radius-md);
  font-size: var(--font-body);
  font-weight: 500;
  transition: opacity 0.15s ease, transform 0.15s ease;

  &--md {
    min-height: 96rpx;
    padding: 0 var(--space-6);
  }

  &--sm {
    min-height: 72rpx;
    padding: 0 var(--space-4);
    font-size: var(--font-caption);
  }

  &--block {
    display: flex;
    width: 100%;
  }

  &--primary {
    background: var(--color-accent);
    color: var(--color-surface);
  }

  &--secondary {
    background: transparent;
    color: var(--color-text);
    border: 1rpx solid var(--color-border);
  }

  &--ghost {
    background: transparent;
    color: var(--color-accent);
  }

  &--pressed {
    opacity: 0.82;
    transform: scale(0.985);
  }

  &--disabled {
    opacity: 0.45;
  }

  &__spin {
    animation: ui-btn-spin 1s linear infinite;
  }
}

@keyframes ui-btn-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
