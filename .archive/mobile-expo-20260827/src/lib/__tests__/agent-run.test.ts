/**
 * agent-run.ts 纯函数测试（M21.1）
 * 语义逐条对齐 Web apps/web/components/agent-run/agentRunMeta.ts：
 * run/task 状态徽章文案+tone、kind 中文名、产物防御提取优先级与边界、主文案键序、SSE 事件守卫
 */
import {
  EMPTY_PLAN_DRAFT,
  RUN_STATUS_META,
  RUN_TERMINAL,
  TASK_KIND_LABEL,
  TASK_STATUS_META,
  buildPlanOps,
  extractTaskMedia,
  primaryInputText,
  runStatusMeta,
  taskKindLabel,
  taskStatusMeta,
  toAgentRunEvent,
} from '../agent-run';

describe('runStatusMeta（run 状态徽章）', () => {
  it.each([
    ['planning', '规划中', 'accent'],
    ['awaiting_confirm', '待确认计划', 'warn'],
    ['running', '执行中', 'accent'],
    ['awaiting_assembly', '待确认合成', 'warn'],
    ['done', '已完成', 'ok'],
    ['error', '出错', 'err'],
    ['canceled', '已取消', 'neutral'],
  ])('%s → %s / %s', (status, label, tone) => {
    expect(runStatusMeta(status)).toEqual({ label, tone });
  });

  it('未知状态原样透传 + neutral；空串回落「未知」', () => {
    expect(runStatusMeta('paused')).toEqual({ label: 'paused', tone: 'neutral' });
    expect(runStatusMeta('')).toEqual({ label: '未知', tone: 'neutral' });
  });

  it('RUN_STATUS_META 键集与 Web 七态一致', () => {
    expect(Object.keys(RUN_STATUS_META).sort()).toEqual(
      [
        'awaiting_assembly',
        'awaiting_confirm',
        'canceled',
        'done',
        'error',
        'planning',
        'running',
      ].sort(),
    );
  });
});

describe('RUN_TERMINAL（终态集合，终态断 SSE）', () => {
  it('done/error/canceled 为终态；进行态非终态', () => {
    expect(RUN_TERMINAL.has('done')).toBe(true);
    expect(RUN_TERMINAL.has('error')).toBe(true);
    expect(RUN_TERMINAL.has('canceled')).toBe(true);
    expect(RUN_TERMINAL.has('running')).toBe(false);
    expect(RUN_TERMINAL.has('awaiting_confirm')).toBe(false);
    expect(RUN_TERMINAL.has('')).toBe(false);
  });
});

describe('taskStatusMeta（task 状态徽章）', () => {
  it.each([
    ['pending', '排队中', 'neutral', undefined],
    ['queued', '已入队', 'neutral', undefined],
    ['running', '生成中', 'accent', true],
    ['verifying', '验收中', 'warn', undefined],
    ['rejected', '被打回', 'err', undefined],
    ['approved', '已通过', 'ok', undefined],
    ['done', '完成', 'ok', undefined],
    ['error', '失败', 'err', undefined],
  ])('%s → %s / %s / spin=%s', (status, label, tone, spin) => {
    expect(taskStatusMeta(status)).toEqual({ label, tone, ...(spin ? { spin } : {}) });
  });

  it('仅 running 带 spin', () => {
    const withSpin = Object.values(TASK_STATUS_META).filter((m) => m.spin);
    expect(withSpin).toHaveLength(1);
    expect(withSpin[0]?.label).toBe('生成中');
  });

  it('未知状态原样透传 + neutral；空串回落「未知」', () => {
    expect(taskStatusMeta('paused')).toEqual({ label: 'paused', tone: 'neutral' });
    expect(taskStatusMeta('')).toEqual({ label: '未知', tone: 'neutral' });
  });
});

