<script setup lang="ts">
/**
 * 应用市场（U10 切片1）：RunningHub 式双列瀑布封面卡 + 实测可用徽标 / 筛选
 * - 列表 GET /api/apps（slim）→ sortAppsVerifiedFirst
 * - 主题走 useAppTheme；封面经 mediaUrl
 * - 详情运行器见 pages-sub/app-detail（本切片只读信息）
 */
import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';

import { listMarketApps } from '@/api';
import { mediaUrl } from '@/api/client';
import TabBar from '@/components/business/tab-bar.vue';
import Empty from '@/components/ui/empty.vue';
import Icon from '@/components/ui/icon.vue';
import NavBar from '@/components/ui/nav-bar.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import type { MarketAppItem } from '@/types/api';
import {
  formatSmokeVerifiedAt,
  sortAppsVerifiedFirst,
  splitIntoWaterfallColumns,
} from '@/utils/market';

const { themeVars } = useAppTheme();
const { requireAuth } = useAuthGuard();

const apps = ref<MarketAppItem[]>([]);
const loading = ref(true);
const error = ref('');
const query = ref('');
const verifiedOnly = ref(true);
const kind = ref<'all' | 'image' | 'video'>('all');

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  let rows = apps.value.slice();
  if (verifiedOnly.value) rows = rows.filter((a) => a.smoke_status === 'pass');
  if (kind.value !== 'all') rows = rows.filter((a) => a.output_kind === kind.value);
  if (q) {
    rows = rows.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q) ||
        (a.author || '').toLowerCase().includes(q),
    );
  }
  return sortAppsVerifiedFirst(rows);
});

const columns = computed(() => splitIntoWaterfallColumns(filtered.value, 2));

async function load() {
  if (!(await requireAuth())) return;
  loading.value = true;
  error.value = '';
  try {
    apps.value = await listMarketApps();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

function coverSrc(a: MarketAppItem): string {
  const u = (a.cover_url || '').trim();
  return u ? mediaUrl(u) : '';
}

function smokeLabel(a: MarketAppItem): string {
  if (a.smoke_status !== 'pass') return '';
  const when = formatSmokeVerifiedAt(a.smoke_at);
  return when ? `实测可用 · ${when}` : '实测可用';
}

function openApp(a: MarketAppItem) {
  uni.navigateTo({ url: `/pages-sub/app-detail/app-detail?id=${encodeURIComponent(a.id)}` });
}

onShow(() => {
  void load();
});

onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});
</script>

<template>
  <view class="mkt" :style="themeVars">
    <NavBar title="市场" />
    <view class="mkt__toolbar">
      <view class="mkt__search">
        <Icon name="search" :size="32" color="var(--color-text-secondary)" />
        <input
          v-model="query"
          class="mkt__search-input"
          type="text"
          confirm-type="search"
          placeholder="搜索应用 / 作者"
          placeholder-class="mkt__ph"
        />
      </view>
      <scroll-view scroll-x class="mkt__chips" :show-scrollbar="false">
        <view
          class="mkt__chip"
          :class="{ 'is-on': verifiedOnly }"
          @tap="verifiedOnly = !verifiedOnly"
        >✓ 实测可用</view>
        <view
          class="mkt__chip"
          :class="{ 'is-on': kind === 'all' }"
          @tap="kind = 'all'"
        >全部</view>
        <view
          class="mkt__chip"
          :class="{ 'is-on': kind === 'image' }"
          @tap="kind = 'image'"
        >图片</view>
        <view
          class="mkt__chip"
          :class="{ 'is-on': kind === 'video' }"
          @tap="kind = 'video'"
        >视频</view>
      </scroll-view>
    </view>

    <view v-if="loading && !apps.length" class="mkt__state">加载中…</view>
    <view v-else-if="error" class="mkt__state mkt__state--err" @tap="load">{{ error }}（点按重试）</view>
    <Empty v-else-if="!filtered.length" title="没有匹配的应用" description="试试关掉筛选或换个关键词" />

    <view v-else class="mkt__waterfall">
      <view v-for="(col, ci) in columns" :key="ci" class="mkt__col">
        <view
          v-for="a in col"
          :key="a.id"
          class="mkt__card"
          hover-class="mkt__card--pressed"
          @tap="openApp(a)"
        >
          <view class="mkt__cover-wrap">
            <image
              v-if="coverSrc(a)"
              class="mkt__cover"
              :src="coverSrc(a)"
              mode="widthFix"
              lazy-load
            />
            <view v-else class="mkt__cover mkt__cover--fallback">
              <text class="mkt__cover-icon">{{ (a.icon || a.name || '?').slice(0, 1) }}</text>
            </view>
            <view v-if="smokeLabel(a)" class="mkt__badge">{{ smokeLabel(a) }}</view>
            <view v-if="a.content_modes && a.content_modes.includes('nsfw')" class="mkt__mode">R18</view>
          </view>
          <view class="mkt__meta">
            <text class="mkt__name">{{ a.name }}</text>
            <text class="mkt__author">{{ a.author || 'ToIV' }}</text>
          </view>
        </view>
      </view>
    </view>

    <TabBar :selected="1" />
  </view>
