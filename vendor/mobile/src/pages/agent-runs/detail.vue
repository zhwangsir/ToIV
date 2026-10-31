<script setup lang="ts">
/**
 * Agent 运行详情页（MP21 一期：只读监控 + 取消；MP22 二期：确认门裁决 + 卡片干预）
 * - 首屏 GET 详情（plan 全任务卡片）；非终态订阅 SSE 事件流驱动增量合并
 *   （task_status/plan/done/error/confirm_required → utils/agent-run.ts 纯函数合并）
 * - SSE 断开/失败 → 降级 2s 轮询详情直至终态（对齐 jobs 页轮询心智；主动 abort 不降级）
 * - 事件动态流：agentRunEventText 逐事件上屏（倒序 ≤50 条）
 * - 取消：NavBar 右侧「取消」（runCancellable 白名单状态才可见），showModal 二次确认，
 *   成功后本地置 canceled 并断开实时通道（随后到达的 cancel SSE 帧幂等）
 * - 确认门：awaiting_confirm → 计划门横幅；awaiting_assembly → 合成门横幅；点开底部抽屉
 *   裁决 approve/reject（reject 可带方向性批注 feedback），成功后刷新详情续接 SSE
 * - 卡片干预：非进行中（running/queued）卡片出「改文案/重生成/通过」操作行；
 *   改文案/重生成走底部抽屉编辑，通过直接提交；成功后用返回的卡片局部替换
 * - 后置：plan 编辑（POST /plan）；MP33 四期卡片「替换上传」（本地文件直传 multipart，
 *   合成卡不出/音频卡仅微信端 chooseMessageFile）与「反推提示词」（图像/视频 done 卡，
 *   成功后开改文案抽屉审阅反推 prompt）
 */
import { computed, ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';

import {
  agentTaskAction,
  cancelAgentRun,
  getAgentRun,
  getAgentRunResult,
  resumeAgentRun,
  updateAgentRunPlan,
  uploadAgentTaskAsset,
  watchAgentRunEvents,
} from '@/api';
import { mediaUrl } from '@/api/client';
import Empty from '@/components/ui/empty.vue';
import Icon from '@/components/ui/icon.vue';
import NavBar from '@/components/ui/nav-bar.vue';
import Sheet from '@/components/ui/sheet.vue';
import Tag from '@/components/ui/tag.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import {
  cancelPoll,
  createPollHandle,
  pollUntil,
  type PollHandle,
} from '@/composables/use-poll';
import type {
  AgentPlanEditOp,
  AgentRunDetail,
  AgentRunResult,
  AgentRunSseEvent,
  AgentRunTask,
} from '@/types/api';
import {
  agentRunEventText,
  buildPlanOps,
  emptyPlanDraft,
  extractTaskMedia,
  mergePlanTasks,
  mergeTaskStatus,
  planDirty,
  primaryInputText,
  RUN_TERMINAL,
  runCancellable,
  runStatusMeta,
  taskDurationSec,
  taskKindIcon,
  taskKindLabel,
  taskStatusMeta,
  verdictText,
  type AgentRunFeedItem,
  type PlanDraft,
  type StatusTone,
  type TaskMedia,
} from '@/utils/agent-run';
import { formatRelative } from '@/utils/format';
import { isMpWeixin } from '@/utils/platform';

const { palette, themeVars } = useAppTheme();
const { requireAuth } = useAuthGuard();

const runId = ref('');
const detail = ref<AgentRunDetail | null>(null);
const loading = ref(true);
const error = ref('');
const feed = ref<AgentRunFeedItem[]>([]);
const live = ref(false);
const polling = ref(false);
const cancelling = ref(false);

let eventsHandle: { abort: () => void } | undefined;
let pollHandle: PollHandle | undefined;
/** 代际令牌：stopLive 后使在途 promise 回调失效（防旧通道回调污染新状态） */
let generation = 0;

const terminal = computed(() => (detail.value ? RUN_TERMINAL.has(detail.value.status) : false));
const cancellable = computed(() =>
  detail.value ? runCancellable(detail.value.status) && !cancelling.value : false,
);
const doneCount = computed(
  () =>
    detail.value?.plan.filter((t) => t.status === 'done' || t.status === 'approved').length ?? 0,
);

function mediaOf(task: AgentRunTask): TaskMedia {
  return extractTaskMedia(task.output);
}

function inputOf(task: AgentRunTask): string {
  return primaryInputText(task.input).value;
}

function verdictOf(task: AgentRunTask): string {
  return verdictText(task.verdict);
}

function resolveUrl(path: string): string {
  return mediaUrl(path);
}

function previewTaskImage(src: string) {
  uni.previewImage({ urls: [resolveUrl(src)] });
}

/** 动态流图标语义色（tone → 主题变量） */
function feedColor(tone: StatusTone): string {
  switch (tone) {
    case 'accent':
      return 'var(--color-accent)';
    case 'success':
      return 'var(--color-success)';
    case 'warning':
      return 'var(--color-warning)';
    case 'danger':
      return 'var(--color-danger)';
    default:
      return 'var(--color-text-secondary)';
  }
}

function stopLive() {
  generation += 1;
  eventsHandle?.abort();
  eventsHandle = undefined;
  cancelPoll(pollHandle);
  pollHandle = undefined;
  live.value = false;
  polling.value = false;
}

/** SSE 业务事件 → 详情状态合并 + 动态流上屏；终态即断开 */
function onSseEvent(ev: AgentRunSseEvent) {
  const item = agentRunEventText(ev);
  if (item) feed.value = [item, ...feed.value].slice(0, 50);
  const d = detail.value;
  if (!d) return;
  if (ev.type === 'task_status') {
    const tid = typeof ev.data.task_id === 'string' ? ev.data.task_id : '';
    if (tid) {
      detail.value = { ...d, plan: mergeTaskStatus(d.plan, ev.data) };
    } else if (typeof ev.data.status === 'string' && ev.data.status) {
      // 无 task_id（cancel 等 run 级事件）→ 改 run 状态
      detail.value = { ...d, status: ev.data.status };
    }
  } else if (ev.type === 'plan') {
    const merged = mergePlanTasks(d.plan, ev.data);
    if (merged) detail.value = { ...d, plan: merged };
  } else if (ev.type === 'done') {
    detail.value = { ...d, status: 'done' };
    void loadRunResult();
  } else if (ev.type === 'error') {
    detail.value = {
      ...d,
      status: 'error',
      error: typeof ev.data.message === 'string' ? ev.data.message : d.error,
    };
  } else if (ev.type === 'confirm_required') {
    const gate = typeof ev.data.gate === 'string' ? ev.data.gate : '';
    detail.value = {
      ...d,
      status: gate === 'assembly' ? 'awaiting_assembly' : 'awaiting_confirm',
    };
  }
  if (terminal.value) stopLive();
}

