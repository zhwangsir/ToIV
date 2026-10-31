/**
 * Agent 团队展示语义与纯函数工具（MP21）
 * 逐条对齐 Web apps/web/components/agent-run/agentRunMeta.ts / useAgentRun.ts，
 * tone 映射到本端 ui/tag.vue 五态（neutral/accent/success/warning/danger）
 * 纯函数无运行时依赖，node 环境可直接单测
 */
import type {
  AgentPlanEditOp,
  AgentRunSseEvent,
  AgentRunSummary,
  AgentRunTask,
} from '@/types/api';

/** ui/tag.vue 语义色 */
export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface RunStatusMeta {
  label: string;
  tone: StatusTone;
}

/** run 状态 → 徽章（对齐 Web RUN_STATUS_META；未知状态原样透传前向兼容） */
const RUN_STATUS_META: Record<string, RunStatusMeta> = {
  planning: { label: '规划中', tone: 'accent' },
  awaiting_confirm: { label: '待确认计划', tone: 'warning' },
  running: { label: '执行中', tone: 'accent' },
  awaiting_assembly: { label: '待确认合成', tone: 'warning' },
  done: { label: '已完成', tone: 'success' },
  error: { label: '出错', tone: 'danger' },
  canceled: { label: '已取消', tone: 'neutral' },
};

export function runStatusMeta(status: string): RunStatusMeta {
  return RUN_STATUS_META[status] ?? { label: status || '未知', tone: 'neutral' };
}

/** run 终态集合（终态后不再订阅 SSE / 轮询；对齐后端 _TERMINAL） */
export const RUN_TERMINAL = new Set(['done', 'error', 'canceled']);

/** 有非终态 run（列表页 2s 轮询的继续条件；对齐 jobs 页 hasActiveJobs 语义） */
export function hasActiveRuns(runs: ReadonlyArray<Pick<AgentRunSummary, 'status'>>): boolean {
  return runs.some((r) => !RUN_TERMINAL.has(r.status));
}

/**
 * 列表页过滤桶（后端 status 仅单值精确匹配、不支持逗号多值 → 语义桶客户端分桶）
 */
export type RunFilterKey = 'all' | 'active' | 'gate' | 'done' | 'terminated';

export const RUN_FILTERS: Array<{ key: RunFilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'gate', label: '待确认' },
  { key: 'done', label: '已完成' },
  { key: 'terminated', label: '已终止' },
];

/** 单 run 是否命中过滤桶（active=规划/执行中；gate=两道确认门；terminated=出错/已取消） */
export function inRunFilter(run: Pick<AgentRunSummary, 'status'>, f: RunFilterKey): boolean {
  switch (f) {
    case 'active':
      return run.status === 'planning' || run.status === 'running';
    case 'gate':
      return run.status === 'awaiting_confirm' || run.status === 'awaiting_assembly';
    case 'done':
      return run.status === 'done';
    case 'terminated':
      return run.status === 'error' || run.status === 'canceled';
    default:
      return true;
  }
}

/**
 * run 可取消状态集（agent_team.py cancel_run 409 白名单：
 * planning/awaiting_confirm/running/awaiting_assembly 之外一律 409）
 */
export function runCancellable(status: string): boolean {
  return (
    status === 'planning' ||
    status === 'awaiting_confirm' ||
    status === 'running' ||
    status === 'awaiting_assembly'
  );
}

export interface TaskStatusMeta {
  label: string;
  tone: StatusTone;
  /** 进行态（图标旋转） */
  spin?: boolean;
}

/** 任务状态 → 徽章（对齐 Web TASK_STATUS_META 文案） */
const TASK_STATUS_META: Record<string, TaskStatusMeta> = {
  pending: { label: '排队中', tone: 'neutral' },
  queued: { label: '已入队', tone: 'neutral' },
  running: { label: '生成中', tone: 'accent', spin: true },
  verifying: { label: '验收中', tone: 'warning' },
  rejected: { label: '被打回', tone: 'danger' },
  approved: { label: '已通过', tone: 'success' },
  done: { label: '完成', tone: 'success' },
  error: { label: '失败', tone: 'danger' },
};