</template>

<style scoped lang="scss">
.mkt {
  min-height: 100vh;
  background: var(--color-bg);
  color: var(--color-text);
  padding-bottom: 8rpx;
}

.mkt__toolbar {
  padding: 8rpx 24rpx 16rpx;
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--color-bg);
}

.mkt__search {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12rpx;
  padding: 16rpx 20rpx;
  border-radius: 999rpx;
  background: var(--color-surface);
  border: 1rpx solid var(--color-border);
}

.mkt__search-input {
  flex: 1;
  font-size: var(--font-body);
  color: var(--color-text);
}

.mkt__ph {
  color: var(--color-text-secondary);
}

.mkt__chips {
  margin-top: 16rpx;
  white-space: nowrap;
}

.mkt__chip {
  display: inline-flex;
  align-items: center;
  margin-right: 12rpx;
  padding: 10rpx 22rpx;
  border-radius: 999rpx;
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
  background: var(--color-surface);
  border: 1rpx solid var(--color-border);

  &.is-on {
    color: var(--color-accent);
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }
}

.mkt__state {
  padding: 80rpx 32rpx;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: var(--font-body);
}

.mkt__state--err {
  color: var(--color-danger);
}

.mkt__waterfall {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 16rpx;
  padding: 0 16rpx 24rpx;
}

.mkt__col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.mkt__card {
  background: var(--color-surface);
  border-radius: 20rpx;
  overflow: hidden;
  border: 1rpx solid var(--color-border);

  &--pressed {
    opacity: 0.85;
  }
}

.mkt__cover-wrap {
  position: relative;
  width: 100%;
  background: var(--color-accent-soft);
}

.mkt__cover {
  width: 100%;
  display: block;
  vertical-align: top;

  &--fallback {
    min-height: 280rpx;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

.mkt__cover-icon {
  font-size: 64rpx;
  color: var(--color-text-secondary);
}

.mkt__badge {
  position: absolute;
  top: 12rpx;
  right: 12rpx;
  max-width: 86%;
  padding: 6rpx 12rpx;
  border-radius: 999rpx;
  font-size: 20rpx;
  line-height: 1.2;
  color: var(--color-on-pass);
  background: var(--color-pass-bg);
}

.mkt__mode {
  position: absolute;
  top: 12rpx;
  left: 12rpx;
  padding: 6rpx 12rpx;
  border-radius: 999rpx;
  font-size: 20rpx;
  color: #fff;
  background: rgba(180, 25, 25, 0.88);
}

.mkt__meta {
  padding: 16rpx 18rpx 20rpx;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.mkt__name {
  font-size: var(--font-body);
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mkt__author {
  font-size: var(--font-caption);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
