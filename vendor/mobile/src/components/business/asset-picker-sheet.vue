<script setup lang="ts">
/**
 * 资产选择器（MP13 创作页引用核心：选中即用，不重新上传）
 * - kind 过滤 chips + 资产列表 → 展开该资产 1-4 张图网格 → 点选回填 {filename, worker} 句柄
 * - 缩略图走 assetImageUrl（token 由 mediaUrl 拼）
 * - 多图模式（multiple）：选择器保持打开可连续追加；current/max 传入时达上限截停
 * - 同 worker 约束由调用方 appendAssetImage 拦截（资产句柄已带落点，视为已上传完成态）
 */
import { computed, ref, watch } from 'vue';

import { assetImageUrl, listAssets } from '@/api';
import Icon from '@/components/ui/icon.vue';
import Sheet from '@/components/ui/sheet.vue';
import type { AssetItem, AssetKind, UploadedRefImage } from '@/types/api';
import { ASSET_KINDS, assetKindLabel, filterAssetsByKind } from '@/utils/assets';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 多图字段模式：选中后保持打开，可连续追加（不超上限） */
    multiple?: boolean;
    /** 多图模式：当前已选数量与上限（用于上限截停提示） */
    current?: number;
    max?: number;
  }>(),
  { multiple: false, current: 0, max: 1 },
);

const emit = defineEmits<{
  pick: [handle: UploadedRefImage];
  close: [];
}>();

const assets = ref<AssetItem[]>([]);
const loading = ref(false);
const error = ref('');
const kindFilter = ref<AssetKind | 'all'>('all');
const expandedId = ref<string | null>(null);

const filtered = computed(() => filterAssetsByKind(assets.value, kindFilter.value));

/** 多图模式达上限：截停追加并给显式提示（单图模式替换语义不涉及上限） */
const capped = computed(() => props.multiple && props.current >= props.max);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    assets.value = await listAssets();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    // 每次打开重置过滤与展开态并重拉（资产可能在管理页刚改过）
    kindFilter.value = 'all';
    expandedId.value = null;
    void load();
  },
);

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

/** 点选某张资产图：回填已上传句柄（不重新上传——资产库的意义就是复用句柄） */
function pick(asset: AssetItem, index: number) {
  if (capped.value) return;
  const img = asset.images[index];
  if (!img) return;
  emit('pick', {
    filename: img.filename,
    worker: img.worker,
    previewUri: assetImageUrl(asset.id, index),
    name: img.filename,
  });
}
</script>

