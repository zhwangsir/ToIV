<script setup lang="ts">
/**
 * 作业卡片：缩略图 + 提示词摘要 + 状态标签 + 相对时间 + 终态操作（删除/失败重试）
 * MP29：活跃作业可展示 SSE 实时进度条（progressPct 0-100；null 不渲染，行为与此前一致）
 *       + 质量预警图标（qualityWarning，只提示不阻塞）
 */
import { computed } from 'vue';

import { mediaUrl } from '@/api/client';
import Card from '@/components/ui/card.vue';
import Icon from '@/components/ui/icon.vue';
import Tag from '@/components/ui/tag.vue';
import type { JobItem } from '@/types/api';
import { formatRelative, isTerminalStatus, jobStatusMeta } from '@/utils/format';

const props = withDefaults(
  defineProps<{
    job: JobItem;
    /** 重试提交中（防重复点按） */
    retrying?: boolean;
    /** SSE 实时进度（0-100，MP29）；null = 无实时进度源，不渲染进度条 */
    progressPct?: number | null;
    /** 已收到质量预警（MP29）：状态行预警图标 */
    qualityWarning?: boolean;
  }>(),
  { retrying: false, progressPct: null, qualityWarning: false },
);

const emit = defineEmits<{
  /** 卡片点按（事件名必须叫 click：uni 把父模板 @tap/@click 统一编译为 onClick prop） */
  click: [job: JobItem];
  remove: [job: JobItem];
  retry: [job: JobItem];
}>();

const meta = computed(() => jobStatusMeta(props.job.status));
const thumb = computed(() =>
  props.job.results.length > 0 ? mediaUrl(props.job.results[0]) : '',
);
const isVideo = computed(() => props.job.kind.includes('video') || /\.(mp4|webm|mov)$/i.test(props.job.results[0] ?? ''));
const time = computed(() => formatRelative(props.job.created_at));
const deletable = computed(() => isTerminalStatus(props.job.status));
const retryable = computed(() => props.job.status === 'error');
/** 进度条仅活跃态渲染（终态 stale pct 防御性不展示） */
const showProgress = computed(
  () =>
    props.progressPct !== null &&
    (props.job.status === 'running' || props.job.status === 'queued'),
);

function confirmRemove() {
  uni.showModal({
    title: '删除作业',
    content: '删除后不可恢复，确认删除？',
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (res.confirm) emit('remove', props.job);
    },
  });
}
</script>

<template>
  <!--
    @tap 落在本模板内的原生 view 上（原生事件 uni 双端都正常），
    对外统一 emit('click') 对齐编译器 onClick 映射（见 emits 注释）
  -->
  <Card
    :padded="false"
    tappable
  >
    <view
      class="job-card"
      @tap="emit('click', job)"
    >
      <view class="job-card__thumb">
        <image
          v-if="thumb"
          class="job-card__img"
          :src="thumb"
          mode="aspectFill"
          lazy-load
        />
        <view
          v-else
          class="job-card__img job-card__img--empty"
        >
          <Icon
            name="image"
            :size="48"
            color="var(--color-text-secondary)"
          />
        </view>
        <view
          v-if="isVideo && thumb"
          class="job-card__play"
        >
          <Icon
            name="play"
            :size="32"
            color="#FFFFFF"
          />
        </view>
      </view>

      <view class="job-card__main">
        <text class="job-card__prompt">
          {{ job.prompt || '（无提示词）' }}
        </text>
        <view class="job-card__meta">
          <Tag
            :tone="meta.tone"
            :label="meta.label"
          />
          <view
            v-if="qualityWarning"
            class="job-card__warn"
          >
            <Icon
              name="circle-alert"
              :size="28"
              color="var(--color-warning)"
            />
          </view>
          <text class="job-card__time">
            {{ time }}
          </text>
        </view>
        <!-- MP29：SSE 实时进度条（progressPct 非空且活跃态才渲染；无实时源时整行不渲染） -->
        <view
          v-if="showProgress"
          class="job-card__progress"
        >
          <view class="job-card__progress-track">
            <view
              class="job-card__progress-fill"
              :style="{ width: `${progressPct}%` }"
            />
          </view>
          <text class="job-card__progress-text">
            {{ progressPct }}%
          </text>
        </view>
      </view>

      <view
        v-if="retryable"
        class="job-card__action"
        :class="{ 'job-card__action--spinning': retrying }"
        hover-class="job-card__action--pressed"
        @tap.stop="!retrying && emit('retry', job)"
      >
        <Icon
          :name="retrying ? 'loader-circle' : 'refresh-cw'"
          :size="36"
          color="var(--color-accent)"
        />
      </view>
      <view
        v-if="deletable"
        class="job-card__action"
        hover-class="job-card__action--pressed"
        @tap.stop="confirmRemove"
      >
        <Icon
          name="trash-2"
          :size="36"
          color="var(--color-text-secondary)"
        />
      </view>
    </view>
  </Card>
</template>

<style scoped lang="scss">
.job-card {
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: var(--space-3);
  gap: var(--space-3);

  &__thumb {
    position: relative;
    width: 144rpx;
    height: 144rpx;
    flex-shrink: 0;
  }

  &__img {
    width: 144rpx;
    height: 144rpx;
    border-radius: var(--radius-md);
    background: var(--color-bg);

    &--empty {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  &__play {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.25);
    border-radius: var(--radius-md);
  }

  &__main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  &__prompt {
    font-size: var(--font-body);
    color: var(--color-text);
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  &__meta {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__warn {
    display: flex;
    align-items: center;
  }

  &__progress {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__progress-track {
    flex: 1;
    height: 8rpx;
    border-radius: 999rpx;
    background: var(--color-border);
    overflow: hidden;
  }

  &__progress-fill {
    height: 100%;
    border-radius: 999rpx;
    background: var(--color-accent);
    transition: width 240ms ease-out;
  }

  &__progress-text {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-variant-numeric: tabular-nums;
    min-width: 64rpx;
    text-align: right;
  }

  &__time {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__action {
    min-width: 88rpx;
    min-height: 88rpx;
    display: flex;
    align-items: center;
    justify-content: center;

    &--pressed {
      opacity: 0.6;
    }

    &--spinning {
      opacity: 0.5;
    }
  }
}
</style>
