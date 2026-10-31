<script setup lang="ts">
/**
 * 空状态（指南：空状态要有语义，给下一步动作而非死胡同）
 */
import Icon from './icon.vue';

withDefaults(
  defineProps<{
    icon?: string;
    title: string;
    description?: string;
  }>(),
  { icon: 'image' },
);

const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <view class="ui-empty">
    <view class="ui-empty__icon">
      <Icon
        :name="icon"
        :size="96"
        color="var(--color-text-secondary)"
        :stroke-width="1.5"
      />
    </view>
    <text class="ui-empty__title">
      {{ title }}
    </text>
    <text
      v-if="description"
      class="ui-empty__desc"
    >
      {{ description }}
    </text>
    <view
      v-if="$slots.action"
      class="ui-empty__action"
      @tap="emit('action')"
    >
      <slot name="action" />
    </view>
  </view>
</template>

<style scoped lang="scss">
.ui-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-12, 96rpx) var(--space-8);
  text-align: center;

  &__icon {
    margin-bottom: var(--space-4);
    opacity: 0.7;
  }

  &__title {
    font-size: var(--font-heading);
    font-weight: 500;
    color: var(--color-text);
    margin-bottom: var(--space-2);
  }

  &__desc {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    line-height: 1.6;
    max-width: 480rpx;
  }

  &__action {
    margin-top: var(--space-6);
  }
}
</style>
