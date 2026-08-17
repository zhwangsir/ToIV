import { describe, expect, it } from 'vitest';

import {
  agentRunEventText,
  buildPlanOps,
  emptyPlanDraft,
  extractTaskMedia,
  hasActiveRuns,
  inRunFilter,
  mergePlanTasks,
  mergeTaskStatus,
  planDirty,
  primaryInputText,
  RUN_FILTERS,
  RUN_TERMINAL,
  runCancellable,
  runStatusMeta,
  taskDurationSec,
  taskKindIcon,
  taskKindLabel,
  taskStatusMeta,
  verdictText,
} from '@/utils/agent-run';
import type { AgentRunTask } from '@/types/api';

const makeTask = (id: string, status: string, overrides: Partial<AgentRunTask> = {}): AgentRunTask => ({
  id,
  kind: 'image',
  title: `t-${id}`,
  depends_on: [],
  status,
  attempt: 0,
  input: { prompt: 'hello' },
  output: {},
  verdict: {},
  gpu_hint: '',
  ...overrides,
});

describe('runStatusMeta', () => {
  it('已知状态映射', () => {
    expect(runStatusMeta('running')).toEqual({ label: '执行中', tone: 'accent' });
    expect(runStatusMeta('done')).toEqual({ label: '已完成', tone: 'success' });
    expect(runStatusMeta('error')).toEqual({ label: '出错', tone: 'danger' });
  });
  it('未知状态原样透传', () => {
    expect(runStatusMeta('magic')).toEqual({ label: 'magic', tone: 'neutral' });
  });
  it('空字符串兜底', () => {
    expect(runStatusMeta('')).toEqual({ label: '未知', tone: 'neutral' });
  });
});

describe('RUN_TERMINAL', () => {
  it('包含 done/error/canceled', () => {
    expect(RUN_TERMINAL.has('done')).toBe(true);
    expect(RUN_TERMINAL.has('error')).toBe(true);
    expect(RUN_TERMINAL.has('canceled')).toBe(true);
    expect(RUN_TERMINAL.has('running')).toBe(false);
  });
});

describe('hasActiveRuns', () => {
  it('有非终态返回 true', () => {
    expect(hasActiveRuns([{ status: 'done' }, { status: 'running' }])).toBe(true);
    expect(hasActiveRuns([{ status: 'planning' }])).toBe(true);
    expect(hasActiveRuns([{ status: 'awaiting_confirm' }])).toBe(true);
  });
  it('全终态/空列表返回 false', () => {
    expect(hasActiveRuns([{ status: 'done' }, { status: 'error' }, { status: 'canceled' }])).toBe(false);
    expect(hasActiveRuns([])).toBe(false);
  });
});

describe('inRunFilter', () => {
  it('active = planning/running', () => {
    expect(inRunFilter({ status: 'planning' }, 'active')).toBe(true);
    expect(inRunFilter({ status: 'running' }, 'active')).toBe(true);
    expect(inRunFilter({ status: 'done' }, 'active')).toBe(false);
  });
  it('gate = 两道确认门', () => {
    expect(inRunFilter({ status: 'awaiting_confirm' }, 'gate')).toBe(true);
    expect(inRunFilter({ status: 'awaiting_assembly' }, 'gate')).toBe(true);
    expect(inRunFilter({ status: 'running' }, 'gate')).toBe(false);
  });
  it('done/terminated', () => {
    expect(inRunFilter({ status: 'done' }, 'done')).toBe(true);
    expect(inRunFilter({ status: 'error' }, 'terminated')).toBe(true);
    expect(inRunFilter({ status: 'canceled' }, 'terminated')).toBe(true);
    expect(inRunFilter({ status: 'done' }, 'terminated')).toBe(false);
  });
  it('all 恒真', () => {
    expect(inRunFilter({ status: 'whatever' }, 'all')).toBe(true);
  });
});

describe('RUN_FILTERS', () => {
  it('五桶顺序固定且首桶 all', () => {
    expect(RUN_FILTERS.map((f) => f.key)).toEqual(['all', 'active', 'gate', 'done', 'terminated']);
    expect(RUN_FILTERS[0].label).toBe('全部');
  });
});