describe('taskKindLabel（kind 中文名）', () => {
  it.each([
    ['script', '剧本'],
    ['storyboard', '分镜'],
    ['image', '图像'],
    ['video', '视频'],
    ['audio', '音频'],
    ['subtitle', '字幕'],
    ['verify', '验收'],
    ['assemble', '合成'],
  ])('%s → %s', (kind, label) => {
    expect(taskKindLabel(kind)).toBe(label);
  });

  it('未知 kind 原样透传', () => {
    expect(taskKindLabel('lipsync')).toBe('lipsync');
  });

  it('TASK_KIND_LABEL 键集与 Web 八类一致', () => {
    expect(Object.keys(TASK_KIND_LABEL).sort()).toEqual(
      ['assemble', 'audio', 'image', 'script', 'storyboard', 'subtitle', 'verify', 'video'].sort(),
    );
  });
});

describe('extractTaskMedia（产物防御提取）', () => {
  it('null/undefined/非对象 → none', () => {
    const none = { kind: 'none', src: '', text: '' };
    expect(extractTaskMedia(null)).toEqual(none);
    expect(extractTaskMedia(undefined)).toEqual(none);
    expect(extractTaskMedia({})).toEqual(none);
  });

  it('video_url 优先；video 键兜底', () => {
    expect(extractTaskMedia({ video_url: '/m/a.mp4' })).toEqual({
      kind: 'video',
      src: '/m/a.mp4',
      text: '',
    });
    expect(extractTaskMedia({ video: '/m/b.mp4' })).toEqual({
      kind: 'video',
      src: '/m/b.mp4',
      text: '',
    });
  });

  it('image_url > image > thumbnail', () => {
    expect(extractTaskMedia({ image_url: '/m/a.png', image: '/m/b.png' })).toEqual({
      kind: 'image',
      src: '/m/a.png',
      text: '',
    });
    expect(extractTaskMedia({ image: '/m/b.png', thumbnail: '/m/c.png' })).toEqual({
      kind: 'image',
      src: '/m/b.png',
      text: '',
    });
    expect(extractTaskMedia({ thumbnail: '/m/c.png' })).toEqual({
      kind: 'image',
      src: '/m/c.png',
      text: '',
    });
  });

  it('audio_url > audio > voice_url', () => {
    expect(extractTaskMedia({ audio_url: '/m/a.mp3', audio: '/m/b.mp3' })).toEqual({
      kind: 'audio',
      src: '/m/a.mp3',
      text: '',
    });
    expect(extractTaskMedia({ audio: '/m/b.mp3', voice_url: '/m/c.mp3' })).toEqual({
      kind: 'audio',
      src: '/m/b.mp3',
      text: '',
    });
    expect(extractTaskMedia({ voice_url: '/m/c.mp3' })).toEqual({
      kind: 'audio',
      src: '/m/c.mp3',
      text: '',
    });
  });

  it('优先级：video > image > audio（同帧多键取最高优先）', () => {
    expect(
      extractTaskMedia({ video_url: '/m/v.mp4', image_url: '/m/i.png', audio_url: '/m/a.mp3' }),
    ).toEqual({ kind: 'video', src: '/m/v.mp4', text: '' });
    expect(extractTaskMedia({ image_url: '/m/i.png', audio_url: '/m/a.mp3' })).toEqual({
      kind: 'image',
      src: '/m/i.png',
      text: '',
    });
  });

  it('url 按扩展名粗判：mp4/webm/mov → video（含 query 与大写）', () => {
    expect(extractTaskMedia({ url: '/m/a.mp4' }).kind).toBe('video');
    expect(extractTaskMedia({ url: '/m/a.webm?x=1' }).kind).toBe('video');
    expect(extractTaskMedia({ url: '/m/A.MOV' }).kind).toBe('video');
  });

  it('url 按扩展名粗判：wav/mp3/flac/ogg/m4a → audio', () => {
    expect(extractTaskMedia({ url: '/m/a.wav' }).kind).toBe('audio');
    expect(extractTaskMedia({ url: '/m/a.mp3?x=1' }).kind).toBe('audio');
    expect(extractTaskMedia({ url: '/m/a.flac' }).kind).toBe('audio');
    expect(extractTaskMedia({ url: '/m/a.ogg' }).kind).toBe('audio');
    expect(extractTaskMedia({ url: '/m/a.m4a' }).kind).toBe('audio');
  });

  it('url 无媒体扩展名 → image 兜底', () => {
    expect(extractTaskMedia({ url: '/m/a.png' })).toEqual({
      kind: 'image',
      src: '/m/a.png',
      text: '',
    });
    expect(extractTaskMedia({ url: '/m/a' }).kind).toBe('image');
  });

  it('urls[0] 递归提取；首元素非字符串跳过', () => {
    expect(extractTaskMedia({ urls: ['/m/a.mp4', '/m/b.mp4'] })).toEqual({
      kind: 'video',
      src: '/m/a.mp4',
      text: '',
    });
    expect(extractTaskMedia({ urls: [] })).toEqual({ kind: 'none', src: '', text: '' });
    expect(extractTaskMedia({ urls: [1, 2] })).toEqual({ kind: 'none', src: '', text: '' });
  });

  it('text/content/script → text 产物（取首个非空字符串键）', () => {
    expect(extractTaskMedia({ text: '剧本正文' })).toEqual({
      kind: 'text',
      src: '',
      text: '剧本正文',
    });
    expect(extractTaskMedia({ content: '内容' })).toEqual({ kind: 'text', src: '', text: '内容' });
    expect(extractTaskMedia({ script: '台词' })).toEqual({ kind: 'text', src: '', text: '台词' });
    expect(extractTaskMedia({ text: '', content: '后备' })).toEqual({
      kind: 'text',
      src: '',
      text: '后备',
    });
  });

  it('url 优先于 urls 与 text；媒体键优先于 url', () => {
    expect(extractTaskMedia({ url: '/m/a.mp4', urls: ['/m/b.mp4'], text: 't' }).src).toBe(
      '/m/a.mp4',
    );
    expect(extractTaskMedia({ image_url: '/m/i.png', url: '/m/a.mp4' }).kind).toBe('image');
  });

  it('非字符串值一律忽略（数字/对象/空串）', () => {
    expect(extractTaskMedia({ video_url: 123, url: '/m/a.mp4' }).src).toBe('/m/a.mp4');
    expect(extractTaskMedia({ video_url: '', image_url: '' })).toEqual({
      kind: 'none',
      src: '',
      text: '',
    });
  });
});