/** SSE 断线降级：2s 轮询详情直至终态 */
function startPollingFallback() {
  if (!runId.value || terminal.value || polling.value) return;
  polling.value = true;
  const gen = generation;
  const handle = createPollHandle();
  pollHandle = handle;
  void pollUntil<AgentRunDetail>({
    fetcher: () => getAgentRun(runId.value),
    shouldStop: (d) => RUN_TERMINAL.has(d.status),
    intervals: [2000],
    onUpdate: (d) => {
      if (handle.cancelled || gen !== generation) return;
      if (d) {
        detail.value = d;
        error.value = '';
      }
    },
    handle,
  }).catch(() => undefined);
}

function startLive() {
  if (!runId.value || terminal.value || eventsHandle) return;
  const gen = generation;
  live.value = true;
  const handle = watchAgentRunEvents(runId.value, 0, onSseEvent);
  eventsHandle = handle;
  handle.promise
    .catch((err: unknown) => {
      if (gen !== generation) return;
      const msg = err instanceof Error ? err.message : '';
      if (msg === '已停止监听') return; // 主动断开（stopLive/终态）
      if (!terminal.value) {
        uni.showToast({ title: '实时连接断开，转为定时刷新', icon: 'none' });
        startPollingFallback();
      }
    })
    .finally(() => {
      if (gen === generation) {
        live.value = false;
        eventsHandle = undefined;
      }
    });
}

async function loadDetail() {
  try {
    const d = await getAgentRun(runId.value);
    detail.value = d;
    error.value = '';
    if (RUN_TERMINAL.has(d.status)) stopLive();
    else startLive();
    if (d.status === 'done') void loadRunResult();
    else runResult.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

// ── MP23 三期：done 成片结果（GET /result；409 非 done 静默忽略） ──

const runResult = ref<AgentRunResult | null>(null);
const resultSaving = ref(false);

async function loadRunResult() {
  try {
    runResult.value = await getAgentRunResult(runId.value);
  } catch {
    // 409（run 尚未 done）/网络抖动：成片卡不渲染，静默
    runResult.value = null;
  }
}

/** 保存成片到相册（复用 artifact.vue 下载链路：downloadFile → saveVideoToPhotosAlbum） */
function saveResultVideo() {
  const url = runResult.value?.final_url;
  if (!url || resultSaving.value) return;
  resultSaving.value = true;
  uni.showLoading({ title: '下载中…', mask: true });
  uni.downloadFile({
    url: resolveUrl(url),
    success: (dl) => {
      if (dl.statusCode !== 200) {
        uni.hideLoading();
        uni.showToast({ title: '下载失败，请重试', icon: 'none' });
        return;
      }
      uni.saveVideoToPhotosAlbum({
        filePath: dl.tempFilePath,
        success: () => {
          uni.hideLoading();
          uni.showToast({ title: '已保存到相册', icon: 'none' });
        },
        fail: () => {
          uni.hideLoading();
          uni.showToast({ title: '保存失败，请检查相册权限', icon: 'none' });
        },
      });
    },
    fail: () => {
      uni.hideLoading();
      uni.showToast({ title: '下载失败，请检查网络', icon: 'none' });
    },
    complete: () => {
      resultSaving.value = false;
    },
  });
}

onLoad((query) => {
  runId.value = typeof query?.id === 'string' ? query.id : '';
  if (!requireAuth()) return;
  if (!runId.value) {
    error.value = '缺少运行 ID';
    loading.value = false;
    return;
  }
  void loadDetail();
});

onUnload(() => stopLive());

/** 取消：showModal 二次确认 → POST cancel → 本地置 canceled 并断开（409 人话透传） */
function handleCancel() {
  const d = detail.value;
  if (!d || !runCancellable(d.status) || cancelling.value) return;
  uni.showModal({
    title: '取消运行',
    content: '取消后未执行的任务将不再调度，进行中的任务会自然结束。',
    confirmText: '确定取消',
    cancelText: '再想想',
    confirmColor: palette.value.danger,
    success: (res) => {
      if (!res.confirm) return;
      void doCancel();
    },
  });
}

async function doCancel() {
  cancelling.value = true;
  try {
    const res = await cancelAgentRun(runId.value);
    if (detail.value) {
      detail.value = { ...detail.value, status: res.status || 'canceled' };
    }
    uni.showToast({ title: '已取消', icon: 'none' });
    stopLive();
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '取消失败',
      icon: 'none',
    });
  } finally {
    cancelling.value = false;
  }
}

// ── MP22 二期：确认门裁决（plan/assembly × approve/reject）；MP23 三期：计划门可编辑 ──

/** 当前待裁决确认门（'' = 无；门状态由 SSE confirm_required/详情刷新驱动） */
const gateKind = computed<'plan' | 'assembly' | ''>(() => {
  const s = detail.value?.status;
  if (s === 'awaiting_confirm') return 'plan';
  if (s === 'awaiting_assembly') return 'assembly';
  return '';
});
const gateSheetVisible = ref(false);
const gateRejecting = ref(false);
const gateFeedback = ref('');
const gateBusy = ref('');
/** 裁决/计划编辑失败：错误内联抽屉不关闭（对齐 Web PlanPanel 错误条语义） */
const gateError = ref('');

/** 合成门时间线合计时长（input.duration_sec 求和，非法值归 0） */
const gateTotalSec = computed(() =>
  (detail.value?.plan ?? []).reduce((sum, t) => sum + taskDurationSec(t), 0),
);

function openGateSheet() {
  if (!gateKind.value || gateBusy.value) return;
  gateRejecting.value = false;
  gateFeedback.value = '';
  gateError.value = '';
  // 计划门：每次打开重置编辑草稿（对齐 Web PlanPanel 挂载即新 draft）
  if (gateKind.value === 'plan') resetPlanDraft();
  gateSheetVisible.value = true;
}

/**
 * 裁决提交：
 * - 计划门 approve（确认执行）：buildPlanOps 汇总编辑痕迹，ops 非空先 POST /plan 再
 *   resume('plan','modify')，无改动直接 resume('plan','approve')
 * - reject：原样带 feedback（计划门/合成门共用）
 * 成功后以响应 status 就地更新并整刷详情续接 SSE；失败错误内联抽屉不关闭
 */
