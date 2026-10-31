<script setup lang="ts">
/**
 * Agent 团队监控列表页（MP21 一期：只读监控；取消在详情页）
 * - 状态过滤 chips：全部/进行中/待确认/已完成/已终止（后端 status 仅单值精确匹配，
 *   语义桶客户端分桶；limit=50 全量拉，计数同步）
 * - 轮询语义对齐 jobs 页：有非终态 run 才 2s 轮询，全终态即停
 * - 页面原生滚动承载下拉刷新；点卡片进详情页（SSE 实时事件流 + 取消）
 * - 一期不做创建入口（创建在主站；空态引导去主站发起）
 */
import { computed, ref } from 'vue';
import { onHide, onPullDownRefresh, onShow, onUnload } from '@dcloudio/uni-app';

import { listAgentRuns } from '@/api';
import Empty from '@/components/ui/empty.vue';
import Tag from '@/components/ui/tag.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import {
  cancelPoll,
  createPollHandle,
  PollAbortedError,
  pollUntil,
  type PollHandle,
} from '@/composables/use-poll';
import type { AgentRunSummary } from '@/types/api';
import {
  hasActiveRuns,
  inRunFilter,
  RUN_FILTERS,
  runStatusMeta,
  type RunFilterKey,
} from '@/utils/agent-run';
import { formatRelative } from '@/utils/format';

const { themeVars } = useAppTheme();
const { requireAuth } = useAuthGuard();

const runs = ref<AgentRunSummary[]>([]);
/** 首次加载（有数据后的轮询刷新不亮 loading，避免闪烁） */
const loading = ref(true);
const error = ref('');
const filter = ref<RunFilterKey>('all');

let pollHandle: PollHandle | undefined;

const counts = computed<Record<RunFilterKey, number>>(() => ({
  all: runs.value.length,
  active: runs.value.filter((r) => inRunFilter(r, 'active')).length,
  gate: runs.value.filter((r) => inRunFilter(r, 'gate')).length,
  done: runs.value.filter((r) => inRunFilter(r, 'done')).length,
  terminated: runs.value.filter((r) => inRunFilter(r, 'terminated')).length,
}));

const filtered = computed(() =>
  filter.value === 'all' ? runs.value : runs.value.filter((r) => inRunFilter(r, filter.value)),
);

/** 进度文案：done/total 完成（approved 后端已计入 done），有失败追加 */
function progressText(run: AgentRunSummary): string {
  const c = run.task_counts;
  const base = `${c.done}/${c.total} 完成`;
  return c.error > 0 ? `${base} · ${c.error} 失败` : base;
}

/**
 * 拉取并视活跃情况轮询（重入安全：先取消旧轮询再启新的）
 * pollUntil 每 2s 拉一次，直到无非终态 run；连续失败 5 次抛出
 */
async function refreshAndPoll(): Promise<void> {
  cancelPoll(pollHandle);
  const handle = createPollHandle();
  pollHandle = handle;
  try {
    await pollUntil<AgentRunSummary[]>({
      fetcher: () => listAgentRuns(),
      shouldStop: (list) => !hasActiveRuns(list),
      intervals: [2000],
      onUpdate: (list, err) => {
        if (handle.cancelled) return;
        if (list) {
          runs.value = list;
          error.value = '';
        } else if (err && runs.value.length === 0) {
          error.value = err.message;
        }
      },
      handle,
    });
  } catch (err) {
    if (err instanceof PollAbortedError) return;
    if (runs.value.length === 0) {
      error.value = err instanceof Error ? err.message : '加载失败';
    } else {
      uni.showToast({ title: '刷新失败，请稍后再试', icon: 'none' });
    }
  } finally {
    loading.value = false;
  }
}

onShow(() => {
  if (!requireAuth()) return;
  loading.value = runs.value.length === 0;
  void refreshAndPoll();
});