describe('runCancellable', () => {
  it('可取消状态返回 true', () => {
    expect(runCancellable('planning')).toBe(true);
    expect(runCancellable('awaiting_confirm')).toBe(true);
    expect(runCancellable('running')).toBe(true);
    expect(runCancellable('awaiting_assembly')).toBe(true);
  });
  it('终态返回 false', () => {
    expect(runCancellable('done')).toBe(false);
    expect(runCancellable('error')).toBe(false);
    expect(runCancellable('canceled')).toBe(false);
  });
});

describe('taskStatusMeta', () => {
  it('已知映射', () => {
    expect(taskStatusMeta('running').label).toBe('生成中');
    expect(taskStatusMeta('running').spin).toBe(true);
    expect(taskStatusMeta('done').label).toBe('完成');
  });
});

describe('taskKindLabel', () => {
  it('已知 kind 中文名', () => {
    expect(taskKindLabel('image')).toBe('图像');
    expect(taskKindLabel('video')).toBe('视频');
    expect(taskKindLabel('audio')).toBe('音频');
    expect(taskKindLabel('assemble')).toBe('合成');
  });
  it('未知 kind 原样透传', () => {
    expect(taskKindLabel('unknown')).toBe('unknown');
  });
});

describe('taskKindIcon', () => {
  it('已知 kind 返回白名单图标', () => {
    expect(taskKindIcon('image')).toBe('image');
    expect(taskKindIcon('video')).toBe('film');
    expect(taskKindIcon('assemble')).toBe('box');
  });
  it('未知 kind 兜底 layers', () => {
    expect(taskKindIcon('unknown')).toBe('layers');
  });
});

describe('extractTaskMedia', () => {
  it('video_url → video', () => {
    const m = extractTaskMedia({ video_url: '/v.mp4' });
    expect(m.kind).toBe('video');
    expect(m.src).toBe('/v.mp4');
  });
  it('image_url → image', () => {
    const m = extractTaskMedia({ image_url: '/i.png' });
    expect(m.kind).toBe('image');
    expect(m.src).toBe('/i.png');
  });
  it('audio_url → audio', () => {
    const m = extractTaskMedia({ audio_url: '/a.wav' });
    expect(m.kind).toBe('audio');
    expect(m.src).toBe('/a.wav');
  });
  it('url 扩展名粗判视频', () => {
    const m = extractTaskMedia({ url: 'http://x.com/v.mov' });
    expect(m.kind).toBe('video');
  });
  it('urls 数组取首项', () => {
    const m = extractTaskMedia({ urls: ['/x.mp4'] });
    expect(m.kind).toBe('video');
  });
  it('text → text', () => {
    const m = extractTaskMedia({ text: 'hello' });
    expect(m.kind).toBe('text');
    expect(m.text).toBe('hello');
  });
  it('空对象 → none', () => {
    expect(extractTaskMedia({}).kind).toBe('none');
  });
  it('null → none', () => {
    expect(extractTaskMedia(null).kind).toBe('none');
  });
});

describe('primaryInputText', () => {
  it('优先 known keys', () => {
    expect(primaryInputText({ prompt: 'p', description: 'd' })).toEqual({ key: 'prompt', value: 'p' });
    expect(primaryInputText({ text: 't' })).toEqual({ key: 'text', value: 't' });
  });
  it('无字符串兜底 prompt', () => {
    expect(primaryInputText({})).toEqual({ key: 'prompt', value: '' });
    expect(primaryInputText(null)).toEqual({ key: 'prompt', value: '' });
  });
});

describe('taskDurationSec', () => {
  it('合法 duration_sec', () => {
    expect(taskDurationSec({ input: { duration_sec: 5 } })).toBe(5);
  });
  it('非法值归 0', () => {
    expect(taskDurationSec({ input: { duration_sec: -1 } })).toBe(0);
    expect(taskDurationSec({ input: { duration_sec: NaN } })).toBe(0);
    expect(taskDurationSec({ input: {} })).toBe(0);
  });
});

describe('verdictText', () => {
  it('已知键取首个非空', () => {
    expect(verdictText({ comment: '光影不足', feedback: 'x' })).toBe('光影不足');
    expect(verdictText({ feedback: '重拍' })).toBe('重拍');
    expect(verdictText({ reason: 'r' })).toBe('r');
  });
  it('空对象/非字符串归空', () => {
    expect(verdictText({})).toBe('');
    expect(verdictText({ comment: 1 })).toBe('');
    expect(verdictText(null)).toBe('');
  });
});

