<script setup lang="ts">
/**
 * 底部抽屉（参数面板/动作面板通用容器）
 * 交互：遮罩点击关闭、下滑手势区域、圆角上沿、安全区适配
 */
import Icon from './icon.vue';

withDefaults(
  defineProps<{
    visible: boolean;
    title?: string;
    /** 最大高度（vh），默认 72 */
    maxHeight?: number;
  }>(),
  { maxHeight: 72 },
);

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <view
    v-if="visible"
    class="ui-sheet"
  >
    <view
      class="ui-sheet__mask"
      @tap="emit('close')"
    />
    <view
      class="ui-sheet__panel"
      :style="{ maxHeight: `${maxHeight}vh` }"
    >
      <view class="ui-sheet__grabber" />
      <view
        v-if="title"
        class="ui-sheet__header"
      >
        <text class="ui-sheet__title">
          {{ title }}
        </text>
        <view
          class="ui-sheet__close"
          @tap="emit('close')"
        >
          <Icon
            name="x"
            :size="40"
            color="var(--color-text-secondary)"
          />
        </view>
      </view>
      <scroll-view
        scroll-y
        class="ui-sheet__body"
      >
        <slot />
      </scroll-view>
      <view
        v-if="$slots.footer"
        class="ui-sheet__footer"
      >
        <slot name="footer" />
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.ui-sheet {
  position: fixed;
  inset: 0;
  z-index: 90;

  &__mask {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
  }

  &__panel {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--color-surface);
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    padding-bottom: env(safe-area-inset-bottom);
    display: flex;
    flex-direction: column;
  }

  &__grabber {
    align-self: center;
    width: 72rpx;
    height: 8rpx;
    border-radius: var(--radius-sm);
    background: var(--color-border);
    margin-top: var(--space-3);
  }

  &__header {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-6) var(--space-2);
  }

  &__title {
    font-size: var(--font-heading);
    font-weight: 600;
    color: var(--color-text);
  }

  &__close {
    min-width: 96rpx;
    min-height: 96rpx;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  &__body {
    flex: 1;
    min-height: 0;
    padding: 0 var(--space-6);
    /*
     * H5 端抽屉滚动修复（探针实验 E4 验证）：
     * panel 靠 max-height 钳制时，uni scroll-view 内层两层 div.uni-scroll-view 的
     * height:100% 百分比参照链断裂（父级高度 indefinite）→ 内层被内容撑高、抽屉无法滚动。
     * 全 flex 链不依赖百分比，flex 算法直接用布局后的确定高度分配。
     * 小程序端 scroll-view 为原生组件无此 DOM 结构，选择器不匹配、无副作用。
     */
    display: flex;
    flex-direction: column;

    :deep(> .uni-scroll-view) {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    :deep(> .uni-scroll-view > .uni-scroll-view) {
      flex: 1;
      min-height: 0;
    }
  }

  &__footer {
    padding: var(--space-4) var(--space-6) 0;
    border-top: 1rpx solid var(--color-border);
  }
}
</style>
