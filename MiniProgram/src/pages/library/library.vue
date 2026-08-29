<script setup lang="ts">
/**
 * 作品库页（MP5）：类型过滤 chips + 等宽网格 + 下拉刷新
 * MP15 无限分页：onReachBottom 触底续拉，页大小 LIBRARY_PAGE_SIZE（2/3/4 列公倍数 24）
 * MP16 服务端 kind 过滤：切换过滤桶时重置分页，按 kind 参数请求服务端过滤后数据
 * - 状态机：loading（首屏）/ refreshing（下拉）/ loadingMore（触底）/ hasMore / error，防重入
 * - 游标 offset 独立追踪服务端流位置（原始返回数推进）；追加按 id 去重（appendPage）
 * - 过滤 chips 切换时重置分页，重新拉取服务端过滤后数据（不再依赖客户端过滤已加载前缀）
 * - 下拉刷新 / onShow 重进：重置 offset=0 拉第一页（新完成的作业回到顶部，不重复插入）
 * - 页面原生滚动承载下拉刷新与触底；只收藏 done 且有产物的作业（collectArtifacts）
 */
import { computed, ref, watch } from 'vue';
import { onPullDownRefresh, onReachBottom, onShow } from '@dcloudio/uni-app';

import { deleteJob, listJobs } from '@/api';
import { mediaUrl } from '@/api/client';
import TabBar from '@/components/business/tab-bar.vue';
import Empty from '@/components/ui/empty.vue';
import Icon from '@/components/ui/icon.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import type { JobItem } from '@/types/api';
import {
  cardSizePx,
  collectArtifacts,
  columnCount,
  countByFilter,
  FILTERS,
  isVideoPath,
  kindToFilter,
  kindsQueryForFilter,
  LIBRARY_PAGE_SIZE,
  type FilterKey,
} from '@/utils/library';
import {
  deleteSummaryText,
  runBatch,
  saveSummaryText,
  selectAll,
  splitSavable,
  summarizeBatch,
  toggleSelect,
} from '@/utils/library-batch';
import {
  appendPage,
  cursorAfterFirst,
  cursorAfterNext,
  INITIAL_CURSOR,
} from '@/utils/pagination';
const { themeVars } = useAppTheme();
const { requireAuth } = useAuthGuard();

const jobs = ref<JobItem[]>([]);
/** 首屏加载（有数据后的刷新不亮 loading，避免闪烁） */
const loading = ref(true);
const refreshing = ref(false);
const loadingMore = ref(false);
const loadMoreError = ref('');
const error = ref('');
const filter = ref<FilterKey>('all');
const offset = ref(INITIAL_CURSOR.offset);
const hasMore = ref(INITIAL_CURSOR.hasMore);

/** 代际令牌：refresh/过滤切换重置后使在途 loadMore 的结果作废（防旧页追加污染游标） */
let generation = 0;

const artifacts = computed(() => collectArtifacts(jobs.value));
const counts = computed(() => countByFilter(artifacts.value));

/**
 * 空态语义：流为空 = 该过滤条件下真的无作品（服务端已过滤，无需客户端再过滤）
 */
const showEmpty = computed(() => {
  if (artifacts.value.length > 0) return false;
  if (loading.value || loadingMore.value) return false;
  return true;
});

/** 底部反馈：加载中 / 失败点按重试 / 结尾态 / 上拉提示（可点按兜底，短内容无法触底时逃生） */
const moreTappable = computed(
  () => Boolean(loadMoreError.value) || (hasMore.value && !loadingMore.value),
);
const moreText = computed(() => {
  if (loadingMore.value) return '加载中…';
  if (loadMoreError.value) return '加载失败，点击重试';
  if (!hasMore.value) return '没有更多了';
  return '上拉加载更多';
});

/** 网格尺寸（px，系统信息同步可取） */
const windowWidth = ref(375);
try {
  const info = uni.getSystemInfoSync() as { windowWidth?: number };
  windowWidth.value = info.windowWidth ?? 375;
} catch {
  windowWidth.value = 375;
}
const columns = computed(() => columnCount(windowWidth.value));
const cardSize = computed(() => cardSizePx(windowWidth.value, columns.value));