describe('primaryInputText（任务主文案键序）', () => {
  it('按 prompt/text/script/description/content 顺序取首个字符串键', () => {
    expect(primaryInputText({ prompt: 'p', text: 't' })).toEqual({ key: 'prompt', value: 'p' });
    expect(primaryInputText({ text: 't', script: 's' })).toEqual({ key: 'text', value: 't' });
    expect(primaryInputText({ script: 's', description: 'd' })).toEqual({
      key: 'script',
      value: 's',
    });
    expect(primaryInputText({ description: 'd', content: 'c' })).toEqual({
      key: 'description',
      value: 'd',
    });
    expect(primaryInputText({ content: 'c' })).toEqual({ key: 'content', value: 'c' });
  });

  it('非字符串键跳过；空串是合法值', () => {
    expect(primaryInputText({ prompt: 42, text: 't' })).toEqual({ key: 'text', value: 't' });
    expect(primaryInputText({ prompt: '' })).toEqual({ key: 'prompt', value: '' });
  });

  it('null/undefined/无已知键 → { prompt, "" } 兜底', () => {
    const fallback = { key: 'prompt', value: '' };
    expect(primaryInputText(null)).toEqual(fallback);
    expect(primaryInputText(undefined)).toEqual(fallback);
    expect(primaryInputText({})).toEqual(fallback);
    expect(primaryInputText({ other: 'x' })).toEqual(fallback);
  });
});