export function taskStatusMeta(status: string): TaskStatusMeta {
  return TASK_STATUS_META[status] ?? { label: status || '未知', tone: 'neutral' };
}

/** kind → 中文名（对齐 Web TASK_KIND_LABEL；未知 kind 原样透传） */
const TASK_KIND_LABEL: Record<string, string> = {
  script: '剧本',
  storyboard: '分镜',
  image: '图像',
  video: '视频',
  audio: '音频',
  subtitle: '字幕',
  verify: '验收',
  assemble: '合成',
};

export function taskKindLabel(kind: string): string {
  return TASK_KIND_LABEL[kind] ?? kind;
}

/** kind → Lucide 白名单图标（均在 scripts/gen-icons.mjs 已登记集合内） */
const TASK_KIND_ICON: Record<string, string> = {
  script: 'file-text',
  storyboard: 'layout-grid',
  image: 'image',
  video: 'film',
  audio: 'music',
  subtitle: 'file-text',
  verify: 'eye',
  assemble: 'box',
};

export function taskKindIcon(kind: string): string {
  return TASK_KIND_ICON[kind] ?? 'layers';
}

/** 产物提取：对 output 字段布局防御（url/video_url/image_url/audio_url/urls[]/text），对齐 Web extractTaskMedia */
export interface TaskMedia {
  kind: 'video' | 'image' | 'audio' | 'text' | 'none';
  src: string;
  text: string;
}

export function extractTaskMedia(output: Record<string, unknown> | null | undefined): TaskMedia {
  if (!output || typeof output !== 'object') return { kind: 'none', src: '', text: '' };
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = output[k];
      if (typeof v === 'string' && v) return v;
    }
    return '';
  };
  const video = pick('video_url', 'video');
  if (video) return { kind: 'video', src: video, text: '' };
  const image = pick('image_url', 'image', 'thumbnail');
  if (image) return { kind: 'image', src: image, text: '' };
  const audio = pick('audio_url', 'audio', 'voice_url');
  if (audio) return { kind: 'audio', src: audio, text: '' };
  const url = pick('url');
  if (url) {
    // 按扩展名粗判媒体类型
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return { kind: 'video', src: url, text: '' };
    if (/\.(wav|mp3|flac|ogg|m4a)(\?|$)/i.test(url)) return { kind: 'audio', src: url, text: '' };
    return { kind: 'image', src: url, text: '' };
  }
  const urls = output.urls;
  if (Array.isArray(urls) && urls.length > 0 && typeof urls[0] === 'string') {
    return extractTaskMedia({ url: urls[0] });
  }
  const text = pick('text', 'content', 'script');
  if (text) return { kind: 'text', src: '', text };
  return { kind: 'none', src: '', text: '' };
}

/** 任务主文案（input 已知键优先，否则 prompt；对齐 Web primaryInputText） */
export function primaryInputText(input: Record<string, unknown> | null | undefined): {
  key: string;
  value: string;
} {
  if (input && typeof input === 'object') {
    for (const k of ['prompt', 'text', 'script', 'description', 'content']) {
      const v = input[k];
      if (typeof v === 'string') return { key: k, value: v };
    }
  }
  return { key: 'prompt', value: '' };
}