async function submitGate(action: 'approve' | 'reject') {
  const gate = gateKind.value;
  if (!gate || gateBusy.value) return;
  gateBusy.value = `${gate}:${action}`;
  gateError.value = '';
  try {
    let effectiveAction: 'approve' | 'modify' | 'reject' = action;
    if (gate === 'plan' && action === 'approve') {
      const ops = buildPlanOps(detail.value?.plan ?? [], planDraft.value);
      if (planDirty(ops)) {
        const planRes = await updateAgentRunPlan(runId.value, ops);
        // 编辑落库后本地合并一次任务简报，抽屉关门前列表已是新计划
        const merged = mergePlanTasks(detail.value?.plan ?? [], planRes.plan);
        if (detail.value && merged) detail.value = { ...detail.value, plan: merged };
        effectiveAction = 'modify';
      }
    }
    const res = await resumeAgentRun(runId.value, {
      gate,
      action: effectiveAction,
      ...(action === 'reject' && gateFeedback.value.trim()
        ? { feedback: gateFeedback.value.trim() }
        : {}),
    });
    gateSheetVisible.value = false;
    if (detail.value) {
      detail.value = {
        ...detail.value,
        status: res.status || detail.value.status,
        // 计划门 reject：后端把 feedback 记入 run.error 供重规划参考
        ...(action === 'reject' && gate === 'plan'
          ? { error: gateFeedback.value.trim() || '计划被拒绝' }
          : {}),
      };
    }
    uni.showToast({ title: action === 'approve' ? '已通过' : '已打回', icon: 'none' });
    await loadDetail();
  } catch (err) {
    gateError.value = err instanceof Error ? err.message : '提交裁决失败';
  } finally {
    gateBusy.value = '';
  }
}

// ── MP23 三期：计划门可编辑面板（对齐 Web PlanPanel：改标题/文案、删任务、加任务） ──

/** 本地编辑痕迹（edits 只留痕用户真正输入过的键；removed 本地标记；added 临时行 new-N） */
const planDraft = ref<PlanDraft>(emptyPlanDraft());
/** 新增任务临时 id 自增（落库时后端可替换） */
let planAddSeq = 1;

function resetPlanDraft() {
  planDraft.value = emptyPlanDraft();
  planAddSeq = 1;
}

/** 未被本地标记移除的既有任务（编辑面板可见行） */
const planVisibleTasks = computed(() =>
  (detail.value?.plan ?? []).filter((t) => !planDraft.value.removed.includes(t.id)),
);

/** 当前编辑痕迹汇总的 ops 预览（驱动 data-plan-dirty 走查钩子与确认路径分流） */
const planOpsPreview = computed<AgentPlanEditOp[]>(() =>
  buildPlanOps(detail.value?.plan ?? [], planDraft.value),
);
const planHasEdits = computed(() => planDirty(planOpsPreview.value));

/** 任务在原计划中的 1 基序号（depends_on 显示「依赖 第 N 步」用） */
function planOrderOf(id: string): number {
  return (detail.value?.plan ?? []).findIndex((t) => t.id === id) + 1;
}

function planDepsText(task: AgentRunTask): string {
  return task.depends_on
    .map((d) => {
      const n = planOrderOf(d);
      return n > 0 ? `第 ${n} 步` : d;
    })
    .join('、');
}

/** 行显示值：留痕优先，缺省回落任务原值（对齐 Web PlanPanel editOf） */
function planTitleOf(task: AgentRunTask): string {
  return planDraft.value.edits[task.id]?.title ?? task.title;
}

function planInputOf(task: AgentRunTask): string {
  const e = planDraft.value.edits[task.id];
  return e?.inputText ?? primaryInputText(task.input).value;
}

function patchPlanEdit(id: string, patch: Partial<PlanDraft['edits'][string]>) {
  planDraft.value = {
    ...planDraft.value,
    edits: { ...planDraft.value.edits, [id]: { ...planDraft.value.edits[id], ...patch } },
  };
}

/* uni input/textarea 事件载荷为 e.detail.value（对齐 assistant.vue onInput） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onPlanTitle(task: AgentRunTask, e: any) {
  patchPlanEdit(task.id, { title: e?.detail?.value ?? '' });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onPlanInputText(task: AgentRunTask, e: any) {
  // inputKey 一经确定随留痕保持（主文案键由 primaryInputText 首次判定）
  const key = planDraft.value.edits[task.id]?.inputKey ?? primaryInputText(task.input).key;
  patchPlanEdit(task.id, { inputText: e?.detail?.value ?? '', inputKey: key });
}

function removePlanTask(id: string) {
  if (gateBusy.value) return;
  if (planDraft.value.removed.includes(id)) return;
  planDraft.value = { ...planDraft.value, removed: [...planDraft.value.removed, id] };
}

function addPlanTask() {
  if (gateBusy.value) return;
  planDraft.value = {
    ...planDraft.value,
    added: [...planDraft.value.added, { id: `new-${planAddSeq}`, title: '', inputText: '' }],
  };
  planAddSeq += 1;
}

function patchAddedTask(id: string, patch: Partial<{ title: string; inputText: string }>) {
  planDraft.value = {
    ...planDraft.value,
    added: planDraft.value.added.map((a) => (a.id === id ? { ...a, ...patch } : a)),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onAddedTitle(id: string, e: any) {
  patchAddedTask(id, { title: e?.detail?.value ?? '' });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onAddedInputText(id: string, e: any) {
  patchAddedTask(id, { inputText: e?.detail?.value ?? '' });
}

function dropAddedTask(id: string) {
  if (gateBusy.value) return;
  planDraft.value = {
    ...planDraft.value,
    added: planDraft.value.added.filter((a) => a.id !== id),
  };
}

// ── MP22 二期：卡片级干预（edit 改文案 / regenerate 引导词重生 / approve 通过） ──

/** 进行中卡片不可干预（对齐 Web inflight = running/queued） */
function taskInflight(task: AgentRunTask): boolean {
  return task.status === 'running' || task.status === 'queued';
}

/** 卡片操作行可见性：run 取消/终态后不再干预；assemble 卡走合成确认门不出操作行 */
function taskActionable(task: AgentRunTask): boolean {
  const s = detail.value?.status ?? '';
  if (s === 'canceled' || s === 'done' || s === 'error') return false;
  return task.kind !== 'assemble';
}