describe('mergeTaskStatus', () => {
  it('命中 id 更新状态与 output', () => {
    const plan = [makeTask('a', 'pending')];
    const next = mergeTaskStatus(plan, { task_id: 'a', status: 'running', output: { url: '/x.png' } });
    expect(next[0].status).toBe('running');
    expect(next[0].output).toEqual({ url: '/x.png' });
  });
  it('无 task_id 原样返回（run 级 cancel 事件）', () => {
    const plan = [makeTask('a', 'pending')];
    expect(mergeTaskStatus(plan, { run_id: 'r1', status: 'canceled' })).toBe(plan);
  });
  it('未命中 id 不变', () => {
    const plan = [makeTask('a', 'pending')];
    const next = mergeTaskStatus(plan, { task_id: 'b', status: 'done' });
    expect(next[0].status).toBe('pending');
  });
});

describe('mergePlanTasks', () => {
  it('直接 {tasks:[...]} 合并保留已有 output', () => {
    const plan = [makeTask('a', 'pending', { output: { url: '/x.png' } })];
    const next = mergePlanTasks(plan, { tasks: [{ id: 'a', kind: 'video', title: 'new', depends_on: [], status: 'done' }] });
    expect(next).not.toBeNull();
    expect(next![0].status).toBe('done');
    expect(next![0].output).toEqual({ url: '/x.png' });
  });
  it('嵌套 {plan:{tasks:[...]}} 容错', () => {
    const plan = [makeTask('a', 'pending')];
    const next = mergePlanTasks(plan, { plan: { tasks: [{ id: 'a', kind: 'audio', title: 'a', depends_on: [], status: 'running' }] } });
    expect(next![0].kind).toBe('audio');
    expect(next![0].status).toBe('running');
  });
  it('新任务补空对象', () => {
    const plan = [makeTask('a', 'pending')];
    const next = mergePlanTasks(plan, { tasks: [
      { id: 'a', kind: 'image', title: 'a', depends_on: [], status: 'pending' },
      { id: 'b', kind: 'video', title: 'b', depends_on: [], status: 'pending' },
    ] });
    expect(next).toHaveLength(2);
    expect(next![1].input).toEqual({});
    expect(next![1].output).toEqual({});
  });
  it('畸形载荷返回 null', () => {
    expect(mergePlanTasks([], { foo: 'bar' })).toBeNull();
  });
});

describe('agentRunEventText', () => {
  it('ack → 文案', () => {
    const e = agentRunEventText({ type: 'ack', data: { message: '已拆成 4 步' } });
    expect(e?.text).toContain('已拆成 4 步');
    expect(e?.tone).toBe('accent');
  });
  it('task_status → 任务名+状态', () => {
    const e = agentRunEventText({ type: 'task_status', data: { task_id: 't1', title: '镜头 1', status: 'running' } });
    expect(e?.text).toContain('镜头 1');
    expect(e?.text).toContain('生成中');
    expect(e?.icon).toBe('loader-circle');
  });
  it('task_status done → check', () => {
    const e = agentRunEventText({ type: 'task_status', data: { task_id: 't1', title: 'a', status: 'done' } });
    expect(e?.tone).toBe('success');
    expect(e?.icon).toBe('check');
  });
  it('confirm_required assembly', () => {
    const e = agentRunEventText({ type: 'confirm_required', data: { gate: 'assembly', message: 'm' } });
    expect(e?.text).toContain('合成前确认门');
    expect(e?.tone).toBe('warning');
  });
  it('blocked → 文案', () => {
    const e = agentRunEventText({ type: 'blocked', data: { task_id: 't1', error: '队列已满' } });
    expect(e?.text).toContain('队列已满');
    expect(e?.tone).toBe('warning');
  });
  it('done → 成功', () => {
    const e = agentRunEventText({ type: 'done', data: { run_id: 'r1' } });
    expect(e?.text).toContain('全部任务完成');
    expect(e?.tone).toBe('success');
  });
  it('error → 文案', () => {
    const e = agentRunEventText({ type: 'error', data: { message: '出错了' } });
    expect(e?.text).toBe('出错了');
    expect(e?.tone).toBe('danger');
  });
  it('未知事件返回 null', () => {
    expect(agentRunEventText({ type: 'unknown', data: {} })).toBeNull();
  });
});