/** 任务时长（读 input.duration_sec，非法值归 0；对齐 Web taskDurationSec） */
export function taskDurationSec(task: Pick<AgentRunTask, 'input'>): number {
  const v = task.input?.duration_sec;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// ── MP23 三期：计划门编辑（对齐 Web PlanPanel.tsx 本地 draft + buildOps 语义）──

/**
 * 计划门本地编辑痕迹（对齐 Web PlanPanel PlanDraft）
 * edits 按 id 记 title/inputText/inputKey（只在用户真正输入过的键上留痕 → 未留痕键不产生 op）；
 * removed 记 id（服务端自动清理其他任务 depends_on 悬挂引用）；
 * added 记临时行（id 前端预生成 new-N 自增，保持 DAG 引用稳定，落库时后端可替换）
 */
export interface PlanDraft {
  edits: Record<string, { title?: string; inputText?: string; inputKey?: string }>;
  removed: string[];
  added: Array<{ id: string; title: string; inputText: string }>;
}

/** 空草稿（页面每次打开计划门抽屉时重置） */
export function emptyPlanDraft(): PlanDraft {
  return { edits: {}, removed: [], added: [] };
}

/**
 * 汇总编辑痕迹为 POST /plan 操作序列（对齐 Web PlanPanel buildOps 语义）
 * - removed → {id, action:'remove'}
 * - edits → {id, action:'update', title?, input?}；input 为 {...t.input, [inputKey]: inputText}
 *   全量合并改键值（未提交字段保留，后端再做一次按键合并兜底）
 * - added → {id, action:'add', title: title||'新任务', input:{prompt: inputText}}
 * - 顺序：先按 plan 数组序遍历 remove/update，再追加 add（与 Web 一致）
 * - 无改动返回空数组（调用方据此走 resume approve 而非 modify，不调 /plan）
 */
export function buildPlanOps(
  tasks: ReadonlyArray<Pick<AgentRunTask, 'id' | 'input'>>,
  draft: PlanDraft,
): AgentPlanEditOp[] {
  const ops: AgentPlanEditOp[] = [];
  for (const t of tasks) {
    if (draft.removed.includes(t.id)) {
      ops.push({ id: t.id, action: 'remove' });
      continue;
    }
    const e = draft.edits[t.id];
    if (!e) continue;
    const op: AgentPlanEditOp = { id: t.id, action: 'update' };
    if (e.title !== undefined) op.title = e.title;
    if (e.inputText !== undefined) {
      op.input = { ...t.input, [e.inputKey ?? primaryInputText(t.input).key]: e.inputText };
    }
    ops.push(op);
  }
  for (const a of draft.added) {
    ops.push({
      id: a.id,
      action: 'add',
      title: a.title.trim() || '新任务',
      input: { prompt: a.inputText },
    });
  }
  return ops;
}

/** 计划门是否有未提交改动（空 ops → 确认执行直接 approve 不调 /plan） */
export function planDirty(ops: ReadonlyArray<AgentPlanEditOp>): boolean {
  return ops.length > 0;
}

/** 验收意见文案（verdict 已知键取首个非空字符串；空对象归 ''） */
export function verdictText(verdict: Record<string, unknown> | null | undefined): string {
  if (!verdict || typeof verdict !== 'object') return '';
  for (const k of ['comment', 'feedback', 'reason', 'verdict']) {
    const v = verdict[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/** data 里取字符串字段（防御） */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * task_status 事件 → 合并进任务列表（仅更新载荷里出现的字段，对齐 Web mergeTaskStatus）
 * cancel 事件的载荷是 {run_id, status:'canceled'}（无 task_id）→ 原样返回，由调用方改 run 状态
 */
export function mergeTaskStatus(
  plan: AgentRunTask[],
  data: Record<string, unknown>,
): AgentRunTask[] {
  const tid = str(data.task_id) || str(data.id);
  if (!tid) return plan;
  return plan.map((t) => {
    if (t.id !== tid) return t;
    const next: AgentRunTask = { ...t };
    if (typeof data.status === 'string' && data.status) next.status = data.status;
    if (typeof data.attempt === 'number') next.attempt = data.attempt;
    if (typeof data.title === 'string' && data.title) next.title = data.title;
    if (data.output && typeof data.output === 'object') {
      next.output = data.output as Record<string, unknown>;
    }
    if (typeof data.gpu_hint === 'string') next.gpu_hint = data.gpu_hint;
    return next;
  });
}

/**
 * plan 事件 → 合并任务简报（载荷为 _task_brief：无 input/output）
 * 对齐 Web extractPlanTasks 双包法容错（{tasks:[...]} / {plan:{tasks:[...]}}），
 * 合并策略：按 id 更新 kind/title/depends_on/status，保留已有 input/output/verdict；
 * 新任务补空对象；已从计划移除的任务剔除
 */
export function mergePlanTasks(
  plan: AgentRunTask[],
  data: Record<string, unknown>,
): AgentRunTask[] | null {
  const direct = data.tasks;
  let briefs: unknown[] | null = Array.isArray(direct) ? direct : null;
  if (!briefs) {
    const nested = data.plan;
    if (nested && typeof nested === 'object') {
      const t = (nested as { tasks?: unknown }).tasks;
      if (Array.isArray(t)) briefs = t;
    }
  }
  if (!briefs) return null;
  const byId = new Map(plan.map((t) => [t.id, t]));
  const merged: AgentRunTask[] = [];
  for (const raw of briefs) {
    if (!raw || typeof raw !== 'object') continue;
    const brief = raw as Record<string, unknown>;
    const id = str(brief.id);
    if (!id) continue;
    const prev = byId.get(id);
    merged.push({
      id,
      kind: str(brief.kind) || prev?.kind || '',
      title: str(brief.title) || prev?.title || '',
      depends_on: Array.isArray(brief.depends_on)
        ? brief.depends_on.filter((d): d is string => typeof d === 'string')
        : (prev?.depends_on ?? []),
      status: str(brief.status) || prev?.status || 'pending',
      attempt: prev?.attempt ?? 0,
      input: prev?.input ?? {},
      output: prev?.output ?? {},
      verdict: prev?.verdict ?? {},
      gpu_hint: prev?.gpu_hint ?? '',
    });
  }
  return merged;
}

/** 事件流条目（详情页动态流：图标 + 文案 + 语义色） */
export interface AgentRunFeedItem {
  text: string;
  tone: StatusTone;
  icon: string;
}

/**
 * SSE 业务事件 → 动态流条目（对齐 Web useAgentRun onEvent 文案语义；未知类型返回 null 不上屏）
 * task_status 有 title 用「title」前缀；cancel 载荷无 task_id → 运行级文案
 */
export function agentRunEventText(ev: AgentRunSseEvent): AgentRunFeedItem | null {
  const { type, data } = ev;
  switch (type) {
    case 'ack':
      return { text: str(data.message) || str(data.ack) || '已接单，Leader 拆解中', tone: 'accent', icon: 'zap' };
    case 'plan': {
      const tasks = mergePlanTasks([], data);
      return {
        text: `计划已生成，共 ${tasks ? tasks.length : '?'} 步`,
        tone: 'neutral',
        icon: 'layout-grid',
      };
    }
    case 'task_status': {
      const tid = str(data.task_id) || str(data.id);
      const status = str(data.status);
      const meta = taskStatusMeta(status);
      // cancel 事件无 task_id：run 级终态
      if (!tid) {
        return { text: meta.label === status ? `运行状态：${status}` : `运行${meta.label}`, tone: 'neutral', icon: 'info' };
      }
      const title = str(data.title);
      const tone: StatusTone =
        status === 'done' || status === 'approved'
          ? 'success'
          : status === 'error' || status === 'rejected'
            ? 'danger'
            : status === 'running'
              ? 'accent'
              : 'neutral';
      const icon =
        status === 'done' || status === 'approved'
          ? 'check'
          : status === 'error' || status === 'rejected'
            ? 'circle-alert'
            : status === 'running'
              ? 'loader-circle'
              : 'clock';
      return { text: `「${title || tid}」${meta.label}`, tone, icon };
    }
    case 'verdict':
      return { text: `验收意见：${str(data.verdict) || '已出具'}`, tone: 'neutral', icon: 'eye' };
    case 'confirm_required': {
      const gate = str(data.gate);
      return gate === 'assembly'
        ? { text: '合成前确认门已打开，请到主站裁决', tone: 'warning', icon: 'circle-alert' }
        : { text: '计划确认门已打开，请到主站确认', tone: 'warning', icon: 'circle-alert' };
    }
    case 'blocked':
      return {
        text: `遇到阻塞：${str(data.error) || str(data.message) || '等待资源'}`,
        tone: 'warning',
        icon: 'circle-alert',
      };
    case 'decision_required':
      return {
        text: `需要决策：${str(data.message) || '请查看任务卡片'}`,
        tone: 'warning',
        icon: 'circle-alert',
      };
    case 'done':
      return { text: '全部任务完成，成片已就绪', tone: 'success', icon: 'check' };
    case 'error':
      return { text: str(data.message) || '运行出错', tone: 'danger', icon: 'circle-alert' };
    default:
      return null;
  }
}