/** 重生成入口：后端仅 done/error 可重生（其余 409），assemble 卡 400 走合成门 */
function taskRegenerable(task: AgentRunTask): boolean {
  return task.status === 'done' || task.status === 'error';
}

const taskBusy = ref('');
const editTask = ref<AgentRunTask | null>(null);
const editDraft = ref('');
const regenTask = ref<AgentRunTask | null>(null);
const regenGuidance = ref('');

function openTaskEdit(task: AgentRunTask) {
  if (taskInflight(task) || taskBusy.value) return;
  editDraft.value = primaryInputText(task.input).value;
  editTask.value = task;
}

function openTaskRegen(task: AgentRunTask) {
  if (taskInflight(task) || taskBusy.value) return;
  regenGuidance.value = '';
  regenTask.value = task;
}

/** 成功后用返回的卡片（attempt 已 +1）局部替换，不重拉详情 */
function applyTaskUpdate(updated: AgentRunTask) {
  const d = detail.value;
  if (!d) return;
  detail.value = { ...d, plan: d.plan.map((t) => (t.id === updated.id ? updated : t)) };
}

async function submitTaskEdit() {
  const task = editTask.value;
  if (!task || taskBusy.value) return;
  taskBusy.value = `${task.id}:edit`;
  try {
    // 前端契约 payload={input:{...}}：全量 input 覆写主文案 key（后端再做一次 merge 容错）
    const primary = primaryInputText(task.input);
    const updated = await agentTaskAction(runId.value, task.id, {
      action: 'edit',
      payload: { input: { ...task.input, [primary.key]: editDraft.value } },
    });
    applyTaskUpdate(updated);
    editTask.value = null;
    uni.showToast({ title: '已保存，待重跑', icon: 'none' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '保存失败',
      icon: 'none',
    });
  } finally {
    taskBusy.value = '';
  }
}

async function submitTaskRegen() {
  const task = regenTask.value;
  if (!task || taskBusy.value) return;
  taskBusy.value = `${task.id}:regenerate`;
  try {
    const guidance = regenGuidance.value.trim();
    const updated = await agentTaskAction(runId.value, task.id, {
      action: 'regenerate',
      payload: guidance ? { guidance } : {},
    });
    applyTaskUpdate(updated);
    regenTask.value = null;
    uni.showToast({ title: '已提交重生成', icon: 'none' });
    // 单卡重跑会把 awaiting_assembly 的 run 顶回 running：整刷一次接上 SSE 状态
    await loadDetail();
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '重生成失败',
      icon: 'none',
    });
  } finally {
    taskBusy.value = '';
  }
}

async function submitTaskApprove(task: AgentRunTask) {
  if (taskInflight(task) || taskBusy.value) return;
  taskBusy.value = `${task.id}:approve`;
  try {
    const updated = await agentTaskAction(runId.value, task.id, { action: 'approve' });
    applyTaskUpdate(updated);
    uni.showToast({ title: '已通过', icon: 'none' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '操作失败',
      icon: 'none',
    });
  } finally {
    taskBusy.value = '';
  }
}

// ── MP33 四期：替换上传（本地文件直传）/ 反推提示词（写回 input 后开抽屉审阅） ──

/** 反推提示词入口：仅图像/视频卡且有产出（done；error/未产出后端 409 兜底但不出入口） */
function taskRepromptable(task: AgentRunTask): boolean {
  return (task.kind === 'image' || task.kind === 'video') && task.status === 'done';
}

/** 替换上传入口：合成卡不出（走合成确认门）；音频卡仅微信端（chooseMessageFile 系独占） */
function taskUploadable(task: AgentRunTask): boolean {
  if (task.kind === 'assemble') return false;
  if (task.kind === 'audio' && !isMpWeixin()) return false;
  return true;
}

async function submitTaskReprompt(task: AgentRunTask) {
  if (taskInflight(task) || taskBusy.value) return;
  taskBusy.value = `${task.id}:reprompt`;
  try {
    const updated = await agentTaskAction(runId.value, task.id, { action: 'reprompt' });
    applyTaskUpdate(updated);
    // 反推 prompt 直接进改文案抽屉供审阅微调（用返回的最新卡片，不用旧闭包 task）
    editDraft.value = primaryInputText(updated.input).value;
    editTask.value = updated;
    uni.showToast({ title: '已反推，请审阅', icon: 'none' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '反推失败',
      icon: 'none',
    });
  } finally {
    taskBusy.value = '';
  }
}

/** 替换上传选媒体：image 相册/拍照；video 直选；audio 微信会话文件（对齐 ref-audio-field） */
function openTaskUpload(task: AgentRunTask) {
  if (taskInflight(task) || taskBusy.value) return;
  if (task.kind === 'video') {
    uni.chooseVideo({
      sourceType: ['album', 'camera'],
      success: (res) => {
        if (res.tempFilePath) void submitTaskUpload(task, res.tempFilePath);
      },
      fail: () => {
        // 用户取消不提示
      },
    });
    return;
  }
  if (task.kind === 'audio') {
    if (!isMpWeixin()) return; // 非微信端无音频系统选择器（入口已隐藏，双保险）
    uni.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['wav', 'mp3', 'm4a', 'ogg', 'flac'],
      success: (res) => {
        const f = res.tempFiles[0];
        if (f?.path) void submitTaskUpload(task, f.path);
      },
      fail: () => {
        // 用户取消不提示
      },
    });
    return;
  }
  uni.chooseImage({
    count: 1,
    sizeType: ['original', 'compressed'],
    sourceType: ['album', 'camera'],
    success: (res) => {
      const fp = res.tempFilePaths[0];
      if (fp) void submitTaskUpload(task, fp);
    },
    fail: () => {
      // 用户取消不提示
    },
  });
}

async function submitTaskUpload(task: AgentRunTask, filePath: string) {
  if (taskBusy.value) return;
  taskBusy.value = `${task.id}:upload`;
  try {
    const updated = await uploadAgentTaskAsset(runId.value, task.id, filePath);
    applyTaskUpdate(updated);
    uni.showToast({ title: '已替换产物', icon: 'none' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '上传失败',
      icon: 'none',
    });
  } finally {
    taskBusy.value = '';
  }
}
</script>

