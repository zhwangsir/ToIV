import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AgentRunDetailScreen } from '../agent-run-detail-screen';
import {
  agentTaskAction,
  cancelAgentRun,
  getAgentRun,
  getAgentRunResult,
  resumeAgentRun,
  updateAgentRunPlan,
  watchAgentRunEvents,
} from '@/lib/api';
import { downloadAndSaveToLibrary } from '@/lib/media';
import type { AgentRunDetail, AgentRunEvent, AgentRunResult, AgentRunTask } from '@/types/api';

// lucide 渲染链路在 jest 不稳定，替身隔离（与各套件同理）
jest.mock('lucide-react-native', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return new Proxy(
    { __esModule: true },
    {
      get: (_target, prop) => {
        if (prop === '__esModule') return true;
        const C = (props: Record<string, unknown>) => React.createElement(View, props);
        C.displayName = `Lucide(${String(prop)})`;
        return C;
      },
    },
  );
});

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

// expo-video 原生组件在 jest 需替身（v57：useVideoPlayer + VideoView，与产物详情套件同式）
jest.mock('expo-video', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    useVideoPlayer: jest.fn((source: unknown) => ({ loop: false, source })),
    VideoView: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

// expo-router：useLocalSearchParams 由 mockParams 驱动
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockParams: { id?: string } = { id: 'run-1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@/lib/api', () => ({
  getAgentRun: jest.fn(),
  cancelAgentRun: jest.fn(),
  resumeAgentRun: jest.fn(),
  agentTaskAction: jest.fn(),
  updateAgentRunPlan: jest.fn(),
  getAgentRunResult: jest.fn(),
  watchAgentRunEvents: jest.fn(),
  // 产物相对路径 → 可加载 URL（测试环境简化为固定 host，契约：http→原样 / 相对→拼 base）
  mediaUrl: jest.fn((path: string) =>
    path.startsWith('http') ? path : `http://api.test${path.startsWith('/') ? path : `/${path}`}`,
  ),
}));

jest.mock('@/lib/media', () => ({
  downloadAndSaveToLibrary: jest.fn(),
}));

const mockGetRun = getAgentRun as jest.MockedFunction<typeof getAgentRun>;
const mockCancel = cancelAgentRun as jest.MockedFunction<typeof cancelAgentRun>;
const mockResume = resumeAgentRun as jest.MockedFunction<typeof resumeAgentRun>;
const mockTaskAction = agentTaskAction as jest.MockedFunction<typeof agentTaskAction>;
const mockUpdatePlan = updateAgentRunPlan as jest.MockedFunction<typeof updateAgentRunPlan>;
const mockGetResult = getAgentRunResult as jest.MockedFunction<typeof getAgentRunResult>;
const mockWatch = watchAgentRunEvents as jest.MockedFunction<typeof watchAgentRunEvents>;
const mockDownload = downloadAndSaveToLibrary as jest.MockedFunction<
  typeof downloadAndSaveToLibrary
>;

/** 捕获 SSE 回调供测试手动发帧；返回永不 resolve 的 promise 模拟流常开 */
let sseHandler: ((event: AgentRunEvent) => void) | null = null;

/** 向屏内推一帧 SSE 事件（await act 包裹，与 React 更新队列对齐） */
async function emit(event: AgentRunEvent) {
  await act(async () => {
    sseHandler?.(event);
  });
}

function makeTask(overrides: Partial<AgentRunTask>): AgentRunTask {
  return {
    id: 't1',
    kind: 'image',
    title: '生成主视觉图',
    depends_on: [],
    status: 'pending',
    attempt: 1,
    input: { prompt: '银发女主站在雨夜街头' },
    output: {},
    verdict: {},
    gpu_hint: '',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<AgentRunDetail>): AgentRunDetail {
  return {
    id: 'run-1',
    goal: '给我做一个 30 秒的产品宣传片',
    level: 'L1',
    status: 'running',
    error: '',
    plan: [makeTask({})],
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <AgentRunDetailScreen />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(tree as ReactElement);
}

describe('AgentRunDetailScreen（Agent 团队运行详情，M21.3）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sseHandler = null;
    mockParams.id = 'run-1';
    mockGetRun.mockResolvedValue(makeDetail({}));
    // 默认：流常开（永不 resolve），捕获事件回调
    mockWatch.mockImplementation((_id, _after, onEvent) => {
      sseHandler = onEvent;
      return new Promise<void>(() => {});
    });
  });

  it('加载后渲染：goal 标题 / 状态徽章 / level / 任务卡片', async () => {
    await renderScreen();
    await screen.findAllByText('给我做一个 30 秒的产品宣传片');
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.getByTestId('agent-run-detail-level').props.children).toBe('L1');
    expect(screen.getByText('生成主视觉图')).toBeTruthy();
    expect(screen.getByTestId('task-card-t1-kind').props.children).toBe('图像');
    expect(screen.getByText('排队中')).toBeTruthy();
    // 非终态：显示取消按钮 + 订阅 SSE（after=0 全量重放）
    expect(screen.getByTestId('agent-run-cancel-btn')).toBeTruthy();
    await waitFor(() =>
      expect(mockWatch).toHaveBeenCalledWith(
        'run-1',
        0,
        expect.any(Function),
        expect.any(AbortSignal),
      ),
    );
  });

  it('缺 id 参数 → 参数缺失空态', async () => {
    mockParams.id = undefined;
    await renderScreen();
    await screen.findByText('参数缺失');
    expect(mockGetRun).not.toHaveBeenCalled();
  });

  it('终态 run：不订阅 SSE + 不显示取消按钮', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'done' }));
    await renderScreen();
    await screen.findByText('已完成');
    expect(mockWatch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agent-run-cancel-btn')).toBeNull();
  });

  it('SSE task_status 事件合并进任务卡片（pending → done）', async () => {
    await renderScreen();
    await screen.findByText('排队中');
    await waitFor(() => expect(sseHandler).not.toBeNull());

    await emit({
      type: 'task_status',
      task_id: 't1',
      status: 'done',
      title: '生成主视觉图',
      output: { image_url: '/media/a.png' },
    });

    await screen.findByText('完成');
    // 产物透出（图标 + src 文本）
    expect(screen.getByText('/media/a.png')).toBeTruthy();
    // ticker 追加人话条目
    expect(screen.getByTestId('agent-run-ticker-latest').props.children).toContain('完成');
  });

  it('SSE blocked 事件 → ticker 透出失败原因', async () => {
    await renderScreen();
    await waitFor(() => expect(sseHandler).not.toBeNull());

    await emit({
      type: 'blocked',
      task_id: 't1',
      title: '生成主视觉图',
      error: 'GPU 显存不足',
    });

    await screen.findByText('生成主视觉图 遇到阻塞：GPU 显存不足');
  });

  it('SSE ack/plan/confirm_required/error 事件 → ticker 文案', async () => {
    await renderScreen();
    await waitFor(() => expect(sseHandler).not.toBeNull());

    await emit({ type: 'ack', message: '已接单，Leader 拆解中', level: 'L1' });
    await screen.findByText('已接单，Leader 拆解中');

    await emit({
      type: 'plan',
      tasks: [
        { id: 't1', kind: 'image', title: '生成主视觉图', depends_on: [], status: 'pending' },
        { id: 't2', kind: 'video', title: '生成镜头', depends_on: ['t1'], status: 'pending' },
      ],
    });
    await screen.findByText('计划已生成，共 2 步');

    await emit({
      type: 'confirm_required',
      gate: 'assembly',
      message: '全部镜头已就绪，确认后合成',
    });
    await screen.findByText('全部镜头已就绪，确认后合成');

    await emit({ type: 'error', message: '流水线异常终止' });
    await screen.findByText('流水线异常终止');
    // 最新事件置顶（倒序）
    expect(screen.getByTestId('agent-run-ticker-latest').props.children).toBe('流水线异常终止');
  });

  it('attempt > 1 显示重试计数', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ plan: [makeTask({ attempt: 3 })] }));
    await renderScreen();
    await screen.findByText('第 3 次');
  });

  it('文本产物展示 text 内容', async () => {
    mockGetRun.mockResolvedValue(
      makeDetail({
        plan: [makeTask({ kind: 'script', output: { script: '第一幕：雨夜相遇' } })],
      }),
    );
    await renderScreen();
    await screen.findByText('第一幕：雨夜相遇');
  });

  it('取消流：二次确认 → 调 cancel 接口 → 刷新详情', async () => {
    mockCancel.mockResolvedValue({ run_id: 'run-1', status: 'canceled' });
    await renderScreen();
    await screen.findByTestId('agent-run-cancel-btn');

    await fireEvent.press(screen.getByTestId('agent-run-cancel-btn'));
    await screen.findByText('取消后不可恢复，确定要终止当前 Agent 团队运行吗？');

    await fireEvent.press(screen.getByTestId('agent-run-cancel-dialog-confirm'));
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('run-1'));
    await waitFor(() =>
      expect(
        screen.queryByText('取消后不可恢复，确定要终止当前 Agent 团队运行吗？'),
      ).toBeNull(),
    );
    // 成功后重新拉详情
    await waitFor(() => expect(mockGetRun.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('取消失败：对话框内联错误，不关闭', async () => {
    mockCancel.mockRejectedValue(new Error('当前状态不可取消'));
    await renderScreen();
    await screen.findByTestId('agent-run-cancel-btn');

    await fireEvent.press(screen.getByTestId('agent-run-cancel-btn'));
    await fireEvent.press(await screen.findByTestId('agent-run-cancel-dialog-confirm'));

    await screen.findByText('当前状态不可取消');
    // 对话框保持打开
    expect(screen.getByTestId('agent-run-cancel-dialog-confirm')).toBeTruthy();
  });

  it('取消按钮点「保留运行」关闭对话框，不调接口', async () => {
    await renderScreen();
    await screen.findByTestId('agent-run-cancel-btn');

    await fireEvent.press(screen.getByTestId('agent-run-cancel-btn'));
    await fireEvent.press(await screen.findByTestId('agent-run-cancel-dialog-cancel'));

    await waitFor(() =>
      expect(
        screen.queryByText('取消后不可恢复，确定要终止当前 Agent 团队运行吗？'),
      ).toBeNull(),
    );
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('返回键调 router.back', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('agent-run-detail-back'));
    expect(mockBack).toHaveBeenCalled();
  });
});

describe('AgentRunDetailScreen（M22 二期：确认门裁决 + 卡片干预）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sseHandler = null;
    mockParams.id = 'run-1';
    mockGetRun.mockResolvedValue(makeDetail({}));
    mockWatch.mockImplementation((_id, _after, onEvent) => {
      sseHandler = onEvent;
      return new Promise<void>(() => {});
    });
    mockResume.mockResolvedValue({ run_id: 'run-1', status: 'running' });
    mockTaskAction.mockResolvedValue(makeTask({}));
  });

  // ── 确认门 ──

  it('awaiting_confirm → 计划门横幅 → 确认执行 → resume(plan/approve) → 抽屉关闭并刷新', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'awaiting_confirm' }));
    await renderScreen();
    // 横幅透出（计划门文案）
    const banner = await screen.findByTestId('agent-run-gate-banner');
    await screen.findByText('计划待确认');
    await screen.findByText('检查任务计划，确认后开始执行');

    await fireEvent.press(banner);
    // 抽屉：计划门标题 + 双按钮文案（M23：内容已升级为可编辑面板）
    await screen.findByTestId('agent-run-gate-sheet');
    await screen.findByText('可改标题/文案、删任务、加任务；确认后按计划执行：');
    expect(screen.getByText('打回重规划')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('gate-approve-btn'));
    await waitFor(() =>
      expect(mockResume).toHaveBeenCalledWith('run-1', { gate: 'plan', action: 'approve' }),
    );
    // 成功：抽屉关闭 + 状态回 running（横幅消失）+ 重新拉详情
    await waitFor(() => expect(screen.queryByTestId('agent-run-gate-sheet')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('agent-run-gate-banner')).toBeNull());
    await waitFor(() => expect(mockGetRun.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('awaiting_assembly → 合成门时间线（时长/合计）→ 批注打回 → resume(assembly/reject/feedback)', async () => {
    mockGetRun.mockResolvedValue(
      makeDetail({
        status: 'awaiting_assembly',
        plan: [
          makeTask({ status: 'done', input: { prompt: '镜头一', duration_sec: 5 } }),
          makeTask({
            id: 't2',
            kind: 'video',
            title: '镜头二',
            status: 'done',
            input: { prompt: '镜头二', duration_sec: 7 },
          }),
        ],
      }),
    );
    await renderScreen();
    await screen.findByText('合成前确认');

    await fireEvent.press(screen.getByTestId('agent-run-gate-banner'));
    await screen.findByText('全部任务已就绪，合成前请过一遍时间线：');
    // 时间线时长 + 合计
    await screen.findByText('合计时长 ≈ 12s');
    expect(screen.getByText('5s')).toBeTruthy();
    expect(screen.getByText('7s')).toBeTruthy();
    // 合成门按钮文案
    expect(screen.getByText('返回修改')).toBeTruthy();
    expect(screen.getByText('确认合成')).toBeTruthy();

    // reject 展开批注输入
    await fireEvent.press(screen.getByTestId('gate-reject-toggle-btn'));
    await fireEvent.changeText(
      await screen.findByTestId('gate-feedback-input'),
      '第 3 镜节奏太慢',
    );
    await fireEvent.press(screen.getByTestId('gate-reject-confirm-btn'));
    await waitFor(() =>
      expect(mockResume).toHaveBeenCalledWith('run-1', {
        gate: 'assembly',
        action: 'reject',
        feedback: '第 3 镜节奏太慢',
      }),
    );
  });

  it('SSE confirm_required(gate=assembly) → 就地开合成门（不重拉详情）', async () => {
    await renderScreen();
    await screen.findByText('执行中');
    expect(screen.queryByTestId('agent-run-gate-banner')).toBeNull();
    await waitFor(() => expect(sseHandler).not.toBeNull());

    await emit({
      type: 'confirm_required',
      gate: 'assembly',
      message: '全部镜头已就绪，确认后合成',
    });

    // 状态徽章就地翻转 + 合成门横幅出现
    await screen.findByText('待确认合成');
    await screen.findByTestId('agent-run-gate-banner');
    await screen.findByText('全部任务已就绪，确认合成成片');
  });

  it('裁决失败：错误内联在抽屉，不关闭', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'awaiting_confirm' }));
    mockResume.mockRejectedValue(new Error('当前状态不可裁决'));
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('agent-run-gate-banner'));
    await fireEvent.press(await screen.findByTestId('gate-approve-btn'));

    await screen.findByText('当前状态不可裁决');
    // 抽屉保持打开可重试
    expect(screen.getByTestId('agent-run-gate-sheet')).toBeTruthy();
  });

  // ── 卡片干预可见性 ──

  it('操作行可见性矩阵：pending 无重生成；done 出重生成；assemble 卡与终态 run 不出操作行', async () => {
    // pending 卡：改文案/通过可见，重生成不可见
    await renderScreen();
    await screen.findByTestId('task-card-t1-actions');
    expect(screen.getByTestId('task-card-t1-edit-btn')).toBeTruthy();
    expect(screen.getByTestId('task-card-t1-approve-btn')).toBeTruthy();
    expect(screen.queryByTestId('task-card-t1-regen-btn')).toBeNull();
  });

  it('done 卡出重生成入口；approved 卡隐藏通过按钮', async () => {
    mockGetRun.mockResolvedValue(
      makeDetail({
        plan: [
          makeTask({ id: 't1', status: 'done' }),
          makeTask({ id: 't2', title: '已通过卡', status: 'approved' }),
        ],
      }),
    );
    await renderScreen();
    await screen.findByTestId('task-card-t1-regen-btn');
    expect(screen.getByTestId('task-card-t1-approve-btn')).toBeTruthy();
    // approved：不再显示通过
    expect(screen.queryByTestId('task-card-t2-approve-btn')).toBeNull();
    expect(screen.getByTestId('task-card-t2-edit-btn')).toBeTruthy();
  });

  it('assemble 卡不出操作行（走合成门）', async () => {
    mockGetRun.mockResolvedValue(
      makeDetail({ plan: [makeTask({ kind: 'assemble', title: '合成成片' })] }),
    );
    await renderScreen();
    await screen.findByText('合成成片');
    expect(screen.queryByTestId('task-card-t1-actions')).toBeNull();
  });

  it('终态 run 不出操作行', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'done' }));
    await renderScreen();
    await screen.findByText('已完成');
    expect(screen.queryByTestId('task-card-t1-actions')).toBeNull();
  });

  // ── 卡片干预流程 ──

  it('改文案：抽屉预填主文案 → 保存 → edit payload 契约 → 返回卡局部替换（不重拉详情）', async () => {
    mockTaskAction.mockResolvedValue(
      makeTask({ attempt: 2, input: { prompt: '雨夜，女主回头' } }),
    );
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('task-card-t1-edit-btn'));

    // 抽屉打开且预填主文案（primaryInputText 取 prompt）
    const input = await screen.findByTestId('task-edit-input');
    expect(input.props.value).toBe('银发女主站在雨夜街头');

    await fireEvent.changeText(input, '雨夜，女主回头');
    await fireEvent.press(screen.getByTestId('task-edit-save-btn'));

    await waitFor(() =>
      expect(mockTaskAction).toHaveBeenCalledWith('run-1', 't1', {
        action: 'edit',
        payload: { input: { prompt: '雨夜，女主回头' } },
      }),
    );
    // 成功：抽屉关闭 + 返回卡（attempt+1）局部替换，不重拉详情
    await waitFor(() => expect(screen.queryByTestId('task-edit-sheet')).toBeNull());
    await screen.findByText('第 2 次');
    expect(mockGetRun.mock.calls.length).toBe(1);
  });

  it('重生成：引导词透传 payload.guidance；空引导词不带 payload', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ plan: [makeTask({ status: 'done' })] }));
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('task-card-t1-regen-btn'));
    await fireEvent.changeText(
      await screen.findByTestId('task-regen-input'),
      '雨更大一些',
    );
    await fireEvent.press(screen.getByTestId('task-regen-save-btn'));

    await waitFor(() =>
      expect(mockTaskAction).toHaveBeenCalledWith('run-1', 't1', {
        action: 'regenerate',
        payload: { guidance: '雨更大一些' },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('task-regen-sheet')).toBeNull());
  });

  it('通过：直接提交 → approved 局部替换 → 通过按钮消失', async () => {
    mockTaskAction.mockResolvedValue(makeTask({ status: 'approved' }));
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('task-card-t1-approve-btn'));

    await waitFor(() =>
      expect(mockTaskAction).toHaveBeenCalledWith('run-1', 't1', { action: 'approve' }),
    );
    await screen.findByText('已通过');
    await waitFor(() => expect(screen.queryByTestId('task-card-t1-approve-btn')).toBeNull());
  });

  it('直操作失败（approve 409）：错误落横幅，人话透传', async () => {
    mockTaskAction.mockRejectedValue(new Error('当前状态不可通过'));
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('task-card-t1-approve-btn'));

    await screen.findByTestId('agent-run-action-error');
    await screen.findByText('当前状态不可通过');
  });
});