onHide(() => cancelPoll(pollHandle));
onUnload(() => cancelPoll(pollHandle));

onPullDownRefresh(async () => {
  await refreshAndPoll();
  uni.stopPullDownRefresh();
});

function openDetail(run: AgentRunSummary) {
  uni.navigateTo({
    url: `/pages/agent-runs/detail?id=${encodeURIComponent(run.id)}`,
  });
}
</script>

<template>
  <view
    class="runs"
    :style="themeVars"
  >
    <!-- 状态过滤 chips（横向滚动，带计数） -->
    <scroll-view
      scroll-x
      class="runs__filters"
      :show-scrollbar="false"
      enhanced
    >
      <view class="runs__filters-row">
        <view
          v-for="f in RUN_FILTERS"
          :key="f.key"
          class="runs__chip"
          :class="{ 'runs__chip--active': filter === f.key }"
          hover-class="runs__chip--pressed"
          :data-filter="f.key"
          @tap="filter = f.key"
        >
          <text
            class="runs__chip-label"
            :class="{ 'runs__chip-label--active': filter === f.key }"
          >
            {{ f.label }}
          </text>
          <text
            class="runs__chip-count"
            :class="{ 'runs__chip-count--active': filter === f.key }"
          >
            {{ counts[f.key] }}
          </text>
        </view>
      </view>
    </scroll-view>

    <!-- 首次加载 -->
    <view
      v-if="loading && runs.length === 0"
      class="runs__center"
    >
      <text class="runs__hint">
        加载中…
      </text>
    </view>

    <!-- 加载失败（无数据兜底） -->
    <view
      v-else-if="error && runs.length === 0"
      class="runs__center"
    >
      <Empty
        icon="circle-alert"
        title="加载失败"
        :description="error"
      >
        <template #action>
          <view
            class="runs__cta"
            hover-class="runs__cta--pressed"
            @tap="refreshAndPoll"
          >
            <text class="runs__cta-text">
              重新加载
            </text>
          </view>
        </template>
      </Empty>
    </view>

    <!-- 空态（一期只读：创建入口在主站，引导文案说明来源） -->
    <view
      v-else-if="filtered.length === 0"
      class="runs__center"
    >
      <Empty
        icon="layers"
        :title="filter === 'all' ? '还没有 Agent 任务' : '该分类暂无任务'"
        :description="filter === 'all' ? '在主站发起 Agent 团队任务后，进度会实时出现在这里' : '换个分类看看'"
      />
    </view>

    <!-- run 卡片流 -->
    <view
      v-else
      class="runs__list"
    >
      <view
        v-for="run in filtered"
        :key="run.id"
        class="runs__card"
        hover-class="runs__card--pressed"
        :data-run-id="run.id"
        @tap="openDetail(run)"
      >
        <view class="runs__card-head">
          <text class="runs__card-goal">
            {{ run.goal || '未命名任务' }}
          </text>
          <Tag
            :tone="runStatusMeta(run.status).tone"
            :label="runStatusMeta(run.status).label"
          />
        </view>
        <view class="runs__card-meta">
          <text class="runs__card-level">
            {{ run.level }}
          </text>
          <text class="runs__card-progress">
            {{ progressText(run) }}
          </text>
          <text class="runs__card-time">
            {{ formatRelative(run.created_at) }}
          </text>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.runs {
  min-height: 100vh;
  background: var(--color-bg);

  &__filters {
    white-space: nowrap;
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
    flex-shrink: 0;
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
      font-weight: 500;
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

  &__list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-1) var(--space-4) var(--space-4);
  }

  &__card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);

    &--pressed {
      opacity: 0.88;
    }
  }

  &__card-head {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  &__card-goal {
    flex: 1;
    font-size: var(--font-body);
    font-weight: 500;
    color: var(--color-text);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  &__card-meta {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
  }

  &__card-level {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
  }

  &__card-progress {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__card-time {
    margin-left: auto;
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }
}
</style>
