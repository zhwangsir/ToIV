<script setup lang="ts">
/**
 * 卡片容器（surface 底色 + border + radius-lg，浅色主题仅细腻浮起）
 * 注意：不提供 tap/click 转发——组件自定义事件统一走具名 emit（如 click），
 * 点按请在消费方模板内的原生 view 上直接绑 @tap（见 job-card / library）
 */
withDefaults(
  defineProps<{
    padded?: boolean;
    tappable?: boolean;
  }>(),
  { padded: true, tappable: false },
);
</script>

<template>
  <view
    class="ui-card"
    :class="{ 'ui-card--padded': padded }"
    :hover-class="tappable ? 'ui-card--pressed' : 'none'"
  >
    <slot />
  </view>
</template>

<style scoped lang="scss">
.ui-card {
  background: var(--color-surface);
  border: 1rpx solid var(--color-border);
  border-radius: var(--radius-lg);

  &--padded {
    padding: var(--space-4);
  }

  &--pressed {
    opacity: 0.88;
  }
}
</style>
