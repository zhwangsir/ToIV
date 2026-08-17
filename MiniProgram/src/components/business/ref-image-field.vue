<script setup lang="ts">
/**
 * 参考图字段（选图 → 先验 → 上传 → 预览/移除，对齐 Mobile ref-image-field）
 * 选中即传：拿到 filename/worker 才算就绪；上传中/失败有明确态
 * max>1 多图模式（wan-vace 1-4 张）：第 2 张起互钉第 1 张 worker，逐张移除
 * MP13 资产库入口：选中资产图直接回填句柄（不重新上传），与上传入口并列、样式次级
 */
import { computed, ref } from 'vue';

import { uploadImage } from '@/api';
import AssetPickerSheet from '@/components/business/asset-picker-sheet.vue';
import Button from '@/components/ui/button.vue';
import Icon from '@/components/ui/icon.vue';
import type { UploadedRefImage } from '@/types/api';
import { appendAssetImage } from '@/utils/assets';
import { validateRefImage } from '@/utils/build-request';

const props = withDefaults(
  defineProps<{
    label?: string;
    /** /api/upload kind（uploadKindForEngine 映射） */
    kind?: string;
    /** 数量上限：1=单图模式（默认），>1=多图模式（wan-vace 1-4 张） */
    max?: number;
  }>(),
  { kind: 'img2img', max: 1 },
);

const emit = defineEmits<{
  change: [value: UploadedRefImage | UploadedRefImage[] | null];
}>();

const multiple = computed(() => props.max > 1);

const image = ref<UploadedRefImage | null>(null);
const images = ref<UploadedRefImage[]>([]);
const uploading = ref(false);
const error = ref('');

async function pickAndUpload(filePath: string, size?: number) {
  const invalid = validateRefImage(filePath, size);
  if (invalid) {
    error.value = invalid;
    return;
  }

  uploading.value = true;
  try {
    // 多图模式：第 2 张起钉第 1 张的 worker，保证全部参考图同机
    const pin = multiple.value && images.value.length > 0 ? images.value[0].worker : undefined;
    const result = await uploadImage(filePath, props.kind, pin);
    const handle: UploadedRefImage = {
      filename: result.filename,
      worker: result.worker,
      previewUri: filePath,
      name: filePath.split('/').pop() ?? 'ref',
    };
    if (multiple.value) {
      images.value = [...images.value, handle];
      emit('change', images.value);
    } else {
      image.value = handle;
      emit('change', image.value);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '上传失败，请重试';
  } finally {
    uploading.value = false;
  }
}

function choose() {
  if (uploading.value) return;
  error.value = '';
  uni.chooseImage({
    count: 1,
    sizeType: ['compressed'],
    success: (res) => {
      const filePath = res.tempFilePaths[0];
      // tempFiles 声明为单/数组联合类型，归一化后取 size（count:1 时微信仍返回数组）
      const rawFiles = res.tempFiles as unknown;
      const files = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];
      const size = (files[0] as { size?: number } | undefined)?.size;
      void pickAndUpload(filePath, size);
    },
    fail: () => {
      // 用户取消不提示
    },
  });
}

function remove(index: number) {
  error.value = '';
  if (multiple.value) {
    images.value = images.value.filter((_, i) => i !== index);
    emit('change', images.value);
  } else {
    image.value = null;
    emit('change', null);
  }
}

// ── 资产库引用（MP13：选中即用，不重新上传） ──
const assetPickerVisible = ref(false);

function openAssetPicker() {
  if (uploading.value) return;
  error.value = '';
  assetPickerVisible.value = true;
}

/**
 * 资产句柄回填：已带 filename/worker，直接视为已上传完成态
 * 单图：替换语义，选完即关；多图：追加语义（上限/同 worker 由 appendAssetImage 拦截），
 * 选择器保持打开可连续点选，失败经 toast 反馈（字段 error 会被弹层遮住）
 */
function onAssetPick(handle: UploadedRefImage) {
  if (multiple.value) {
    const res = appendAssetImage(images.value, handle, props.max);
    if (!res.ok) {
      uni.showToast({
        title: res.reason === 'worker' ? '与已选参考图不在同一机器' : `最多 ${props.max} 张参考图`,
        icon: 'none',
      });
      return;
    }
    images.value = res.images;
    emit('change', images.value);
    return;
  }
  image.value = handle;
  emit('change', image.value);
  assetPickerVisible.value = false;
}
</script>

<template>
  <view class="ref-image">
    <view class="ref-image__head">
      <text
        v-if="label"
        class="ref-image__label"
      >
        {{ label }}
      </text>
      <text
        v-if="multiple"
        class="ref-image__count"
      >
        {{ images.length }}/{{ max }}
      </text>
    </view>

    <view class="ref-image__row">
      <view
        v-for="(item, index) in multiple ? images : image ? [image] : []"
        :key="item.filename"
        class="ref-image__preview"
      >
        <image
          class="ref-image__img"
          :src="item.previewUri"
          mode="aspectFill"
        />
        <view
          class="ref-image__remove"
          @tap="remove(index)"
        >
          <Icon
            name="x"
            :size="32"
            color="#FFFFFF"
          />
        </view>
      </view>

      <view
        v-if="multiple ? images.length < max : !image"
        class="ref-image__picker"
        :class="{ 'ref-image__picker--compact': multiple && images.length > 0 }"
        hover-class="ref-image__picker--pressed"
        @tap="choose"
      >
        <Icon
          v-if="!uploading"
          name="image-plus"
          :size="56"
          color="var(--color-text-secondary)"
        />
        <Icon
          v-else
          name="loader-circle"
          :size="56"
          color="var(--color-accent)"
          class="ref-image__spin"
        />
        <text class="ref-image__hint">
          {{ uploading ? '上传中…' : '添加参考图' }}
        </text>
        <text
          v-if="!multiple || images.length === 0"
          class="ref-image__sub"
        >
          JPG/PNG/WebP/GIF，≤20MB
        </text>
      </view>
    </view>

    <!-- 资产库入口（与上传并列、样式次级；单图替换语义常显，多图达上限隐藏） -->
    <Button
      v-if="!multiple || images.length < max"
      label="从资产库选择"
      variant="secondary"
      size="sm"
      icon="folder"
      @click="openAssetPicker"
    />

    <view
      v-if="error"
      class="ref-image__error"
    >
      <Icon
        name="circle-alert"
        :size="28"
        color="var(--color-danger)"
      />
      <text class="ref-image__error-text">
        {{ error }}
      </text>
    </view>

    <AssetPickerSheet
      :visible="assetPickerVisible"
      :multiple="multiple"
      :current="images.length"
      :max="max"
      @pick="onAssetPick"
      @close="assetPickerVisible = false"
    />
  </view>
</template>

<style scoped lang="scss">
.ref-image {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  &__head {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
  }

  &__label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    font-weight: 500;
  }

  &__count {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__row {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  &__picker {
    width: 100%;
    height: 240rpx;
    border: 2rpx dashed var(--color-border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);

    &--compact {
      width: 240rpx;
    }

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

  &__preview {
    position: relative;
    width: 240rpx;
    height: 240rpx;
  }

  &__img {
    width: 240rpx;
    height: 240rpx;
    border-radius: var(--radius-md);
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
    animation: ref-spin 1s linear infinite;
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

@keyframes ref-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