describe('toAgentRunEvent（SSE 帧守卫，联合类型）', () => {
  it('ack：message 必填，level 缺省回落空串', () => {
    expect(toAgentRunEvent('ack', { message: '已拆成 9 步', level: 'L2' })).toEqual({
      type: 'ack',
      message: '已拆成 9 步',
      level: 'L2',
    });
    expect(toAgentRunEvent('ack', { message: 'm' })).toEqual({ type: 'ack', message: 'm', level: '' });
    expect(toAgentRunEvent('ack', { level: 'L2' })).toBeNull();
  });

  it('plan：tasks 数组必填；简报缺字段的条目被剔除，depends_on 非数组回落 []', () => {
    expect(
      toAgentRunEvent('plan', {
        tasks: [
          { id: 't1', kind: 'video', title: '镜头 1', depends_on: ['t0'], status: 'pending' },
          { id: 't2', kind: 'audio' }, // 缺 title/status → 剔除
          { id: 't3', kind: 'assemble', title: '合成', status: 'pending' },
        ],
      }),
    ).toEqual({
      type: 'plan',
      tasks: [
        { id: 't1', kind: 'video', title: '镜头 1', depends_on: ['t0'], status: 'pending' },
        { id: 't3', kind: 'assemble', title: '合成', depends_on: [], status: 'pending' },
      ],
    });
    expect(toAgentRunEvent('plan', {})).toBeNull();
  });

  it('task_status 任务级：status 必填；output/gpu_hint/attempt 按需携带', () => {
    expect(
      toAgentRunEvent('task_status', {
        task_id: 't1',
        status: 'running',
        title: '镜头 1',
        gpu_hint: 'pool',
        attempt: 2,
      }),
    ).toEqual({
      type: 'task_status',
      task_id: 't1',
      status: 'running',
      title: '镜头 1',
      gpu_hint: 'pool',
      attempt: 2,
    });
    expect(
      toAgentRunEvent('task_status', {
        task_id: 't1',
        status: 'done',
        title: '镜头 1',
        output: { url: '/m/a.mp4' },
      }),
    ).toEqual({
      type: 'task_status',
      task_id: 't1',
      status: 'done',
      title: '镜头 1',
      output: { url: '/m/a.mp4' },
    });
    expect(toAgentRunEvent('task_status', { task_id: 't1' })).toBeNull();
  });

  it('task_status run 级（cancel 端点推 {run_id, status}）：无 task_id 合法', () => {
    expect(toAgentRunEvent('task_status', { run_id: 'r1', status: 'canceled' })).toEqual({
      type: 'task_status',
      run_id: 'r1',
      status: 'canceled',
    });
  });

  it('blocked / confirm_required / error：必填字段缺失 → null', () => {
    expect(toAgentRunEvent('blocked', { task_id: 't1', title: '镜头 1', error: 'boom' })).toEqual({
      type: 'blocked',
      task_id: 't1',
      title: '镜头 1',
      error: 'boom',
    });
    expect(toAgentRunEvent('blocked', { task_id: 't1', title: 'x' })).toBeNull();
    expect(
      toAgentRunEvent('confirm_required', { gate: 'assembly', message: '全部镜头已就绪' }),
    ).toEqual({ type: 'confirm_required', gate: 'assembly', message: '全部镜头已就绪' });
    expect(toAgentRunEvent('confirm_required', { gate: 'plan' })).toBeNull();
    expect(toAgentRunEvent('error', { message: 'LLM 不可用' })).toEqual({
      type: 'error',
      message: 'LLM 不可用',
    });
    expect(toAgentRunEvent('error', {})).toBeNull();
  });

  it('未知事件名 / 非对象载荷 → null', () => {
    expect(toAgentRunEvent('progress', { pct: 50 })).toBeNull();
    expect(toAgentRunEvent('ack', 'string')).toBeNull();
    expect(toAgentRunEvent('ack', null)).toBeNull();
    expect(toAgentRunEvent('ack', [1, 2])).toBeNull();
  });
});