describe('AgentRunDetailScreen（M23 三期：计划编辑 POST /plan + 成片结果 GET /result）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sseHandler = null;
    mockParams.id = 'run-1';
    mockGetRun.mockResolvedValue(makeDetail({}));
    mockWatch.mockImplementation((_id, _after, onEvent) => {
      sseHandler = onEvent;
      return new Promise<void>(() => {});
    });
    mockResume.mockResolvedValue({ run_id: 'run-1', status: 'running' });
    mockTaskAction.mockResolvedValue(makeTask({}));
    mockUpdatePlan.mockResolvedValue({ run_id: 'run-1', plan: { tasks: [] } });
    // 默认：无成片产物（final_url 空串 → 成片卡不渲染）
    mockGetResult.mockResolvedValue({ final_url: '', duration_sec: 0, tasks: [] });
    mockDownload.mockResolvedValue(undefined);
  });

  /** 两任务计划门详情：t1 图像 prompt 主键；t2 视频 script 主键 + 依赖 t1 */
  function makePlanGateDetail(): AgentRunDetail {
    return makeDetail({
      status: 'awaiting_confirm',
      plan: [
        makeTask({}),
        makeTask({
          id: 't2',
          kind: 'video',
          title: '生成镜头视频',
          depends_on: ['t1'],
          input: { script: '旧剧本' },
        }),
      ],
    });
  }

  const makeResult = (overrides: Partial<AgentRunResult>): AgentRunResult => ({
    final_url: '/files/final.mp4',
    duration_sec: 12,
    tasks: [
      { id: 't1', title: '生成主视觉图', kind: 'image', status: 'done', output: {} },
      { id: 't2', title: '生成镜头视频', kind: 'video', status: 'done', output: {} },
    ],
    ...overrides,
  });

  // ── 计划编辑面板 ──

  it('计划门抽屉为可编辑面板：标题/主文案预填 + 依赖行；无改动确认直 resume(approve) 不调 POST /plan', async () => {
    mockGetRun.mockResolvedValue(makePlanGateDetail());
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('agent-run-gate-banner'));
    await screen.findByTestId('gate-plan-editor');

    // 预填：标题用任务 title；文案用 primaryInputText 主键值（t1→prompt，t2→script）
    expect(screen.getByTestId('gate-plan-title-t1').props.value).toBe('生成主视觉图');
    expect(screen.getByTestId('gate-plan-input-t1').props.value).toBe('银发女主站在雨夜街头');
    expect(screen.getByTestId('gate-plan-title-t2').props.value).toBe('生成镜头视频');
    expect(screen.getByTestId('gate-plan-input-t2').props.value).toBe('旧剧本');
    // kind 中文名 + 依赖行（依赖序号对齐 Web「第 N 步」）
    expect(screen.getAllByText('图像').length).toBeGreaterThanOrEqual(1);
    await screen.findByText('依赖 第 1 步');

    await fireEvent.press(screen.getByTestId('gate-approve-btn'));
    await waitFor(() =>
      expect(mockResume).toHaveBeenCalledWith('run-1', { gate: 'plan', action: 'approve' }),
    );
    expect(mockUpdatePlan).not.toHaveBeenCalled();
  });

  it('改标题+文案 → 确认 → POST /plan ops[update×2] → resume(modify) → 抽屉关闭并刷新', async () => {
    mockGetRun.mockResolvedValue(makePlanGateDetail());
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('agent-run-gate-banner'));
    await screen.findByTestId('gate-plan-editor');

    await fireEvent.changeText(screen.getByTestId('gate-plan-title-t1'), '新标题');
    await fireEvent.changeText(screen.getByTestId('gate-plan-input-t2'), '新剧本');
    await fireEvent.press(screen.getByTestId('gate-approve-btn'));

    // update：title 直改；input 按主键合并（script 键，不动未提交字段）
    await waitFor(() =>
      expect(mockUpdatePlan).toHaveBeenCalledWith('run-1', [
        { id: 't1', action: 'update', title: '新标题' },
        { id: 't2', action: 'update', input: { script: '新剧本' } },
      ]),
    );
    await waitFor(() =>
      expect(mockResume).toHaveBeenCalledWith('run-1', { gate: 'plan', action: 'modify' }),
    );
    // 成功：抽屉关闭 + 草稿清空（横幅随状态回 running 消失）+ 重新拉详情
    await waitFor(() => expect(screen.queryByTestId('agent-run-gate-sheet')).toBeNull());
    await waitFor(() => expect(mockGetRun.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('删任务 + 加任务 → ops[remove/add]（add 空标题回落「新任务」，input 固定 {prompt}）', async () => {
    mockGetRun.mockResolvedValue(makePlanGateDetail());
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('agent-run-gate-banner'));
    await screen.findByTestId('gate-plan-editor');

    // 删 t1：行内移除（本地痕迹，未提交前不动其他行）
    await fireEvent.press(screen.getByTestId('gate-plan-remove-t1'));
    expect(screen.queryByTestId('gate-plan-row-t1')).toBeNull();
    expect(screen.getByTestId('gate-plan-row-t2')).toBeTruthy();

    // 加任务：临时行 new-1；只填文案，标题留空 → 落库回落「新任务」
    await fireEvent.press(screen.getByTestId('gate-plan-add-btn'));
    await screen.findByTestId('gate-plan-row-new-1');
    await fireEvent.changeText(screen.getByTestId('gate-plan-new-input-new-1'), '雨夜空镜');
    await fireEvent.press(screen.getByTestId('gate-approve-btn'));

    await waitFor(() =>
      expect(mockUpdatePlan).toHaveBeenCalledWith('run-1', [
        { id: 't1', action: 'remove' },
        { id: 'new-1', action: 'add', title: '新任务', input: { prompt: '雨夜空镜' } },
      ]),
    );
    await waitFor(() =>
      expect(mockResume).toHaveBeenCalledWith('run-1', { gate: 'plan', action: 'modify' }),
    );
  });

  it('新增行可移除；任务全删空时确认钮禁用（对齐 Web 空计划不可确认）', async () => {
    mockGetRun.mockResolvedValue(makePlanGateDetail());
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('agent-run-gate-banner'));
    await screen.findByTestId('gate-plan-editor');

    // 新增 → 移除：行消失且不留痕迹
    await fireEvent.press(screen.getByTestId('gate-plan-add-btn'));
    await screen.findByTestId('gate-plan-row-new-1');
    await fireEvent.press(screen.getByTestId('gate-plan-new-drop-new-1'));
    expect(screen.queryByTestId('gate-plan-row-new-1')).toBeNull();

    // 全删空：确认钮 disabled
    await fireEvent.press(screen.getByTestId('gate-plan-remove-t1'));
    await fireEvent.press(screen.getByTestId('gate-plan-remove-t2'));
    expect(screen.queryByTestId('gate-plan-editor')?.props.children).toBeTruthy();
    const approveBtn = screen.getByTestId('gate-approve-btn');
    expect(approveBtn.props.accessibilityState?.disabled).toBe(true);
  });

  it('POST /plan 409：人话内联抽屉、resume 未调、抽屉保持打开且编辑痕迹保留', async () => {
    mockGetRun.mockResolvedValue(makePlanGateDetail());
    mockUpdatePlan.mockRejectedValue(new Error('仅待确认状态可编辑计划'));
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('agent-run-gate-banner'));
    await screen.findByTestId('gate-plan-editor');

    await fireEvent.changeText(screen.getByTestId('gate-plan-title-t1'), '新标题');
    await fireEvent.press(screen.getByTestId('gate-approve-btn'));

    await screen.findByText('仅待确认状态可编辑计划');
    expect(mockResume).not.toHaveBeenCalled();
    // 抽屉保持打开 + 痕迹保留（可重试）
    expect(screen.getByTestId('agent-run-gate-sheet')).toBeTruthy();
    expect(screen.getByTestId('gate-plan-title-t1').props.value).toBe('新标题');
  });

  it('resume(modify) 失败（POST /plan 已成功）：人话内联抽屉、抽屉保持打开', async () => {
    mockGetRun.mockResolvedValue(makePlanGateDetail());
    mockResume.mockRejectedValue(new Error('当前状态不可裁决'));
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('agent-run-gate-banner'));
    await screen.findByTestId('gate-plan-editor');

    await fireEvent.changeText(screen.getByTestId('gate-plan-title-t1'), '新标题');
    await fireEvent.press(screen.getByTestId('gate-approve-btn'));

    await screen.findByText('当前状态不可裁决');
    expect(mockUpdatePlan).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('agent-run-gate-sheet')).toBeTruthy();
  });

  // ── 成片结果卡 ──

  it('done → GET /result → 成片卡渲染（VideoView / 时长 / 产物计数 / 保存钮）', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'done' }));
    mockGetResult.mockResolvedValue(makeResult({}));
    await renderScreen();

    await screen.findByTestId('agent-run-result-card');
    await screen.findByText('成片已就绪');
    expect(screen.getByTestId('agent-run-result-card-video')).toBeTruthy();
    expect(screen.getByTestId('agent-run-result-card-duration').props.children).toEqual([
      '≈ ',
      12,
      's',
    ]);
    expect(screen.getByTestId('agent-run-result-card-tasks-count').props.children).toEqual([
      '产物任务 ',
      2,
      ' 个',
    ]);
    expect(screen.getByTestId('agent-run-result-card-save-btn')).toBeTruthy();
    // 仅 done 拉取（查询键带 runId）
    await waitFor(() => expect(mockGetResult).toHaveBeenCalledWith('run-1'));
  });

  it('final_url 空串 → 成片卡不渲染（合成产物缺失静默）', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'done' }));
    mockGetResult.mockResolvedValue(makeResult({ final_url: '' }));
    await renderScreen();

    await screen.findByText('已完成');
    await waitFor(() => expect(mockGetResult).toHaveBeenCalledWith('run-1'));
    expect(screen.queryByTestId('agent-run-result-card')).toBeNull();
  });

  it('GET /result 409（竞态）→ 静默不渲染成片卡、不透出错误', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'done' }));
    mockGetResult.mockRejectedValue(new Error('任务尚未完成'));
    await renderScreen();

    await screen.findByText('已完成');
    await waitFor(() => expect(mockGetResult).toHaveBeenCalledWith('run-1'));
    expect(screen.queryByTestId('agent-run-result-card')).toBeNull();
    expect(screen.queryByText('任务尚未完成')).toBeNull();
  });

  it('保存到相册：downloadAndSaveToLibrary(mediaUrl(final_url)) → 「已保存到相册」禁重复', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'done' }));
    mockGetResult.mockResolvedValue(makeResult({}));
    await renderScreen();

    await fireEvent.press(await screen.findByTestId('agent-run-result-card-save-btn'));
    await waitFor(() =>
      expect(mockDownload).toHaveBeenCalledWith('http://api.test/files/final.mp4'),
    );
    await screen.findByText('已保存到相册');
    const saveBtn = screen.getByTestId('agent-run-result-card-save-btn');
    expect(saveBtn.props.accessibilityState?.disabled).toBe(true);
  });

  it('保存失败（无相册权限）→ 人话内联成片卡，按钮恢复可重试', async () => {
    mockGetRun.mockResolvedValue(makeDetail({ status: 'done' }));
    mockGetResult.mockResolvedValue(makeResult({}));
    mockDownload.mockRejectedValue(new Error('需要相册权限以保存作品'));
    await renderScreen();

    await fireEvent.press(await screen.findByTestId('agent-run-result-card-save-btn'));
    await screen.findByText('需要相册权限以保存作品');
    // 失败回 idle：按钮仍可点（重试）
    const saveBtn = screen.getByTestId('agent-run-result-card-save-btn');
    expect(saveBtn.props.accessibilityState?.disabled).toBe(false);
  });

  it('非 done 状态不拉 GET /result', async () => {
    await renderScreen();
    await screen.findByText('执行中');
    expect(mockGetResult).not.toHaveBeenCalled();
  });
});
