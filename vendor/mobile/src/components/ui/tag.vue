<script setup lang="ts">
/**
 * 状态标签（作业状态等语义色小标记）
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
    label?: string;
  }>(),
  { tone: 'neutral' },
);

const colorVar = computed(() => {
  switch (props.tone) {
    case 'accent':
      return 'var(--color-accent)';
    case 'success':
      return 'var(--color-success)';
    case 'warning':
      return 'var(--color-warning)';
    case 'danger':
      return 'var(--color-danger)';
    default:
      return 'var(--color-text-secondary)';
  }
});
</script>

<template>
  <view
    class="ui-tag"
    :style="{ color: colorVar, borderColor: colorVar }"
  >
    <text><slot>{{ label }}</slot></text>
  </view>
</template>

<style scoped lang="scss">
.ui-tag {
  display: inline-flex;
  align-items: center;
  min-height: 44rpx;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  border: 1rpx solid;
  font-size: var(--font-caption);
  line-height: 1;
}
</style>
