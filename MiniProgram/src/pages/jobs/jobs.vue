<script setup lang="ts">
/**
 * 作业页（MP4）：卡片流 + 活跃轮询 + 下拉刷新 + 删除/失败重试
 * - 轮询语义对齐 Mobile JobsScreen：有 queued/running 才 2s 轮询，全终态即停
 * - 页面级滚动承载原生下拉刷新（不用 scroll-view 全包，否则 onPullDownRefresh 不触发）
 * - 点按：done → previewMedia 预览产物（详情页在 MP5 接管）；活跃/失败 → 状态提示
 * - MP29：会话内提交的作业叠加 SSE 进度流（trackJobSse），轮询保留为兜底/列表真相源；
 *   仅「本次会话内刚提交」且有凭据的活跃作业起流，其余行为不回退
 */
import { ref } from 'vue';
import { onHide, onPullDownRefresh, onShow, onUnload } from '@dcloudio/uni-app';

import { deleteJob, listJobs, submitTxt2Img } from '@/api';
import JobCard from '@/components/business/job-card.vue';
import TabBar from '@/components/business/tab-bar.vue';
import Empty from '@/components/ui/empty.vue';
import Icon from '@/components/ui/icon.vue';
import NavBar from '@/components/ui/nav-bar.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import {
  cancelPoll,
  createPollHandle,
  PollAbortedError,
  pollUntil,
  type PollHandle,
} from '@/composables/use-poll';
import type { JobItem } from '@/types/api';
import { hasActiveJobs, jobStatusMeta } from '@/utils/format';
import {
  getJobSseCredentials,
  registerJobSseCredentials,
  unregisterJobSseCredentials,
} from '@/utils/job-sse-registry';
import { planJobSseSync, trackJobSse, type JobTrackHandle } from '@/utils/job-tracker';

const { themeVars } = useAppTheme();
const { requireAuth } = useAuthGuard();

const jobs = ref<JobItem[]>([]);
/** 首次加载（有数据后的轮询刷新不亮 loading，避免闪烁） */
const loading = ref(true);
const error = ref('');
const retryingId = ref<string | null>(null);

let pollHandle: PollHandle | undefined;

// ── MP29：会话内作业 SSE 进度跟踪（轮询之上的实时加速层）──

/** 跟踪中作业的实时进度：prompt_id → 0-100（进度条数据点） */
const ssePct = ref<Record<string, number>>({});
/** 已收到质量预警的作业（卡片预警图标；只提示不阻塞，对齐后端语义） */
const sseWarned = ref<Record<string, boolean>>({});
const trackers = new Map<string, JobTrackHandle>();

function dropSseState(promptId: string): void {
  const pct = { ...ssePct.value };
  delete pct[promptId];
  ssePct.value = pct;
  const warned = { ...sseWarned.value };
  delete warned[promptId];
  sseWarned.value = warned;
}

function startSseTracker(promptId: string): void {
  const creds = getJobSseCredentials(promptId);
  if (!creds || trackers.has(promptId)) return;
  const handle = trackJobSse(promptId, creds, {
    onProgress: ({ pct }) => {
      ssePct.value = { ...ssePct.value, [promptId]: pct };
    },
    onQualityWarning: () => {
      if (sseWarned.value[promptId]) return;
      sseWarned.value = { ...sseWarned.value, [promptId]: true };
      uni.showToast({ title: '质量预警：产物可能低于预期', icon: 'none' });
    },
    onDone: () => finalizeSseTracker(promptId, true),
    onError: () => finalizeSseTracker(promptId, true),
    // 回退：SSE 放弃后既有轮询已在跑，静默收口即可（行为不回退）
    onFallback: () => finalizeSseTracker(promptId, false),
  });
  trackers.set(promptId, handle);
}