/** 第一页全量重拉（首屏/下拉刷新/onShow/过滤切换）：重置游标，新完成的作业回到顶部 */
async function refresh() {
  generation += 1;
  error.value = '';
  try {
    const page = await listJobs({
      limit: LIBRARY_PAGE_SIZE,
      offset: 0,
      kind: kindsQueryForFilter(filter.value),
    });
    jobs.value = page;
    const cursor = cursorAfterFirst(page, LIBRARY_PAGE_SIZE);
    offset.value = cursor.offset;
    hasMore.value = cursor.hasMore;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

/** 触底续拉下一页：防重入（首屏/下拉/上一页在途不触发），追加按 id 去重 */
async function loadMore() {
  if (loading.value || refreshing.value || loadingMore.value || !hasMore.value) return;
  const gen = generation;
  loadingMore.value = true;
  loadMoreError.value = '';
  try {
    const page = await listJobs({
      limit: LIBRARY_PAGE_SIZE,
      offset: offset.value,
      kind: kindsQueryForFilter(filter.value),
    });
    if (gen !== generation) return;
    jobs.value = appendPage(jobs.value, page);
    const cursor = cursorAfterNext(
      { offset: offset.value, hasMore: hasMore.value },
      page,
      LIBRARY_PAGE_SIZE,
    );
    offset.value = cursor.offset;
    hasMore.value = cursor.hasMore;
  } catch (err) {
    if (gen === generation) {
      loadMoreError.value = err instanceof Error ? err.message : '加载失败';
    }
  } finally {
    loadingMore.value = false;
  }
}

/** 切换过滤桶：重置分页，重新拉取服务端过滤后数据；清空选择并退出选择模式（MP25） */
watch(filter, () => {
  exitSelecting();
  offset.value = INITIAL_CURSOR.offset;
  hasMore.value = INITIAL_CURSOR.hasMore;
  loading.value = true;
  void refresh();
});

onShow(() => {
  if (!requireAuth()) return;
  loading.value = jobs.value.length === 0;
  void refresh();
});

onPullDownRefresh(async () => {
  exitSelecting();
  refreshing.value = true;
  await refresh();
  refreshing.value = false;
  uni.stopPullDownRefresh();
});

onReachBottom(() => {
  void loadMore();
});

/** 网格卡缩略图：图像类显示首产物；视频/音频/3D 用组图标占位 */
function thumbOf(job: JobItem): string {
  const group = kindToFilter(job.kind);
  if (group !== 'image' && group !== null) return '';
  const first = job.results[0];
  return first && !isVideoPath(first) ? mediaUrl(first) : '';
}

function groupIcon(job: JobItem): string {
  const group = kindToFilter(job.kind);
  if (group === 'video') return 'film';
  if (group === 'audio') return 'music';
  if (group === '3d') return 'box';
  return 'image';
}

function openDetail(job: JobItem) {
  uni.navigateTo({
    url: `/pages-sub/artifact/artifact?id=${encodeURIComponent(job.id)}`,
    success: (res) => {
      res.eventChannel.emit('job', { job });
    },
  });
}

// ── 多选与批量管理（MP25） ──
// 选择集独立持 Set<id>，跨无限分页加载保持；切过滤桶/下拉刷新清空并退出（见 watch/onPullDownRefresh）

const selecting = ref(false);
const selected = ref<Set<string>>(new Set());
/** 批量执行中（防重复点；操作条转进度态） */
const acting = ref(false);
const progress = ref<{ label: string; done: number; total: number } | null>(null);

const hasSelection = computed(() => selected.value.size > 0);

/** 微信原生 longpress 触发后松开仍会合成 tap：守卫吞咽紧随的这一次 tap，防刚选中又被 toggle 掉 */
let longPressGuard = false;

function enterSelecting(jobId?: string) {
  if (acting.value) return;
  selecting.value = true;
  if (jobId) selected.value = toggleSelect(selected.value, jobId);
}

function exitSelecting() {
  selecting.value = false;
  selected.value = new Set();
  progress.value = null;
}

function onCardLongPress(job: JobItem) {
  longPressGuard = true;
  setTimeout(() => {
    longPressGuard = false;
  }, 350);
  if (!selecting.value) {
    enterSelecting(job.id);
    return;
  }
  selected.value = toggleSelect(selected.value, job.id);
}

function onCardTap(job: JobItem) {
  if (longPressGuard) return;
  if (selecting.value) {
    selected.value = toggleSelect(selected.value, job.id);
    return;
  }
  openDetail(job);
}

/** 全选当前已加载项（含跨分页已加载） */
function selectAllLoaded() {
  if (acting.value) return;
  selected.value = selectAll(artifacts.value);
}

/** 批量删除：二次确认 → 并发限速循环单删 → 进度态 → 汇总 toast → 重置游标重拉 */
function confirmBatchDelete() {
  const targets = artifacts.value.filter((j) => selected.value.has(j.id));
  if (acting.value || targets.length === 0) return;
  uni.showModal({
    title: `删除 ${targets.length} 项作品？`,
    content: '删除后不可恢复，产物文件将由系统另行清理',
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (res.confirm) void runBatchDelete(targets);
    },
  });
}

async function runBatchDelete(targets: JobItem[]) {
  acting.value = true;
  progress.value = { label: '删除中', done: 0, total: targets.length };
  const results = await runBatch(targets, (j) => deleteJob(j.id), {
    onProgress: (done, total) => {
      progress.value = { label: '删除中', done, total };
    },
  });
  const summary = summarizeBatch(results);
  progress.value = null;
  acting.value = false;
  // 失败项保留勾选（含全败）待重试；全成则清空退出
  selected.value = new Set(summary.failedIds);
  if (summary.failed === 0) selecting.value = false;
  uni.showToast({ title: deleteSummaryText(summary), icon: 'none' });
  // 删除后服务端流缩短，旧 offset 会跳项：重置游标重拉第一页
  await refresh();
}

/**
 * 单件保存相册：复用 artifact.vue 下载链路（downloadFile → save*ToPhotosAlbum）
 * H5 无相册 API：save 缺失直接 reject（走查环境以 stub 计数断言），真机 fail 转人话错误
 */
function saveJobToAlbum(job: JobItem): Promise<void> {
  const path = job.results[0] ?? '';
  const url = path ? mediaUrl(path) : '';
  const save = isVideoPath(path) ? uni.saveVideoToPhotosAlbum : uni.saveImageToPhotosAlbum;
  return new Promise((resolve, reject) => {
    if (!url || typeof save !== 'function') {
      reject(new Error('当前平台不支持保存'));
      return;
    }
    uni.downloadFile({
      url,
      success: (dl) => {
        if (dl.statusCode !== 200) {
          reject(new Error('下载失败，请检查网络'));
          return;
        }
        save({
          filePath: dl.tempFilePath,
          success: () => resolve(),
          fail: () => reject(new Error('保存失败，请检查相册权限')),
        });
      },
      fail: () => reject(new Error('下载失败，请检查网络')),
    });
  });
}

/** 批量保存相册：仅 image/video 可保存（audio/3D 跳过计入汇总），完成后退出选择模式 */
async function batchSave() {
  const targets = artifacts.value.filter((j) => selected.value.has(j.id));
  if (acting.value || targets.length === 0) return;
  const { savable, skipped } = splitSavable(targets);
  if (savable.length === 0) {
    uni.showToast({ title: saveSummaryText(summarizeBatch([]), skipped.length), icon: 'none' });
    return;
  }
  acting.value = true;
  progress.value = { label: '保存中', done: 0, total: savable.length };
  const results = await runBatch(savable, saveJobToAlbum, {
    onProgress: (done, total) => {
      progress.value = { label: '保存中', done, total };
    },
  });
  const summary = summarizeBatch(results);
  progress.value = null;
  acting.value = false;
  uni.showToast({ title: saveSummaryText(summary, skipped.length), icon: 'none' });
  exitSelecting();
}
</script>

<template>
  <view
    class="library"
    :style="themeVars"
  >
    <!-- 顶行：过滤 chips（横向滚动，带计数）+ 多选入口（MP25） -->
    <view class="library__topbar">
      <scroll-view
        scroll-x
        class="library__filters"
        :show-scrollbar="false"
        enhanced
      >
        <view class="library__filters-row">
          <view
            v-for="f in FILTERS"
            :key="f.key"
            class="library__chip"
            :class="{ 'library__chip--active': filter === f.key }"
            hover-class="library__chip--pressed"
            @tap="filter = f.key"
          >
            <text
              class="library__chip-label"
              :class="{ 'library__chip-label--active': filter === f.key }"
            >
              {{ f.label }}
            </text>
            <text
              class="library__chip-count"
              :class="{ 'library__chip-count--active': filter === f.key }"
            >
              {{ counts[f.key] }}
            </text>
          </view>
        </view>
      </scroll-view>
      <view
        v-if="!selecting && artifacts.length > 0"
        class="library__select-toggle"
        hover-class="library__select-toggle--pressed"
        data-action="enter-select"
        @tap="enterSelecting()"
      >
        <text class="library__select-toggle-text">
          选择
        </text>
      </view>
    </view>

    <!-- 首次加载 -->
    <view
      v-if="loading && jobs.length === 0"
      class="library__center"
    >
      <text class="library__hint">
        加载中…
      </text>
    </view>

    <!-- 加载失败 -->
    <view
      v-else-if="error && jobs.length === 0"
      class="library__center"
    >
      <Empty
        icon="circle-alert"
        title="加载失败"
        :description="error"
      >
        <template #action>
          <view
            class="library__cta"
            hover-class="library__cta--pressed"
            @tap="refresh"
          >
            <text class="library__cta-text">
              重新加载
            </text>
          </view>
        </template>
      </Empty>
    </view>

    <!-- 空态：服务端已过滤，流为空即该条件下无作品 -->
    <view
      v-else-if="showEmpty"
      class="library__center"
    >
      <Empty
        icon="image"
        :title="filter === 'all' ? '还没有作品' : '该分类暂无作品'"
        :description="filter === 'all' ? '完成的图片与视频会收藏在这里' : '该分类下暂无作品，换个分类看看'"
      />
    </view>

    <!-- 网格（页面原生滚动，承载下拉刷新与触底续拉） -->
    <template v-else>
      <view
        class="library__grid"
        :style="{ gap: '24rpx' }"
      >
        <view
          v-for="job in artifacts"
          :key="job.id"
          class="library__card"
          :class="{ 'library__card--selected': selecting && selected.has(job.id) }"
          :style="{ width: `${cardSize}px`, height: `${cardSize}px` }"
          :data-job-id="job.id"
          hover-class="library__card--pressed"
          @tap="onCardTap(job)"
          @longpress="onCardLongPress(job)"
        >
          <image
            v-if="thumbOf(job)"
            class="library__card-img"
            :src="thumbOf(job)"
            mode="aspectFill"
            lazy-load
          />
          <view
            v-else
            class="library__card-placeholder"
          >
            <Icon
              :name="groupIcon(job)"
              :size="64"
              color="var(--color-text-secondary)"
              :stroke-width="1.5"
            />
          </view>
          <view
            v-if="isVideoPath(job.results[0] ?? '')"
            class="library__card-play"
          >
            <Icon
              name="play"
              :size="32"
              color="#FFFFFF"
            />
          </view>
          <!-- 多产物角标 -->
          <view
            v-if="job.results.length > 1"
            class="library__card-count"
          >
            <text class="library__card-count-text">
              ×{{ job.results.length }}
            </text>
          </view>
          <!-- 多选圈（MP25）：选择模式常驻右上；未选空心圈，已选 accent 实心 + check -->
          <view
            v-if="selecting"
            class="library__card-selector"
            :class="{ 'library__card-selector--selected': selected.has(job.id) }"
            :data-selected="selected.has(job.id) ? '1' : '0'"
          >
            <Icon
              v-if="selected.has(job.id)"
              name="check"
              :size="28"
              color="#FFFFFF"
            />
          </view>
        </view>
      </view>

      <!-- 分页尾部：加载中 spinner / 失败点按重试 / 「没有更多了」结尾态 / 上拉提示（可点按兜底） -->
      <view
        class="library__more"
        :hover-class="moreTappable ? 'library__more--pressed' : ''"
        @tap="moreTappable && loadMore()"
      >
        <view
          v-if="loadingMore"
          class="library__more-spinner"
        >
          <Icon
            name="loader-circle"
            :size="32"
            color="var(--color-text-secondary)"
          />
        </view>
        <text class="library__more-text">
          {{ moreText }}
        </text>
      </view>
    </template>

    <!-- 批量操作条（MP25）：固定于 TabBar 之上；执行中转进度态「删除中 x/N」防重复点 -->
    <view
      v-if="selecting"
      class="library__batch-gap"
    />
    <view
      v-if="selecting"
      class="library__batch-bar"
    >
      <text class="library__batch-count">
        {{ progress ? `${progress.label} ${progress.done}/${progress.total}` : `已选 ${selected.size} 项` }}
      </text>
      <view class="library__batch-actions">
        <view
          class="library__batch-btn"
          :class="{ 'library__batch-btn--disabled': acting }"
          hover-class="library__batch-btn--pressed"
          data-action="select-all"
          @tap="selectAllLoaded"
        >
          <text class="library__batch-btn-text">
            全选
          </text>
        </view>
        <view
          class="library__batch-btn"
          :class="{ 'library__batch-btn--disabled': acting || !hasSelection }"
          hover-class="library__batch-btn--pressed"
          data-action="batch-save"
          @tap="batchSave"
        >
          <text class="library__batch-btn-text">
            保存
          </text>
        </view>
        <view
          class="library__batch-btn library__batch-btn--danger"
          :class="{ 'library__batch-btn--disabled': acting || !hasSelection }"
          hover-class="library__batch-btn--pressed"
          data-action="batch-delete"
          @tap="confirmBatchDelete"
        >
          <text class="library__batch-btn-text library__batch-btn-text--danger">
            删除
          </text>
        </view>
        <view
          class="library__batch-btn"
          :class="{ 'library__batch-btn--disabled': acting }"
          hover-class="library__batch-btn--pressed"
          data-action="exit-select"
          @tap="exitSelecting"
        >
          <text class="library__batch-btn-text">
            取消
          </text>
        </view>
      </view>
    </view>

    <TabBar :selected="2" />
  </view>
</template>

<style scoped lang="scss">
.library {
  min-height: 100vh;
  background: var(--color-bg);

  &__topbar {
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  &__filters {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
  }

  &__select-toggle {
    flex-shrink: 0;
    margin-right: var(--space-4);
    margin-left: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: 999rpx;
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);

    &--pressed {
      opacity: 0.85;
    }
  }

  &__select-toggle-text {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 600;
  }

  &__filters-row {
    display: flex;
    flex-direction: row;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
  }

  &__chip {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
    min-height: 64rpx;
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

  &__chip-count {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);

    &--active {
      color: var(--color-accent);
    }
  }

  &__center {
    min-height: 60vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  &__hint {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__cta {
    padding: var(--space-3) var(--space-8);
    border-radius: var(--radius-md);
    background: var(--color-accent);

    &--pressed {
      opacity: 0.88;
    }
  }

  &__cta-text {
    font-size: var(--font-body);
    color: #ffffff;
    font-weight: 500;
  }

  &__grid {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    padding: 0 var(--space-4);
  }

  &__card {
    position: relative;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    transition: transform 0.18s ease, border-color 0.18s ease;

    &--pressed {
      opacity: 0.85;
    }

    &--selected {
      border-color: var(--color-accent);
      transform: scale(0.97);
    }
  }

  &__card-selector {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    width: 44rpx;
    height: 44rpx;
    border-radius: 999rpx;
    border: 2rpx solid var(--color-border);
    background: rgba(255, 255, 255, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;

    &--selected {
      border-color: var(--color-accent);
      background: var(--color-accent);
    }
  }

  &__card-img {
    width: 100%;
    height: 100%;
  }

  &__card-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__card-play {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.25);
  }

  &__card-count {
    position: absolute;
    right: var(--space-2);
    bottom: var(--space-2);
    padding: 0 var(--space-2);
    min-height: 36rpx;
    border-radius: 999rpx;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__card-count-text {
    color: #ffffff;
    font-size: var(--font-caption);
    font-weight: 500;
  }

  &__more {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 96rpx;
    padding: var(--space-3) var(--space-4);

    &--pressed {
      opacity: 0.7;
    }
  }

  &__more-spinner {
    display: flex;
    animation: library-more-spin 0.9s linear infinite;
  }

  &__more-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  /* 操作条占位：防固定条遮挡分页尾部 */
  &__batch-gap {
    height: 112rpx;
  }

  /* 批量操作条：fixed 于 TabBar（116rpx + safe-area）之上，safe-area 由 TabBar 承担 */
  &__batch-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(116rpx + env(safe-area-inset-bottom));
    z-index: 110;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
    border-top: 1rpx solid var(--color-border);
  }

  &__batch-count {
    flex-shrink: 0;
    font-size: var(--font-caption);
    color: var(--color-text);
    font-weight: 600;
  }

  &__batch-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__batch-btn {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);
    background: var(--color-bg);

    &--pressed {
      opacity: 0.85;
    }

    &--danger {
      border-color: var(--color-danger);
    }

    &--disabled {
      opacity: 0.45;
    }
  }

  &__batch-btn-text {
    font-size: var(--font-caption);
    color: var(--color-text);

    &--danger {
      color: var(--color-danger);
    }
  }
}

@keyframes library-more-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
