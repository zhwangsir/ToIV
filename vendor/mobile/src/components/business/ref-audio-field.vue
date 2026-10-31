<script setup lang="ts">
/**
 * 驱动音频字段（ltx-nsfw-lipsync）：选文件 → 先验 → 上传（钉参考图 worker）→ 预览/移除
 * 与参考图互钉同 worker（口型同步图/音必须同机）；选中即传，上传中/失败有明确态
 * 文件选择条件编译：MP-WEIXIN 仅支持会话文件（chooseMessageFile），H5/APP 走 chooseFile
 */
import { ref } from 'vue';

import { uploadAudio } from '@/api';
import Icon from '@/components/ui/icon.vue';
import type { UploadedRefAudio } from '@/types/api';
import { validateRefAudio } from '@/utils/build-request';

const props = withDefaults(
  defineProps<{
    label?: string;
    /** /api/upload kind（ltx-nsfw-lipsync → ltx_lipsync） */
    kind?: string;
    /** 互钉落点：参考图上传到的 worker（口型同步与参考图/驱动音频同机） */
    pinWorker?: string;
  }>(),
  { kind: 'ltx_lipsync', pinWorker: undefined },
);

const emit = defineEmits<{
  change: [value: UploadedRefAudio | null];
}>();

const AUDIO_EXTS = ['wav', 'mp3', 'm4a', 'ogg', 'flac'];

const audio = ref<UploadedRefAudio | null>(null);
const uploading = ref(false);
const error = ref('');

async function pickAndUpload(filePath: string, name: string, size?: number) {
  if (!filePath) return;
  // 扩展名先验按原始文件名：H5 chooseFile 返回 blob: URL（无扩展名），wx 临时路径不保证带扩展名
  const invalid = validateRefAudio(name, size);
  if (invalid) {
    error.value = invalid;
    return;
  }

  uploading.value = true;
  try {
    const result = await uploadAudio(filePath, props.kind, props.pinWorker);
    audio.value = {
      filename: result.filename,
      worker: result.worker,
      name,
    };
    emit('change', audio.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '上传失败，请重试';
  } finally {
    uploading.value = false;
  }
}

function choose() {
  if (uploading.value) return;
  error.value = '';
  // #ifdef MP-WEIXIN
  // 微信小程序无任意文件选择器，仅能从会话选取文件
  uni.chooseMessageFile({
    count: 1,
    type: 'file',
    extension: AUDIO_EXTS,
    success: (res) => {
      const f = res.tempFiles[0];
      if (!f) return;
      void pickAndUpload(f.path, f.name, f.size);
    },
    fail: () => {
      // 用户取消不提示
    },
  });
  // #endif
  // #ifndef MP-WEIXIN
  uni.chooseFile({
    count: 1,
    type: 'all',
    extension: AUDIO_EXTS,
    success: (res) => {
      const paths = Array.isArray(res.tempFilePaths) ? res.tempFilePaths : [res.tempFilePaths];
      // tempFiles 声明为单/数组/File 联合类型，归一化后取首项（count:1）
      const rawFiles = res.tempFiles as unknown;
      const files = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];
      const f = files[0] as { path?: string; name?: string; size?: number } | undefined;
      const filePath = f?.path ?? paths[0] ?? '';
      const name = f?.name ?? filePath.split('/').pop() ?? 'audio';
      void pickAndUpload(filePath, name, f?.size);
    },
    fail: () => {
      // 用户取消不提示
    },
  });
  // #endif
}

function remove() {
  audio.value = null;
  error.value = '';
  emit('change', null);
}
</script>

<template>
  <view class="ref-audio">
    <text
      v-if="label"
      class="ref-audio__label"
    >
      {{ label }}
    </text>

    <view
      v-if="!audio"
      class="ref-audio__picker"
      hover-class="ref-audio__picker--pressed"
      @tap="choose"
    >
      <Icon
        v-if="!uploading"
        name="music"
        :size="56"
        color="var(--color-text-secondary)"
      />
      <Icon
        v-else
        name="loader-circle"
        :size="56"
        color="var(--color-accent)"
        class="ref-audio__spin"
      />
      <text class="ref-audio__hint">
        {{ uploading ? '上传中…' : '添加驱动音频' }}
      </text>
      <text class="ref-audio__sub">
        WAV/MP3/M4A/OGG/FLAC，≤20MB
      </text>
    </view>

    <view
      v-else
      class="ref-audio__card"
    >
      <view class="ref-audio__thumb">
        <Icon
          name="music"
          :size="48"
          color="var(--color-accent)"
        />
      </view>
      <view class="ref-audio__meta">
        <text
          class="ref-audio__name"
          number-of-lines="1"
        >
          {{ audio.name }}
        </text>
      </view>
      <view
        class="ref-audio__remove"
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
      class="ref-audio__error"
    >
      <Icon
        name="circle-alert"
        :size="28"
        color="var(--color-danger)"
      />
      <text class="ref-audio__error-text">
        {{ error }}
      </text>
    </view>
  </view>
</template>

<style scoped lang="scss">
.ref-audio {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  &__label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  &__picker {
    height: 200rpx;
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
    animation: ref-audio-spin 1s linear infinite;
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

@keyframes ref-audio-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
