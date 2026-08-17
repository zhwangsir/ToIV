/**
 * Agent 团队展示元数据与纯函数（M21）
 * - 语义逐条对齐 Web apps/web/components/agent-run/agentRunMeta.ts（同一套文案/tone/防御提取规则）
 * - 状态徽章 tone 用 Web 五值词表（neutral/accent/ok/warn/err），组件侧映射 tokens 语义色
 * - toAgentRunEvent 为 SSE 帧的唯一入口：联合类型 + 类型守卫，坏帧/未知类型返回 null（跳过不中断流）
 */
import type {
  AgentPlanEditOp,
  AgentRunEvent,
  AgentRunTask,
  AgentRunTaskBrief,
} from '@/types/api';

export type StatusTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err';

export interface RunStatusMeta {
  label: string;
  tone: StatusTone;
}

/** run 状态 → 徽章（对齐 Web RUN_STATUS_META） */
export const RUN_STATUS_META: Record<string, RunStatusMeta> = {
  planning: { label: '规划中', tone: 'accent' },
  awaiting_confirm: { label: '待确认计划', tone: 'warn' },
  running: { label: '执行中', tone: 'accent' },
  awaiting_assembly: { label: '待确认合成', tone: 'warn' },
  done: { label: '已完成', tone: 'ok' },
  error: { label: '出错', tone: 'err' },
  canceled: { label: '已取消', tone: 'neutral' },
};

export function runStatusMeta(status: string): RunStatusMeta {
  return RUN_STATUS_META[status] ?? { label: status || '未知', tone: 'neutral' };
}

/** run 终态集合（终态断 SSE；对齐 Web RUN_TERMINAL） */
export const RUN_TERMINAL = new Set(['done', 'error', 'canceled']);

export interface TaskStatusMeta {
  label: string;
  tone: StatusTone;
  /** 进行态（徽章转圈） */
  spin?: boolean;
}

/** task 状态 → 徽章（对齐 Web TASK_STATUS_META 文案/tone/spin） */
export const TASK_STATUS_META: Record<string, TaskStatusMeta> = {
  pending: { label: '排队中', tone: 'neutral' },
  queued: { label: '已入队', tone: 'neutral' },
  running: { label: '生成中', tone: 'accent', spin: true },
  verifying: { label: '验收中', tone: 'warn' },
  rejected: { label: '被打回', tone: 'err' },
  approved: { label: '已通过', tone: 'ok' },
  done: { label: '完成', tone: 'ok' },
  error: { label: '失败', tone: 'err' },
};

export function taskStatusMeta(status: string): TaskStatusMeta {
  return TASK_STATUS_META[status] ?? { label: status || '未知', tone: 'neutral' };
}