<template>
  <view
    class="detail"
    :style="themeVars"
  >
    <NavBar
      title="运行详情"
      show-back
    >
      <template #right>
        <view
          v-if="cancellable"
          class="detail__cancel"
          hover-class="detail__cancel--pressed"
          data-action="cancel-run"
          @tap="handleCancel"
        >
          <text class="detail__cancel-text">
            取消
          </text>
        </view>
      </template>
    </NavBar>

    <!-- 首次加载 -->
    <view
      v-if="loading && !detail"
      class="detail__center"
    >
      <text class="detail__hint">
        加载中…
      </text>
    </view>

    <!-- 加载失败 -->
    <view
      v-else-if="error && !detail"
      class="detail__center"
    >
      <Empty
        icon="circle-alert"
        title="加载失败"
        :description="error"
      >
        <template #action>
          <view
            class="detail__cta"
            hover-class="detail__cta--pressed"
            @tap="loadDetail"
          >
            <text class="detail__cta-text">
              重新加载
            </text>
          </view>
        </template>
      </Empty>
    </view>

    <template v-else-if="detail">
      <!-- 头部：状态 + goal + 时间 + 错误横幅 -->
      <view class="detail__head">
        <view class="detail__head-row">
          <view :data-run-status="detail.status">
            <Tag
              :tone="runStatusMeta(detail.status).tone"
              :label="runStatusMeta(detail.status).label"
            />
          </view>
          <text class="detail__level">
            {{ detail.level }}
          </text>
          <text
            v-if="live"
            class="detail__live"
          >
            实时
          </text>
          <text
            v-else-if="polling"
            class="detail__live detail__live--polling"
          >
            定时刷新
          </text>
        </view>
        <text class="detail__goal">
          {{ detail.goal || '未命名任务' }}
        </text>
        <text class="detail__time">
          创建于 {{ formatRelative(detail.created_at) }} · 更新于 {{ formatRelative(detail.updated_at) }}
        </text>
        <view
          v-if="detail.error"
          class="detail__error"
        >
          <Icon
            name="circle-alert"
            :size="28"
            color="var(--color-danger)"
          />
          <text class="detail__error-text">
            {{ detail.error }}
          </text>
        </view>
      </view>

      <!-- 确认门横幅（计划门/合成门共用入口，点开底部抽屉裁决） -->
      <view
        v-if="gateKind"
        class="detail__gate"
        :data-gate="gateKind"
      >
        <Icon
          :name="gateKind === 'plan' ? 'layers' : 'film'"
          :size="32"
          color="var(--color-accent)"
        />
        <view class="detail__gate-textbox">
          <text class="detail__gate-title">
            {{ gateKind === 'plan' ? '计划待确认' : '合成前确认' }}
          </text>
          <text class="detail__gate-desc">
            {{ gateKind === 'plan' ? '检查下方任务计划，确认后开始执行' : '全部任务已就绪，确认合成成片' }}
          </text>
        </view>
        <view
          class="detail__gate-cta"
          hover-class="detail__gate-cta--pressed"
          data-action="open-gate"
          @tap="openGateSheet"
        >
          <text class="detail__gate-cta-text">
            去裁决
          </text>
        </view>
      </view>

      <!-- 成片结果卡（MP23：done 且 GET /result 返回 final_url 才渲染；409 静默不渲染） -->
      <view
        v-if="detail.status === 'done' && runResult && runResult.final_url"
        class="detail__section"
      >
        <text class="detail__section-title">
          成片
        </text>
        <view class="detail__result">
          <video
            class="detail__result-video"
            :src="resolveUrl(runResult.final_url)"
            controls
            data-result="final"
          />
          <view class="detail__result-meta">
            <text class="detail__result-text">
              合计时长 ≈ {{ runResult.duration_sec > 0 ? `${runResult.duration_sec}s` : '未知' }} · 产物 {{ runResult.tasks.length }} 项
            </text>
            <view
              class="detail__result-save"
              :class="{ 'detail__result-save--disabled': resultSaving }"
              hover-class="detail__result-save--pressed"
              data-action="result-save"
              @tap="saveResultVideo"
            >
              <Icon
                name="download"
                :size="24"
                color="var(--color-accent)"
              />
              <text class="detail__result-save-text">
                保存
              </text>
            </view>
          </view>
        </view>
      </view>

      <!-- 事件动态流 -->
      <view class="detail__section">
        <text class="detail__section-title">
          动态
        </text>
        <view
          v-if="feed.length === 0"
          class="detail__feed-empty"
        >
          <text class="detail__feed-empty-text">
            {{ terminal ? '本次运行没有更多事件' : '等待事件…' }}
          </text>
        </view>
        <view
          v-else
          class="detail__feed"
          :data-feed-count="feed.length"
        >
          <view
            v-for="(item, i) in feed"
            :key="i"
            class="detail__feed-item"
          >
            <Icon
              :name="item.icon"
              :size="28"
              :color="feedColor(item.tone)"
            />
            <text class="detail__feed-text">
              {{ item.text }}
            </text>
          </view>
        </view>
      </view>

      <!-- 任务卡片流 -->
      <view class="detail__section">
        <text class="detail__section-title">
          任务 {{ doneCount }}/{{ detail.plan.length }}
        </text>
        <view
          v-if="detail.plan.length === 0"
          class="detail__feed-empty"
        >
          <text class="detail__feed-empty-text">
            计划生成中…
          </text>
        </view>
        <view
          v-else
          class="detail__tasks"
        >
          <view
            v-for="task in detail.plan"
            :key="task.id"
            class="detail__task"
            :data-task-id="task.id"
          >
            <view class="detail__task-head">
              <Icon
                :name="taskKindIcon(task.kind)"
                :size="32"
                color="var(--color-text-secondary)"
              />
              <view class="detail__task-titlebox">
                <text class="detail__task-title">
                  {{ task.title || task.id }}
                </text>
                <text class="detail__task-kind">
                  {{ taskKindLabel(task.kind) }}
                  <text v-if="task.attempt > 1">
                    · 第 {{ task.attempt }} 次尝试
                  </text>
                </text>
              </view>
              <Tag
                :tone="taskStatusMeta(task.status).tone"
                :label="taskStatusMeta(task.status).label"
              />
            </view>
            <text
              v-if="inputOf(task)"
              class="detail__task-input"
            >
              {{ inputOf(task) }}
            </text>

            <!-- 产物：视频内联 / 图像点按预览 / 音频占位 / 文本截断 -->
            <template v-if="mediaOf(task).kind !== 'none'">
              <video
                v-if="mediaOf(task).kind === 'video'"
                class="detail__task-video"
                :src="resolveUrl(mediaOf(task).src)"
                controls
              />
              <image
                v-else-if="mediaOf(task).kind === 'image'"
                class="detail__task-image"
                :src="resolveUrl(mediaOf(task).src)"
                mode="widthFix"
                lazy-load
                @tap="previewTaskImage(mediaOf(task).src)"
              />
              <view
                v-else-if="mediaOf(task).kind === 'audio'"
                class="detail__task-audio"
              >
                <Icon
                  name="music"
                  :size="28"
                  color="var(--color-text-secondary)"
                />
                <text class="detail__task-audio-text">
                  音频产物（主站可播放）
                </text>
              </view>
              <text
                v-else-if="mediaOf(task).kind === 'text'"
                class="detail__task-output"
              >
                {{ mediaOf(task).text }}
              </text>
            </template>

            <view
              v-if="verdictOf(task)"
              class="detail__task-verdict"
            >
              <text class="detail__task-verdict-text">
                验收：{{ verdictOf(task) }}
              </text>
            </view>

            <!-- 卡片干预：改文案 / 重生成 / 通过（进行中禁用，assemble 卡不出） -->
            <view
              v-if="taskActionable(task)"
              class="detail__task-actions"
            >
              <view
                class="detail__task-action"
                :class="{ 'detail__task-action--disabled': taskInflight(task) || !!taskBusy }"
                hover-class="detail__task-action--pressed"
                :data-action="`task-edit:${task.id}`"
                @tap="openTaskEdit(task)"
              >
                <Icon
                  name="pencil"
                  :size="24"
                  color="var(--color-text-secondary)"
                />
                <text class="detail__task-action-text">
                  改文案
                </text>
              </view>
              <view
                v-if="taskRegenerable(task)"
                class="detail__task-action"
                :class="{ 'detail__task-action--disabled': taskInflight(task) || !!taskBusy }"
                hover-class="detail__task-action--pressed"
                :data-action="`task-regen:${task.id}`"
                @tap="openTaskRegen(task)"
              >
                <Icon
                  name="refresh-cw"
                  :size="24"
                  color="var(--color-text-secondary)"
                />
                <text class="detail__task-action-text">
                  重生成
                </text>
              </view>
              <view
                v-if="task.status !== 'approved'"
                class="detail__task-action"
                :class="{ 'detail__task-action--disabled': taskInflight(task) || !!taskBusy }"
                hover-class="detail__task-action--pressed"
                :data-action="`task-approve:${task.id}`"
                @tap="submitTaskApprove(task)"
              >
                <Icon
                  name="check"
                  :size="24"
                  color="var(--color-success)"
                />
                <text class="detail__task-action-text detail__task-action-text--approve">
                  通过
                </text>
              </view>
              <!-- MP33 四期：替换上传（合成卡不出；音频卡仅微信端）/ 反推提示词（图像/视频 done 卡） -->
              <view
                v-if="taskUploadable(task)"
                class="detail__task-action"
                :class="{ 'detail__task-action--disabled': taskInflight(task) || !!taskBusy }"
                hover-class="detail__task-action--pressed"
                :data-action="`task-upload:${task.id}`"
                @tap="openTaskUpload(task)"
              >
                <Icon
                  name="upload"
                  :size="24"
                  color="var(--color-text-secondary)"
                />
                <text class="detail__task-action-text">
                  替换
                </text>
              </view>
              <view
                v-if="taskRepromptable(task)"
                class="detail__task-action"
                :class="{ 'detail__task-action--disabled': taskInflight(task) || !!taskBusy }"
                hover-class="detail__task-action--pressed"
                :data-action="`task-reprompt:${task.id}`"
                @tap="submitTaskReprompt(task)"
              >
                <Icon
                  name="wand-sparkles"
                  :size="24"
                  color="var(--color-text-secondary)"
                />
                <text class="detail__task-action-text">
                  反推
                </text>
              </view>
            </view>
          </view>
        </view>
      </view>
    </template>

    <!-- 确认门裁决抽屉（计划门=可编辑面板 MP23 / 合成门=只读时间线 MP22；reject 展开批注输入） -->
    <Sheet
      :visible="gateSheetVisible && !!gateKind"
      :title="gateKind === 'plan' ? '计划确认' : '合成前确认'"
      data-sheet="gate"
      @close="gateSheetVisible = false"
    >
      <view
        v-if="detail"
        class="gate"
      >
        <!-- 计划门：可编辑面板（改标题/文案、删任务、加任务；确认执行汇总 ops） -->
        <template v-if="gateKind === 'plan'">
          <text class="gate__desc">
            可改标题/文案、删任务、加任务；确认后按计划执行，关键节点会再找你
          </text>
          <view class="gate__timeline">
            <view
              v-for="task in planVisibleTasks"
              :key="task.id"
              class="gate__item gate__item--edit"
              :data-plan-task="task.id"
            >
              <view class="gate__edit-head">
                <text class="gate__idx">
                  {{ planOrderOf(task.id) }}
                </text>
                <text class="gate__kind">
                  {{ taskKindLabel(task.kind) }}
                </text>
                <input
                  class="gate__title-input"
                  :value="planTitleOf(task)"
                  placeholder="任务标题"
                  :maxlength="200"
                  :data-field="`plan-title:${task.id}`"
                  @input="onPlanTitle(task, $event)"
                >
                <view
                  class="gate__del"
                  hover-class="gate__del--pressed"
                  :data-action="`plan-remove:${task.id}`"
                  @tap="removePlanTask(task.id)"
                >
                  <Icon
                    name="trash-2"
                    :size="28"
                    color="var(--color-danger)"
                  />
                </view>
              </view>
              <text
                v-if="task.depends_on.length > 0"
                class="gate__deps"
              >
                依赖 {{ planDepsText(task) }}
              </text>
              <textarea
                class="gate__feedback gate__input"
                :value="planInputOf(task)"
                placeholder="该任务的提示词/文案"
                :maxlength="4000"
                :data-field="`plan-input:${task.id}`"
                @input="onPlanInputText(task, $event)"
              />
            </view>
            <view
              v-for="a in planDraft.added"
              :key="a.id"
              class="gate__item gate__item--edit gate__item--new"
              :data-plan-task="a.id"
            >
              <view class="gate__edit-head">
                <text class="gate__idx gate__idx--new">
                  +
                </text>
                <text class="gate__kind">
                  新任务
                </text>
                <input
                  class="gate__title-input"
                  :value="a.title"
                  placeholder="任务标题"
                  :maxlength="200"
                  :data-field="`plan-title:${a.id}`"
                  @input="onAddedTitle(a.id, $event)"
                >
                <view
                  class="gate__del"
                  hover-class="gate__del--pressed"
                  :data-action="`plan-remove:${a.id}`"
                  @tap="dropAddedTask(a.id)"
                >
                  <Icon
                    name="trash-2"
                    :size="28"
                    color="var(--color-danger)"
                  />
                </view>
              </view>
              <textarea
                class="gate__feedback gate__input"
                :value="a.inputText"
                placeholder="该任务的提示词/文案"
                :maxlength="4000"
                :data-field="`plan-input:${a.id}`"
                @input="onAddedInputText(a.id, $event)"
              />
            </view>
          </view>
          <view
            class="gate__add"
            hover-class="gate__add--pressed"
            data-action="plan-add"
            @tap="addPlanTask"
          >
            <Icon
              name="plus"
              :size="28"
              color="var(--color-accent)"
            />
            <text class="gate__add-text">
              加任务
            </text>
          </view>
        </template>

        <!-- 合成门：只读时间线（MP22 行为不变） -->
        <template v-else>
          <text class="gate__desc">
            全部任务已就绪，合成前请过一遍时间线：
          </text>
          <view class="gate__timeline">
            <view
              v-for="(task, i) in detail.plan"
              :key="task.id"
              class="gate__item"
            >
              <text class="gate__idx">
                {{ i + 1 }}
              </text>
              <text class="gate__title">
                {{ task.title || `任务 ${i + 1}` }}
              </text>
              <Tag
                :tone="taskStatusMeta(task.status).tone"
                :label="taskStatusMeta(task.status).label"
              />
              <text class="gate__dur">
                {{ taskDurationSec(task) > 0 ? `${taskDurationSec(task)}s` : '—' }}
              </text>
            </view>
          </view>
          <text class="gate__total">
            合计时长 ≈ {{ gateTotalSec > 0 ? `${gateTotalSec}s` : '未知' }}
          </text>
        </template>

        <textarea
          v-if="gateRejecting"
          v-model="gateFeedback"
          class="gate__feedback"
          data-field="gate-feedback"
          :maxlength="4000"
          placeholder="打回原因（方向性批注，可选），例如「第 3 镜节奏太慢」"
        />
        <text
          v-if="gateError"
          class="gate__error"
          data-plan-error
        >
          {{ gateError }}
        </text>
      </view>
      <template #footer>
        <view
          v-if="!gateRejecting"
          class="gate__actions"
        >
          <view
            class="gate__btn gate__btn--ghost"
            hover-class="gate__btn--pressed"
            data-action="gate-reject-toggle"
            @tap="gateRejecting = true"
          >
            <text class="gate__btn-text gate__btn-text--danger">
              {{ gateKind === 'plan' ? '打回重规划' : '返回修改' }}
            </text>
          </view>
          <view
            class="gate__btn gate__btn--primary"
            :class="{ 'gate__btn--disabled': !!gateBusy }"
            hover-class="gate__btn--pressed"
            :data-action="gateKind === 'plan' ? 'plan-confirm' : 'gate-approve'"
            :data-plan-dirty="gateKind === 'plan' ? (planHasEdits ? '1' : '0') : undefined"
            @tap="submitGate('approve')"
          >
            <text class="gate__btn-text gate__btn-text--primary">
              {{ gateKind === 'plan' ? '确认执行' : '确认合成' }}
            </text>
          </view>
        </view>
        <view
          v-else
          class="gate__actions"
        >
          <view
            class="gate__btn gate__btn--ghost"
            hover-class="gate__btn--pressed"
            data-action="gate-reject-back"
            @tap="gateRejecting = false"
          >
            <text class="gate__btn-text">
              返回
            </text>
          </view>
          <view
            class="gate__btn gate__btn--danger"
            :class="{ 'gate__btn--disabled': !!gateBusy }"
            hover-class="gate__btn--pressed"
            data-action="gate-reject-confirm"
            @tap="submitGate('reject')"
          >
            <text class="gate__btn-text gate__btn-text--primary">
              确认打回
            </text>
          </view>
        </view>
      </template>
    </Sheet>

    <!-- 改文案抽屉（主文案 key 由 primaryInputText 判定：prompt/text/script/description/content） -->
    <Sheet
      :visible="!!editTask"
      title="改文案"
      data-sheet="task-edit"
      @close="editTask = null"
    >
      <view
        v-if="editTask"
        class="gate"
      >
        <text class="gate__desc">
          {{ editTask.title || '修改该任务的提示词/文案' }}
        </text>
        <textarea
          v-model="editDraft"
          class="gate__feedback"
          data-field="edit-draft"
          :maxlength="4000"
          placeholder="修改该任务的提示词/文案"
        />
      </view>
      <template #footer>
        <view class="gate__actions">
          <view
            class="gate__btn gate__btn--ghost"
            hover-class="gate__btn--pressed"
            data-action="edit-cancel"
            @tap="editTask = null"
          >
            <text class="gate__btn-text">
              取消
            </text>
          </view>
          <view
            class="gate__btn gate__btn--primary"
            :class="{ 'gate__btn--disabled': !!taskBusy }"
            hover-class="gate__btn--pressed"
            data-action="edit-save"
            @tap="submitTaskEdit"
          >
            <text class="gate__btn-text gate__btn-text--primary">
              保存
            </text>
          </view>
        </view>
      </template>
    </Sheet>

    <!-- 重生成抽屉（引导词可选，拼进主文案尾部） -->
    <Sheet
      :visible="!!regenTask"
      title="重生成"
      data-sheet="task-regen"
      @close="regenTask = null"
    >
      <view
        v-if="regenTask"
        class="gate"
      >
        <text class="gate__desc">
          {{ regenTask.title || '带引导词重生成' }}
        </text>
        <textarea
          v-model="regenGuidance"
          class="gate__feedback"
          data-field="regen-guidance"
          :maxlength="4000"
          placeholder="引导词（可选）：告诉 AI 这次往哪个方向改，例如「角色发色保持一致」"
        />
      </view>
      <template #footer>
        <view class="gate__actions">
          <view
            class="gate__btn gate__btn--ghost"
            hover-class="gate__btn--pressed"
            data-action="regen-cancel"
            @tap="regenTask = null"
          >
            <text class="gate__btn-text">
              取消
            </text>
          </view>
          <view
            class="gate__btn gate__btn--primary"
            :class="{ 'gate__btn--disabled': !!taskBusy }"
            hover-class="gate__btn--pressed"
            data-action="regen-submit"
            @tap="submitTaskRegen"
          >
            <text class="gate__btn-text gate__btn-text--primary">
              带引导词重生成
            </text>
          </view>
        </view>
      </template>
    </Sheet>
  </view>