/** 终态/回退收口：停跟踪、清凭据（后续列表刷新不再起流）；终态立即刷新列表取产物/终态 */
function finalizeSseTracker(promptId: string, refresh: boolean): void {
  const handle = trackers.get(promptId);
  if (handle) {
    handle.abort();
    trackers.delete(promptId);
  }
  unregisterJobSseCredentials(promptId);
  dropSseState(promptId);
  if (refresh) void refreshAndPoll();
}

/** 每次列表更新后对齐跟踪集：活跃+有会话凭据+未跟踪 → 起流；跟踪中转终态/消失 → 停流 */
function syncSseTrackers(list: JobItem[]): void {
  const plan = planJobSseSync(
    list,
    new Set(trackers.keys()),
    (pid) => getJobSseCredentials(pid) !== undefined,
  );
  for (const promptId of plan.toStop) finalizeSseTracker(promptId, false);
  for (const promptId of plan.toStart) startSseTracker(promptId);
}

function stopAllSseTrackers(): void {
  for (const handle of trackers.values()) handle.abort();
  trackers.clear();
  ssePct.value = {};
  sseWarned.value = {};
}

/**
 * 拉取并视活跃情况轮询（重入安全：先取消旧轮询再启新的）
 * pollUntil 每 2s 拉一次，直到无活跃作业；连续失败 5 次抛出
 */
async function refreshAndPoll(): Promise<void> {
  cancelPoll(pollHandle);
  const handle = createPollHandle();
  pollHandle = handle;
  try {
    await pollUntil<JobItem[]>({
      fetcher: () => listJobs({ limit: 50 }),
      shouldStop: (list) => !hasActiveJobs(list),
      intervals: [2000],
      onUpdate: (list, err) => {
        if (handle.cancelled) return;
        if (list) {
          jobs.value = list;
          error.value = '';
          syncSseTrackers(list);
        } else if (err && jobs.value.length === 0) {
          error.value = err.message;
        }
      },
      handle,
    });
  } catch (err) {
    if (err instanceof PollAbortedError) return;
    if (jobs.value.length === 0) {
      error.value = err instanceof Error ? err.message : '作业加载失败';
    } else {
      uni.showToast({ title: '刷新失败，请稍后再试', icon: 'none' });
    }
  } finally {
    loading.value = false;
  }
}

onShow(() => {
  if (!requireAuth()) return;
  loading.value = jobs.value.length === 0;
  void refreshAndPoll();
});

// 页面隐藏/卸载：停轮询 + 停全部 SSE 跟踪（凭据保留，回前台 onShow 刷新后按列表重起）
onHide(() => {
  cancelPoll(pollHandle);
  stopAllSseTrackers();
});
onUnload(() => {
  cancelPoll(pollHandle);
  stopAllSseTrackers();
});

onPullDownRefresh(async () => {
  await refreshAndPoll();
  uni.stopPullDownRefresh();
});

async function handleRemove(job: JobItem) {
  try {
    await deleteJob(job.id);
    jobs.value = jobs.value.filter((j) => j.id !== job.id);
    syncSseTrackers(jobs.value);
    uni.showToast({ title: '已删除', icon: 'none' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '删除失败',
      icon: 'none',
    });
  }
}

/** 失败重试：同 prompt 重提交 txt2img（对齐 Mobile JobsScreen retry）；MP29 登记凭据纳入 SSE 跟踪 */
async function handleRetry(job: JobItem) {
  if (retryingId.value) return;
  retryingId.value = job.id;
  try {
    const res = await submitTxt2Img({ positive: job.prompt });
    registerJobSseCredentials(res);
    uni.showToast({ title: '已重新提交', icon: 'none' });
    void refreshAndPoll();
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '重试失败',
      icon: 'none',
    });
  } finally {
    retryingId.value = null;
  }
}