<template>
  <Sheet
    :visible="visible"
    title="从资产库选择"
    @close="emit('close')"
  >
    <view class="asset-picker">
      <!-- kind 过滤 chips -->
      <scroll-view
        scroll-x
        class="asset-picker__filters"
        :show-scrollbar="false"
        enhanced
      >
        <view class="asset-picker__filters-row">
          <view
            class="asset-picker__chip"
            :class="{ 'asset-picker__chip--active': kindFilter === 'all' }"
            hover-class="asset-picker__chip--pressed"
            @tap="kindFilter = 'all'"
          >
            <text
              class="asset-picker__chip-label"
              :class="{ 'asset-picker__chip-label--active': kindFilter === 'all' }"
            >
              全部
            </text>
          </view>
          <view
            v-for="k in ASSET_KINDS"
            :key="k.key"
            class="asset-picker__chip"
            :class="{ 'asset-picker__chip--active': kindFilter === k.key }"
            hover-class="asset-picker__chip--pressed"
            @tap="kindFilter = k.key"
          >
            <text
              class="asset-picker__chip-label"
              :class="{ 'asset-picker__chip-label--active': kindFilter === k.key }"
            >
              {{ k.label }}
            </text>
          </view>
        </view>
      </scroll-view>

      <view
        v-if="capped"
        class="asset-picker__capped"
      >
        <text class="asset-picker__capped-text">
          已达参考图上限（{{ current }}/{{ max }}），先移除再选
        </text>
      </view>

      <view
        v-if="loading"
        class="asset-picker__center"
      >
        <text class="asset-picker__hint">
          加载中…
        </text>
      </view>

      <view
        v-else-if="error"
        class="asset-picker__center"
      >
        <text class="asset-picker__hint">
          {{ error }}
        </text>
        <text
          class="asset-picker__retry"
          @tap="load"
        >
          重试
        </text>
      </view>

      <view
        v-else-if="filtered.length === 0"
        class="asset-picker__center"
      >
        <text class="asset-picker__hint">
          {{ kindFilter === 'all' ? '资产库还是空的，先到「我的 → 参考资产库」新建' : '该分类暂无资产' }}
        </text>
      </view>

      <view
        v-for="asset in filtered"
        :key="asset.id"
        class="asset-picker__item"
      >
        <view
          class="asset-picker__row"
          hover-class="asset-picker__row--pressed"
          @tap="toggleExpand(asset.id)"
        >
          <image
            v-if="asset.images.length > 0"
            class="asset-picker__thumb"
            :src="assetImageUrl(asset.id, 0)"
            mode="aspectFill"
          />
          <view
            v-else
            class="asset-picker__thumb asset-picker__thumb--empty"
          >
            <Icon
              name="image"
              :size="40"
              color="var(--color-text-secondary)"
            />
          </view>
          <view class="asset-picker__main">
            <view class="asset-picker__name-row">
              <text
                class="asset-picker__name"
                number-of-lines="1"
              >
                {{ asset.name }}
              </text>
              <text
                v-if="asset.nsfw"
                class="asset-picker__r18"
              >
                R18
              </text>
            </view>
            <text class="asset-picker__meta">
              {{ assetKindLabel(asset.kind) }} · {{ asset.images.length }} 张
            </text>
          </view>
          <Icon
            :name="expandedId === asset.id ? 'chevron-up' : 'chevron-down'"
            :size="32"
            color="var(--color-text-secondary)"
          />
        </view>

        <view
          v-if="expandedId === asset.id"
          class="asset-picker__grid"
          :class="{ 'asset-picker__grid--capped': capped }"
        >
          <image
            v-for="(img, index) in asset.images"
            :key="img.filename"
            class="asset-picker__img"
            :src="assetImageUrl(asset.id, index)"
            mode="aspectFill"
            hover-class="asset-picker__img--pressed"
            @tap="pick(asset, index)"
          />
        </view>
      </view>

      <view style="height: 32rpx" />
    </view>
  </Sheet>
</template>

<style scoped lang="scss">
.asset-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);

  &__filters {
    white-space: nowrap;
  }

  &__filters-row {
    display: flex;
    flex-direction: row;
    gap: var(--space-2);
    padding-bottom: var(--space-2);
  }

  &__chip {
    display: flex;
    flex-direction: row;
    align-items: center;
    min-height: 56rpx;
    padding: 0 var(--space-3);
    border-radius: 999rpx;
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);

    &--active {
      border-color: var(--color-accent);
      background: var(--color-accent-soft);
    }

    &--pressed {
      opacity: 0.85;
    }
  }

  &__chip-label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);

    &--active {
      color: var(--color-accent);
      font-weight: 600;
    }
  }

  &__capped {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);
  }

  &__capped-text {
    font-size: var(--font-caption);
    color: var(--color-warning);
  }

  &__center {
    min-height: 240rpx;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
  }

  &__hint {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__retry {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
    padding: var(--space-2) var(--space-3);
  }

  &__item {
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  &__row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);

    &--pressed {
      opacity: 0.85;
    }
  }

  &__thumb {
    width: 96rpx;
    height: 96rpx;
    border-radius: var(--radius-md);
    flex-shrink: 0;

    &--empty {
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--color-bg);
    }
  }

  &__main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4rpx;
  }

  &__name-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__name {
    font-size: var(--font-body);
    font-weight: 500;
    color: var(--color-text);
    overflow: hidden;
  }

  &__r18 {
    font-size: 18rpx;
    font-weight: 600;
    line-height: 1.4;
    color: var(--color-danger);
    border: 1rpx solid var(--color-danger);
    border-radius: var(--radius-sm);
    padding: 2rpx 10rpx;
    flex-shrink: 0;
  }

  &__meta {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__grid {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-3);
    padding: 0 var(--space-3) var(--space-3);

    &--capped {
      opacity: 0.5;
    }
  }

  &__img {
    width: 156rpx;
    height: 156rpx;
    border-radius: var(--radius-md);

    &--pressed {
      opacity: 0.8;
    }
  }
}
</style>