// ── MP23：计划门编辑 buildPlanOps / planDirty（对齐 Web PlanPanel buildOps 语义）──

describe('buildPlanOps', () => {
  const tasks = [
    { id: 't1', input: { prompt: '旧文案 1', duration_sec: 3 } },
    { id: 't2', input: { prompt: '旧文案 2' } },
    { id: 't3', input: { text: '旁白稿', voice: 'alloy' } },
  ];

  it('空草稿 → 空数组（未改动任务不产生 op）', () => {
    expect(buildPlanOps(tasks, emptyPlanDraft())).toEqual([]);
    const draft = emptyPlanDraft();
    draft.edits.t9 = { title: '不存在任务的留痕不影响' };
    // t9 不在 tasks 列表中 → 也不产生 op
    expect(buildPlanOps(tasks, draft)).toEqual([]);
  });

  it('update：标题与主文案留痕，input 合并保留未提交键', () => {
    const draft = emptyPlanDraft();
    draft.edits.t1 = { title: '新标题', inputText: '新文案', inputKey: 'prompt' };
    const ops = buildPlanOps(tasks, draft);
    expect(ops).toEqual([
      {
        id: 't1',
        action: 'update',
        title: '新标题',
        input: { prompt: '新文案', duration_sec: 3 },
      },
    ]);
  });

  it('update：inputKey 缺省回退 primaryInputText 主键（t3 的 text 键）', () => {
    const draft = emptyPlanDraft();
    draft.edits.t3 = { inputText: '改写旁白' };
    const ops = buildPlanOps(tasks, draft);
    expect(ops).toEqual([
      { id: 't3', action: 'update', input: { text: '改写旁白', voice: 'alloy' } },
    ]);
  });

  it('update：仅标题留痕不带 input，仅文案留痕不带 title', () => {
    const draft = emptyPlanDraft();
    draft.edits.t1 = { title: '只改标题' };
    draft.edits.t2 = { inputText: '只改文案', inputKey: 'prompt' };
    const ops = buildPlanOps(tasks, draft);
    expect(ops).toEqual([
      { id: 't1', action: 'update', title: '只改标题' },
      { id: 't2', action: 'update', input: { prompt: '只改文案' } },
    ]);
  });

  it('remove：removed 标记产出 remove op，且跳过同 id 的 edit 留痕', () => {
    const draft = emptyPlanDraft();
    draft.edits.t2 = { title: '改了但又删了' };
    draft.removed.push('t2');
    const ops = buildPlanOps(tasks, draft);
    expect(ops).toEqual([{ id: 't2', action: 'remove' }]);
  });

  it('add：临时行落 add op，空标题兜底「新任务」，input 固定 {prompt}', () => {
    const draft = emptyPlanDraft();
    draft.added.push({ id: 'new-1', title: '  ', inputText: '追加镜头' });
    draft.added.push({ id: 'new-2', title: '补充空镜', inputText: '' });
    const ops = buildPlanOps(tasks, draft);
    expect(ops).toEqual([
      { id: 'new-1', action: 'add', title: '新任务', input: { prompt: '追加镜头' } },
      { id: 'new-2', action: 'add', title: '补充空镜', input: { prompt: '' } },
    ]);
  });

  it('混合：remove + update 按 plan 数组序，add 追加末尾', () => {
    const draft = emptyPlanDraft();
    draft.removed.push('t2');
    draft.edits.t1 = { inputText: '改', inputKey: 'prompt' };
    draft.added.push({ id: 'new-1', title: '新增', inputText: 'x' });
    const ops = buildPlanOps(tasks, draft);
    expect(ops).toEqual([
      { id: 't1', action: 'update', input: { prompt: '改', duration_sec: 3 } },
      { id: 't2', action: 'remove' },
      { id: 'new-1', action: 'add', title: '新增', input: { prompt: 'x' } },
    ]);
  });
});

describe('planDirty', () => {
  it('空 ops → false（确认执行直接 approve 不调 /plan）', () => {
    expect(planDirty([])).toBe(false);
  });
  it('非空 ops → true', () => {
    expect(planDirty([{ id: 't1', action: 'remove' }])).toBe(true);
  });
});