/** kind → 中文名（对齐 Web TASK_KIND_LABEL；未知原样透传） */
export const TASK_KIND_LABEL: Record<string, string> = {
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

/** 任务产物（extractTaskMedia 输出；对齐 Web TaskMedia） */
export interface TaskMedia {
  kind: 'video' | 'image' | 'audio' | 'text' | 'none';
  src: string;
  text: string;
}

/**
 * 产物防御提取（逐条对齐 Web extractTaskMedia）：
 * video_url|video > image_url|image|thumbnail > audio_url|audio|voice_url
 * > url（扩展名 mp4/webm/mov→video、wav/mp3/flac/ogg/m4a→audio、否则 image）
 * > urls[0] 递归 > text|content|script
 */
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

/**
 * 任务主文案（input 按 prompt/text/script/description/content 顺序取首个字符串键；
 * 对齐 Web primaryInputText，缺省回落 { key: 'prompt', value: '' }）
 */
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

/** 任务时长（读 input.duration_sec，非法值归 0；对齐 Web taskDurationSec，合成门时间线用） */
export function taskDurationSec(task: Pick<AgentRunTask, 'input'>): number {
  const v = task.input?.duration_sec;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// ── M23 三期：计划编辑草稿 → POST /plan 操作序列（语义逐条对齐 Web PlanPanel buildOps）──

/**
 * 计划编辑本地痕迹（对齐 Web PlanDraft）：
 * edits 按任务 id 记 title/inputText/inputKey（仅显式编辑过的字段有值）；
 * removed 记待删任务 id；added 记新增临时行（id 前端预生成 `new-N`，落库时后端可替换）
 */
export interface PlanDraft {
  edits: Record<string, { title?: string; inputText?: string; inputKey?: string }>;
  removed: string[];
  added: { id: string; title: string; inputText: string }[];
}

/** 空草稿（无任何改动；buildPlanOps 返回空序列 → 确认门直投 approve 不走 POST /plan） */
export const EMPTY_PLAN_DRAFT: PlanDraft = { edits: {}, removed: [], added: [] };

/**
 * 汇总编辑痕迹为计划编辑操作序列（逐条对齐 Web PlanPanel.buildOps）：
 * - removed 中的任务优先生成 remove（该任务的 edits 一并忽略，服务端清理悬挂 depends_on）
 * - 有 edits 的任务生成 update：title 仅显式编辑时带上；inputText 编辑时按 inputKey
 *   （缺省取 primaryInputText 主文案键）合并进原 input，不动未提交字段
 * - added 逐行生成 add：title  trim 后空回落「新任务」，input 固定 { prompt: inputText }
 *   （kind/depends_on 由后端从 input 读，缺省 video/无依赖）
 * 返回空数组 = 空改动（调用方确认门直接 approve，不调 POST /plan）
 */
export function buildPlanOps(
  tasks: Pick<AgentRunTask, 'id' | 'input'>[],
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

// ── SSE 事件帧解析（联合类型 + 类型守卫；坏帧 null 跳过不中断流）──

const EVENT_TYPES = new Set(['ack', 'plan', 'task_status', 'blocked', 'confirm_required', 'error']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function toBrief(raw: unknown): AgentRunTaskBrief | null {
  if (!isRecord(raw) || !str(raw.id) || !str(raw.kind) || !str(raw.title) || !str(raw.status)) {
    return null;
  }
  return {
    id: raw.id,
    kind: raw.kind,
    title: raw.title,
    depends_on: Array.isArray(raw.depends_on) ? raw.depends_on.filter(str) : [],
    status: raw.status,
  };
}

/**
 * SSE 帧（event 名 + JSON.parse 后载荷）→ 联合类型事件
 * - 未知事件名 / 非对象载荷 / 缺必填字段 → null（调用方跳过，单帧坏数据不中断整条流）
 * - 必填字段对齐后端 _emit 点位：ack{message,level} / plan{tasks[]} /
 *   task_status{status 必填，task_id 缺省即 run 级} / blocked{task_id,title,error} /
 *   confirm_required{gate,message} / error{message}
 */
export function toAgentRunEvent(event: string, raw: unknown): AgentRunEvent | null {
  if (!EVENT_TYPES.has(event) || !isRecord(raw)) return null;
  switch (event) {
    case 'ack':
      if (!str(raw.message)) return null;
      return { type: 'ack', message: raw.message, level: str(raw.level) ? raw.level : '' };
    case 'plan': {
      if (!Array.isArray(raw.tasks)) return null;
      const tasks = raw.tasks.map(toBrief).filter((t): t is AgentRunTaskBrief => t !== null);
      return { type: 'plan', tasks };
    }
    case 'task_status': {
      if (!str(raw.status)) return null;
      return {
        type: 'task_status',
        status: raw.status,
        ...(str(raw.task_id) ? { task_id: raw.task_id } : {}),
        ...(str(raw.run_id) ? { run_id: raw.run_id } : {}),
        ...(str(raw.title) ? { title: raw.title } : {}),
        ...(isRecord(raw.output) ? { output: raw.output } : {}),
        ...(str(raw.gpu_hint) ? { gpu_hint: raw.gpu_hint } : {}),
        ...(typeof raw.attempt === 'number' ? { attempt: raw.attempt } : {}),
      };
    }
    case 'blocked':
      if (!str(raw.task_id) || !str(raw.title) || !str(raw.error)) return null;
      return { type: 'blocked', task_id: raw.task_id, title: raw.title, error: raw.error };
    case 'confirm_required':
      if (!str(raw.gate) || !str(raw.message)) return null;
      return { type: 'confirm_required', gate: raw.gate, message: raw.message };
    case 'error':
      if (!str(raw.message)) return null;
      return { type: 'error', message: raw.message };
    default:
      return null;
  }
}
