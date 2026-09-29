<script setup lang="ts">
/**
 * 应用详情（U10 切片1）：封面 + 作者 + 实测状态 + 简介
 * 完整左参右预运行器下一切片；本页只读，引导回市场或创作页。
 */
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { getMarketApp } from '@/api';
import { mediaUrl } from '@/api/client';
import Button from '@/components/ui/button.vue';
import Icon from '@/components/ui/icon.vue';
import NavBar from '@/components/ui/nav-bar.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import type { MarketAppDetail } from '@/types/api';
import { formatSmokeVerifiedAt } from '@/utils/market';

const { themeVars } = useAppTheme();
const { requireAuth } = useAuthGuard();

const appId = ref('');
const app = ref<MarketAppDetail | null>(null);
const loading = ref(true);
const error = ref('');

const cover = computed(() => {
  const u = (app.value?.cover_url || '').trim();
  return u ? mediaUrl(u) : '';
});

const smokeText = computed(() => {
  const a = app.value;
  if (!a) return '';
  if (a.smoke_status === 'pass') {
    const when = formatSmokeVerifiedAt(a.smoke_at);
    return when ? `实测可用 · ${when}` : '实测可用';
  }
  if (a.smoke_status === 'fail' || a.smoke_status === 'timeout') return '待修复';
  if (a.smoke_status === 'running') return '测中…';
  return '未测';
});

async function load(id: string) {
  if (!(await requireAuth())) return;
  loading.value = true;
  error.value = '';
  try {
    app.value = await getMarketApp(id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

function goCreate() {
  uni.reLaunch({ url: '/pages/index/index' });
}

onLoad((query) => {
  const id = typeof query?.id === 'string' ? decodeURIComponent(query.id) : '';
  appId.value = id;
  if (!id) {
    error.value = '缺少应用 id';
    loading.value = false;
    return;
  }
  void load(id);
});
</script>

<template>
  <view class="detail" :style="themeVars">
    <NavBar title="应用详情" show-back />
    <view v-if="loading" class="detail__state">加载中…</view>
    <view v-else-if="error" class="detail__state detail__state--err" @tap="load(appId)">{{ error }}</view>
    <view v-else-if="app" class="detail__body">
      <image v-if="cover" class="detail__cover" :src="cover" mode="widthFix" />
      <view v-else class="detail__cover detail__cover--fallback">
        <text>{{ (app.icon || app.name || '?').slice(0, 1) }}</text>
      </view>
      <view class="detail__head">
        <text class="detail__name">{{ app.name }}</text>
        <text class="detail__author">{{ app.author || 'ToIV' }}</text>
        <view class="detail__tags">
          <text v-if="smokeText" class="detail__tag" :class="{ 'is-pass': app.smoke_status === 'pass' }">{{ smokeText }}</text>
          <text class="detail__tag">{{ app.output_kind === 'video' ? '视频' : '图片' }}</text>
          <text v-for="m in app.content_modes || []" :key="m" class="detail__tag">{{ m.toUpperCase() }}</text>
        </view>
      </view>
      <text class="detail__desc">{{ app.description || '暂无简介' }}</text>
      <view class="detail__hint">
        <Icon name="info" :size="32" color="var(--color-text-secondary)" />
        <text>小程序端一键运行器下一版上线；也可回创作页用引擎直出。</text>
      </view>
      <Button label="去创作" variant="primary" block @click="goCreate" />
    </view>
  </view>
</template>

<style scoped lang="scss">
.detail {
  min-height: 100vh;
  background: var(--color-bg);
  color: var(--color-text);
  padding-bottom: 48rpx;
}

.detail__state {
  padding: 80rpx 32rpx;
  text-align: center;
  color: var(--color-text-secondary);
}

.detail__state--err {
  color: var(--color-danger);
}

.detail__cover {
  width: 100%;
  display: block;
  background: var(--color-accent-soft);

  &--fallback {
    min-height: 360rpx;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 80rpx;
    color: var(--color-text-secondary);
  }
}

.detail__body {
  padding: 28rpx 28rpx 0;
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}

.detail__head {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.detail__name {
  font-size: var(--font-heading);
  font-weight: 700;
}

.detail__author {
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
}

.detail__tags {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 10rpx;
  margin-top: 8rpx;
}

.detail__tag {
  padding: 6rpx 14rpx;
  border-radius: 999rpx;
  font-size: 20rpx;
  color: var(--color-text-secondary);
  background: var(--color-surface);
  border: 1rpx solid var(--color-border);

  &.is-pass {
    color: #17181a;
    background: rgba(201, 242, 79, 0.92);
    border-color: transparent;
  }
}

.detail__desc {
  font-size: var(--font-body);
  line-height: 1.55;
  color: var(--color-text);
  white-space: pre-wrap;
}

.detail__hint {
  display: flex;
  flex-direction: row;
  gap: 12rpx;
  align-items: flex-start;
  padding: 20rpx;
  border-radius: 16rpx;
  background: var(--color-surface);
  border: 1rpx solid var(--color-border);
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
  line-height: 1.45;
}
</style>
