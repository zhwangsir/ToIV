<script setup lang="ts">
/**
 * 自定义导航栏（navigationStyle: custom 页面用）
 * 含状态栏高度适配；左侧可选返回按钮
 */
import { computed, ref } from 'vue';

import Icon from './icon.vue';

const props = withDefaults(
  defineProps<{
    title: string;
    showBack?: boolean;
  }>(),
  { showBack: false },
);

const statusBarHeight = ref(0);
try {
  const info = uni.getSystemInfoSync() as { statusBarHeight?: number };
  statusBarHeight.value = info.statusBarHeight ?? 0;
} catch {
  statusBarHeight.value = 0;
}

const paddingTop = computed(() => `${statusBarHeight.value}px`);

function goBack() {
  uni.navigateBack({ delta: 1 });
}
void props;
</script>

<template>
  <view
    class="nav-bar"
    :style="{ paddingTop }"
  >
    <view class="nav-bar__row">
      <view class="nav-bar__side">
        <view
          v-if="showBack"
          class="nav-bar__back"
          @tap="goBack"
        >
          <Icon
            name="arrow-left"
            :size="44"
            color="var(--color-text)"
          />
        </view>
      </view>
      <text class="nav-bar__title">
        {{ title }}
      </text>
      <view class="nav-bar__side">
        <slot name="right" />
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.nav-bar {
  background: var(--color-bg);

  &__row {
    height: 88rpx;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-4);
  }

  &__title {
    font-size: var(--font-heading);
    font-weight: 600;
    color: var(--color-text);
  }

  &__side {
    min-width: 96rpx;
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  &__back {
    min-width: 96rpx;
    min-height: 96rpx;
    display: flex;
    align-items: center;
    justify-content: flex-start;
  }
}
</style>
