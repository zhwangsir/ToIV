<script setup lang="ts">
/**
 * 共享底部导航（跨平台：微信/H5/其他小程序一致渲染）
 * - 弃用微信私有 custom-tab-bar 机制（uni-app 编译为原始 .vue 拷贝不可用，且其他平台无底栏）
 * - 页尾内嵌：占位块撑高 + fixed 悬浮条，页面零额外样式
 * - 导航用 reLaunch（无原生 tabBar 后 switchTab 不可用；reLaunch 清栈防返回栈堆积）
 */
import { computed } from 'vue';

import Icon from '@/components/ui/icon.vue';
import { useAppTheme } from '@/composables/use-app-theme';

const props = defineProps<{ selected: number }>();

const { themeVars } = useAppTheme();

const tabs = [
  { path: '/pages/index/index', label: '创作', icon: 'sparkles' },
  { path: '/pages/jobs/jobs', label: '作业', icon: 'layers' },
  { path: '/pages/library/library', label: '作品库', icon: 'image' },
  { path: '/pages/profile/profile', label: '我的', icon: 'user' },
] as const;

const selected = computed(() => props.selected);

function switchTo(index: number) {
  if (index === selected.value) return;
  uni.reLaunch({ url: tabs[index].path });
}
</script>

<template>
  <view :style="themeVars">
    <!-- 占位块：撑开 fixed 条高度，防内容被遮 -->
    <view class="tab-bar-gap" />
    <view class="tab-bar">
      <view
        v-for="(tab, index) in tabs"
        :key="tab.path"
        class="tab-bar__item"
        hover-class="tab-bar__item--pressed"
        @tap="switchTo(index)"
      >
        <Icon
          :name="tab.icon"
          :size="44"
          :color="index === selected ? 'var(--color-accent)' : 'var(--color-text-secondary)'"
        />
        <text
          class="tab-bar__label"
          :style="{ color: index === selected ? 'var(--color-accent)' : 'var(--color-text-secondary)' }"
        >
          {{ tab.label }}
        </text>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.tab-bar-gap {
  height: calc(116rpx + env(safe-area-inset-bottom));
}

.tab-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 100;
  display: flex;
  flex-direction: row;
  background: var(--color-surface);
  border-top: 1rpx solid var(--color-border);
  padding-bottom: env(safe-area-inset-bottom);

  &__item {
    flex: 1;
    min-height: 100rpx;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4rpx;

    &--pressed {
      opacity: 0.6;
    }
  }

  &__label {
    font-size: var(--font-caption);
    line-height: 1.2;
  }
}
</style>