// ── M23 三期：buildPlanOps 计划编辑草稿 → POST /plan 操作序列（对齐 Web PlanPanel.buildOps）──

describe('buildPlanOps（M23 计划编辑）', () => {
  const plan = [
    { id: 't1', input: { prompt: '旧文案 1', duration_sec: 4 } },
    { id: 't2', input: { script: '旧剧本', duration_sec: 6 } },
    { id: 't3', input: {} },
  ];

  it('空草稿（EMPTY_PLAN_DRAFT / 全空字段）→ 空序列（确认门直投 approve 不走 POST /plan）', () => {
    expect(buildPlanOps(plan, EMPTY_PLAN_DRAFT)).toEqual([]);
    expect(buildPlanOps(plan, { edits: {}, removed: [], added: [] })).toEqual([]);
  });

  it('update：仅改标题 → 只带 title 不带 input；仅改文案 → input 合并原字段不动未提交键', () => {
    expect(
      buildPlanOps(plan, {
        edits: { t1: { title: '新标题' }, t2: { inputText: '新剧本' } },
        removed: [],
        added: [],
      }),
    ).toEqual([
      { id: 't1', action: 'update', title: '新标题' },
      { id: 't2', action: 'update', input: { script: '新剧本', duration_sec: 6 } },
    ]);
  });

  it('update：inputKey 缺省取 primaryInputText 主文案键（prompt/text/script/description/content 序）', () => {
    // t1 主键 prompt；t2 主键 script；t3 无字符串键回落 prompt
    const ops = buildPlanOps(plan, {
      edits: {
        t1: { inputText: 'A' },
        t2: { inputText: 'B' },
        t3: { inputText: 'C' },
      },
      removed: [],
      added: [],
    });
    expect(ops).toEqual([
      { id: 't1', action: 'update', input: { prompt: 'A', duration_sec: 4 } },
      { id: 't2', action: 'update', input: { script: 'B', duration_sec: 6 } },
      { id: 't3', action: 'update', input: { prompt: 'C' } },
    ]);
  });

  it('update：显式 inputKey 优先于主文案键（编辑开始时锁定的键不因草稿缺失漂移）', () => {
    expect(
      buildPlanOps(plan, {
        edits: { t1: { inputText: 'X', inputKey: 'text' } },
        removed: [],
        added: [],
      }),
    ).toEqual([{ id: 't1', action: 'update', input: { prompt: '旧文案 1', duration_sec: 4, text: 'X' } }]);
  });

  it('remove 优先于 edits：被删任务的编辑痕迹一并忽略', () => {
    expect(
      buildPlanOps(plan, {
        edits: { t1: { title: '改了但被删' }, t2: { title: '保留改动' } },
        removed: ['t1'],
        added: [],
      }),
    ).toEqual([
      { id: 't1', action: 'remove' },
      { id: 't2', action: 'update', title: '保留改动' },
    ]);
  });

  it('add：title trim 后空回落「新任务」；input 固定 {prompt}；顺序在 update/remove 之后', () => {
    expect(
      buildPlanOps(plan, {
        edits: { t2: { title: '改名' } },
        removed: ['t3'],
        added: [
          { id: 'new-1', title: '  ', inputText: '雨夜空镜' },
          { id: 'new-2', title: ' 补拍镜头 ', inputText: '' },
        ],
      }),
    ).toEqual([
      { id: 't2', action: 'update', title: '改名' },
      { id: 't3', action: 'remove' },
      { id: 'new-1', action: 'add', title: '新任务', input: { prompt: '雨夜空镜' } },
      { id: 'new-2', action: 'add', title: '补拍镜头', input: { prompt: '' } },
    ]);
  });

  it('edits 指向不存在的任务 id → 忽略（任务以服务端计划为准遍历）', () => {
    expect(
      buildPlanOps(plan, {
        edits: { ghost: { title: '幽灵' } },
        removed: [],
        added: [],
      }),
    ).toEqual([]);
  });
});