function handleTap(job: JobItem) {
  // 裁切链窗口期:done 但 post_status=processing(trim/extend 后台裁切中),
  // results 是未裁原片 —— 拦截进详情,提示等待;轮询持续(hasActiveJobs 含 processing),清零后正常进入
  if (job.status === 'done' && job.post_status === 'processing') {
    uni.showToast({ title: '精确裁切中，请稍候', icon: 'none' });
    return;
  }
  if (job.status === 'done' && job.results.length > 0) {
    // 进详情页（版本链/复用/下载/删除），eventChannel 传 job 对象
    uni.navigateTo({
      url: `/pages-sub/artifact/artifact?id=${encodeURIComponent(job.id)}`,
      success: (res) => {
        res.eventChannel.emit('job', { job });
      },
    });
    return;
  }
  if (job.status === 'error') {
    uni.showToast({ title: '生成失败，可点右侧重试', icon: 'none' });
    return;
  }
  uni.showToast({ title: `${jobStatusMeta(job.status).label}，请稍候`, icon: 'none' });
}

function goCreate() {
  uni.reLaunch({ url: '/pages/index/index' });
}

/** Agent 团队监控入口（MP21：nav 右侧按钮 → 运行列表页） */
function goAgentRuns() {
  uni.navigateTo({ url: '/pages/agent-runs/agent-runs' });
}
</script>

<template>
  <view
    class="jobs"
    :style="themeVars"
  >
    <NavBar title="作业">
      <template #right>
        <view
          class="jobs__agent"
          hover-class="jobs__agent--pressed"
          data-action="open-agent-runs"
          @tap="goAgentRuns"
        >
          <Icon
            name="zap"
            :size="36"
            color="var(--color-accent)"
          />
          <text class="jobs__agent-text">
            Agent
          </text>
        </view>
      </template>
    </NavBar>

    <!-- 首次加载 -->
    <view
      v-if="loading && jobs.length === 0"
      class="jobs__center"
    >
      <text class="jobs__hint">
        加载中…
      </text>
    </view>

    <!-- 加载失败（无数据兜底） -->
    <view
      v-else-if="error && jobs.length === 0"
      class="jobs__center"
    >
      <Empty
        icon="circle-alert"
        title="加载失败"
        :description="error"
      >
        <template #action>
          <view
            class="jobs__cta"
            hover-class="jobs__cta--pressed"
            @tap="refreshAndPoll"
          >
            <text class="jobs__cta-text">
              重新加载
            </text>
          </view>
        </template>
      </Empty>
    </view>

    <!-- 空态（给下一步动作，不做死胡同） -->
    <view
      v-else-if="jobs.length === 0"
      class="jobs__center"
    >
      <Empty
        icon="layers"
        title="暂无作业"
        description="提交一次生成后，进度会实时出现在这里"
      >
        <template #action>
          <view
            class="jobs__cta"
            hover-class="jobs__cta--pressed"
            @tap="goCreate"
          >
            <text class="jobs__cta-text">
              去创作
            </text>
          </view>
        </template>
      </Empty>
    </view>

    <!-- 作业卡片流（页面原生滚动，保下拉刷新） -->
    <view
      v-else
      class="jobs__list"
    >
      <JobCard
        v-for="job in jobs"
        :key="job.id"
        :job="job"
        :retrying="retryingId === job.id"
        :progress-pct="ssePct[job.prompt_id] ?? null"
        :quality-warning="sseWarned[job.prompt_id] === true"
        @click="handleTap"
        @remove="handleRemove"
        @retry="handleRetry"
      />
    </view>

    <TabBar :selected="1" />
  </view>
</template>

<style scoped lang="scss">
.jobs {
  min-height: 100vh;
  background: var(--color-bg);

  &__agent {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
    min-height: 64rpx;
    padding: 0 var(--space-3);
    border-radius: 999rpx;
    border: 1rpx solid var(--color-accent);
    background: var(--color-accent-soft);

    &--pressed {
      opacity: 0.85;
    }
  }

  &__agent-text {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
  }

  &__center {
    min-height: 70vh;
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
    padding: var(--space-4) var(--space-4) 0;
  }
}
</style>