</template>

<style scoped lang="scss">
.detail {
  min-height: 100vh;
  background: var(--color-bg);
  padding-bottom: var(--space-8);

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

  &__cancel {
    min-height: 64rpx;
    display: flex;
    align-items: center;
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-danger);

    &--pressed {
      opacity: 0.85;
    }
  }

  &__cancel-text {
    font-size: var(--font-caption);
    color: var(--color-danger);
    font-weight: 500;
  }

  &__head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    margin: 0 var(--space-4);
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  &__head-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__level {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
  }

  &__live {
    margin-left: auto;
    font-size: var(--font-caption);
    color: var(--color-success);

    &--polling {
      color: var(--color-warning);
    }
  }

  &__goal {
    font-size: var(--font-heading);
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.4;
  }

  &__time {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__error {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);
  }

  &__error-text {
    flex: 1;
    font-size: var(--font-caption);
    color: var(--color-danger);
    line-height: 1.5;
  }

  &__section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-4) 0;
  }

  &__section-title {
    font-size: var(--font-body);
    font-weight: 600;
    color: var(--color-text);
  }

  &__feed-empty {
    padding: var(--space-4);
    align-items: center;
  }

  &__feed-empty-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__feed {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  &__feed-item {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }

  &__feed-text {
    flex: 1;
    font-size: var(--font-caption);
    color: var(--color-text);
    line-height: 1.5;
  }

  &__tasks {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  &__task {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  &__task-head {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__task-titlebox {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2rpx;
  }

  &__task-title {
    font-size: var(--font-body);
    font-weight: 500;
    color: var(--color-text);
  }

  &__task-kind {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__task-input {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  &__task-video {
    width: 100%;
    border-radius: var(--radius-md);
  }

  &__task-image {
    width: 100%;
    border-radius: var(--radius-md);
  }

  &__task-audio {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);
  }

  &__task-audio-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__task-output {
    font-size: var(--font-caption);
    color: var(--color-text);
    line-height: 1.6;
    padding: var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  &__task-verdict {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);
  }

  &__task-verdict-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    line-height: 1.5;
  }

  &__gate {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-3) var(--space-4) 0;
    padding: var(--space-3) var(--space-4);
    background: var(--color-accent-soft);
    border: 1rpx solid var(--color-accent);
    border-radius: var(--radius-lg);
  }

  &__gate-textbox {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2rpx;
  }

  &__gate-title {
    font-size: var(--font-body);
    font-weight: 600;
    color: var(--color-text);
  }

  &__gate-desc {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__gate-cta {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-accent);

    &--pressed {
      opacity: 0.88;
    }
  }

  &__gate-cta-text {
    font-size: var(--font-caption);
    color: #ffffff;
    font-weight: 500;
  }

  &__task-actions {
    display: flex;
    flex-direction: row;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1rpx solid var(--color-border);
  }

  &__task-action {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);

    &--pressed {
      opacity: 0.85;
    }

    &--disabled {
      opacity: 0.4;
    }
  }

  &__task-action-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);

    &--approve {
      color: var(--color-success);
    }
  }

  &__result {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  &__result-video {
    width: 100%;
    border-radius: var(--radius-md);
  }

  &__result-meta {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
  }

  &__result-text {
    flex: 1;
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__result-save {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-accent);

    &--pressed {
      opacity: 0.85;
    }

    &--disabled {
      opacity: 0.4;
    }
  }

  &__result-save-text {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
  }
}

