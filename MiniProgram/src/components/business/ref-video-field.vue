<script setup lang="ts">
/**
 * 驱动视频字段（wan-animate）：uni.chooseVideo → 先验 → 上传（钉参考图 worker）→ 预览/移除
 * 与参考图互钉同 worker（生成必须同机）；选中即传，上传中/失败有明确态
 */
import { ref } from 'vue';

import { uploadVideo } from '@/api';
import Icon from '@/components/ui/icon.vue';
import type { UploadedRefVideo } from '@/types/api';
import { validateRefVideo } from '@/utils/build-request';

const props = withDefaults(
  defineProps<{
    label?: string;
    /** /api/upload kind（wan-animate → wan_animate） */
    kind?: string;
    /** 互钉落点：参考图上传到的 worker（生成与参考图/驱动视频同机） */
    pinWorker?: string;
  }>(),
  { kind: 'wan_animate', pinWorker: undefined },
);

const emit = defineEmits<{
  change: [value: UploadedRefVideo | null];
}>();

const video = ref<UploadedRefVideo | null>(null);
const uploading = ref(false);
const error = ref('');

function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function choose() {
  if (uploading.value) return;
  error.value = '';
  uni.chooseVideo({
    sourceType: ['album', 'camera'],
    success: async (res) => {
      const filePath = res.tempFilePath;
      // uni.chooseVideo 的 size 单位随平台（字节/KB），仅作先验参考，后端 413 兜底
      const size = typeof res.size === 'number' && Number.isFinite(res.size) ? res.size : undefined;

      const invalid = validateRefVideo(filePath, size);
      if (invalid) {
        error.value = invalid;
        return;
      }

      uploading.value = true;
      try {
        const result = await uploadVideo(filePath, props.kind, props.pinWorker);
        video.value = {
          filename: result.filename,
          worker: result.worker,
          previewUri: filePath,
          name: filePath.split('/').pop() ?? 'video',
          duration: typeof res.duration === 'number' ? res.duration : undefined,
        };
        emit('change', video.value);
      } catch (err) {
        error.value = err instanceof Error ? err.message : '上传失败，请重试';
      } finally {
        uploading.value = false;
      }
    },
    fail: () => {
      // 用户取消不提示
    },
  });
}

function remove() {
  video.value = null;
  error.value = '';
  emit('change', null);
}
</script>

<template>
  <view class="ref-video">
    <text
      v-if="label"
      class="ref-video__label"
    >
      {{ label }}
    </text>

    <view
      v-if="!video"
      class="ref-video__picker"
      hover-class="ref-video__picker--pressed"
      @tap="choose"
    >
      <Icon
        v-if="!uploading"
        name="film"
        :size="56"
        color="var(--color-text-secondary)"
      />
      <Icon
        v-else
        name="loader-circle"
        :size="56"
        color="var(--color-accent)"
        class="ref-video__spin"
      />
      <text class="ref-video__hint">
        {{ uploading ? '上传中…' : '添加驱动视频' }}
      </text>
      <text class="ref-video__sub">
        MP4/WebM/MOV，≤200MB
      </text>
    </view>

    <view
      v-else
      class="ref-video__card"
    >
      <view class="ref-video__thumb">
        <Icon
          name="film"
          :size="48"
          color="var(--color-accent)"
        />
      </view>
      <view class="ref-video__meta">
        <text
          class="ref-video__name"
          number-of-lines="1"
        >
          {{ video.name }}
        </text>
        <text
          v-if="formatDuration(video.duration)"
          class="ref-video__duration"
        >
          {{ formatDuration(video.duration) }}
        </text>
      </view>
      <view
        class="ref-video__remove"
        @tap="remove"
      >
        <Icon
          name="x"
          :size="32"
          color="#FFFFFF"
        />
      </view>
    </view>

    <view
      v-if="error"
      class="ref-video__error"
    >
      <Icon
        name="circle-alert"
        :size="28"
        color="var(--color-danger)"
      />
      <text class="ref-video__error-text">
        {{ error }}
      </text>
    </view>
  </view>
</template>

<style scoped lang="scss">
.ref-video {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  &__label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  &__picker {
    height: 240rpx;
    border: 2rpx dashed var(--color-border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);

    &--pressed {
      background: var(--color-accent-soft);
    }
  }

  &__hint {
    font-size: var(--font-body);
    color: var(--color-text);
  }

  &__sub {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__card {
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
  }

  &__thumb {
    width: 96rpx;
    height: 96rpx;
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__meta {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4rpx;
    overflow: hidden;
  }

  &__name {
    font-size: var(--font-body);
    color: var(--color-text);
    overflow: hidden;
  }

  &__duration {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__remove {
    position: absolute;
    top: -16rpx;
    right: -16rpx;
    width: 56rpx;
    height: 56rpx;
    border-radius: 28rpx;
    background: var(--color-danger);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__spin {
    animation: ref-video-spin 1s linear infinite;
  }

  &__error {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
  }

  &__error-text {
    font-size: var(--font-caption);
    color: var(--color-danger);
  }
}

@keyframes ref-video-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