.gate {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-2) 0;

  &__desc {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    line-height: 1.5;
  }

  &__timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  &__item {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);

    /* 计划门编辑行：纵向卡片（标题行 + 依赖 + 文案域） */
    &--edit {
      flex-direction: column;
      align-items: stretch;
      gap: var(--space-2);
      padding: var(--space-3);
      border: 1rpx solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-bg);
    }

    &--new {
      border-style: dashed;
      border-color: var(--color-accent);
    }
  }

  &__edit-head {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__kind {
    flex-shrink: 0;
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__title-input {
    flex: 1;
    min-width: 0;
    height: 64rpx;
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
    border: 1rpx solid var(--color-border);
    background: var(--color-surface);
    font-size: var(--font-caption);
    color: var(--color-text);
  }

  &__del {
    flex-shrink: 0;
    min-width: 64rpx;
    min-height: 64rpx;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);

    &--pressed {
      opacity: 0.7;
    }
  }

  &__deps {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__input {
    min-height: 120rpx;
  }

  &__idx--new {
    background: var(--color-accent);
    color: #ffffff;
  }

  &__add {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    padding: var(--space-3) 0;
    border-radius: var(--radius-md);
    border: 1rpx dashed var(--color-accent);

    &--pressed {
      opacity: 0.85;
    }
  }

  &__add-text {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
  }

  &__error {
    font-size: var(--font-caption);
    color: var(--color-danger);
    line-height: 1.5;
  }

  &__idx {
    width: 40rpx;
    height: 40rpx;
    border-radius: 50%;
    background: var(--color-accent-soft);
    color: var(--color-accent);
    font-size: var(--font-caption);
    text-align: center;
    line-height: 40rpx;
  }

  &__title {
    flex: 1;
    font-size: var(--font-caption);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__dur {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__total {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__feedback {
    width: 100%;
    min-height: 160rpx;
    padding: var(--space-3);
    box-sizing: border-box;
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);
    background: var(--color-bg);
    font-size: var(--font-caption);
    color: var(--color-text);
  }

  &__actions {
    display: flex;
    flex-direction: row;
    gap: var(--space-3);
  }

  &__btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-3) 0;
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);

    &--primary {
      background: var(--color-accent);
      border-color: var(--color-accent);
    }

    &--danger {
      background: var(--color-danger);
      border-color: var(--color-danger);
    }

    &--ghost {
      background: transparent;
    }

    &--pressed {
      opacity: 0.88;
    }

    &--disabled {
      opacity: 0.4;
    }
  }

  &__btn-text {
    font-size: var(--font-body);
    color: var(--color-text);
    font-weight: 500;

    &--primary {
      color: #ffffff;
    }

    &--danger {
      color: var(--color-danger);
    }
  }
}
</style>
