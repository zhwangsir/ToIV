import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AgentRunsScreen, hasActiveRuns } from '../agent-runs-screen';
import { listAgentRuns } from '@/lib/api';
import type { AgentRunSummary } from '@/types/api';

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
  ImpactFeedbackStyle: { Light: 'light' },
}));

// expo-router 真身依赖原生导航栈，替身隔离跳转断言
const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
}));

jest.mock('@/lib/api', () => ({
  listAgentRuns: jest.fn(),
}));

const mockList = listAgentRuns as jest.MockedFunction<typeof listAgentRuns>;

function makeRun(overrides: Partial<AgentRunSummary>): AgentRunSummary {
  return {
    id: 'run-1',
    level: 'L1',
    goal: '给我做一个 30 秒的产品宣传片',
    status: 'running',
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    task_counts: { total: 6, done: 2, error: 0 },
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
        <AgentRunsScreen />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(tree as ReactElement);
}

describe('hasActiveRuns（轮询开关）', () => {
  it('有非终态 run 时轮询，全终态即停', () => {
    expect(hasActiveRuns(undefined)).toBe(false);
    expect(hasActiveRuns([])).toBe(false);
    expect(hasActiveRuns([makeRun({ status: 'done' })])).toBe(false);
    expect(hasActiveRuns([makeRun({ status: 'error' })])).toBe(false);
    expect(hasActiveRuns([makeRun({ status: 'canceled' })])).toBe(false);
    expect(hasActiveRuns([makeRun({ status: 'running' })])).toBe(true);
    expect(hasActiveRuns([makeRun({ status: 'awaiting_confirm' })])).toBe(true);
  });
});

describe('AgentRunsScreen（Agent 团队运行列表，M21.2）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue([]);
  });

  it('渲染标题 + 状态过滤 chips；缺省查询不带 status', async () => {
    await renderScreen();
    expect(screen.getByText('Agent 团队')).toBeTruthy();
    expect(screen.getByTestId('agent-run-filter-all')).toBeTruthy();
    expect(screen.getByTestId('agent-run-filter-running')).toBeTruthy();
    expect(screen.getByTestId('agent-run-filter-canceled')).toBeTruthy();
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(''));
  });

  it('加载完成后渲染 run 卡片：goal / 状态徽章 / level / 任务进度', async () => {
    mockList.mockResolvedValue([makeRun({})]);
    await renderScreen();
    await screen.findByText('给我做一个 30 秒的产品宣传片');
    // 徽章（与过滤 chip 同文案，靠 testID 区分）
    expect(screen.getByTestId('run-card-run-1-status').props.accessibilityLabel).toBe('状态：执行中');
    expect(screen.getByTestId('run-card-run-1-level').props.children).toBe('L1');
    expect(screen.getByText(/任务 2\/6/)).toBeTruthy();
    expect(screen.getByText('5 分钟前')).toBeTruthy();
  });

  it('有失败任务时红字透出 error 数', async () => {
    mockList.mockResolvedValue([makeRun({ task_counts: { total: 5, done: 3, error: 2 } })]);
    await renderScreen();
    await screen.findByText(/任务 3\/5/);
    expect(screen.getByText(/2 项失败/)).toBeTruthy();
  });

  it('切换过滤 chip → 带 status 重新查询', async () => {
    await renderScreen();
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(''));
    await fireEvent.press(screen.getByTestId('agent-run-filter-awaiting_confirm'));
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('awaiting_confirm'));
  });

  it('空态：全部桶与过滤桶文案区分', async () => {
    await renderScreen();
    await screen.findByText('暂无 Agent 团队任务');

    mockList.mockResolvedValue([]);
    await fireEvent.press(screen.getByTestId('agent-run-filter-done'));
    await screen.findByText('该状态暂无任务');
  });

  it('点卡跳转详情（/agent-runs/[id] 带 id 参数）', async () => {
    mockList.mockResolvedValue([makeRun({})]);
    await renderScreen();
    await fireEvent.press(await screen.findByTestId('run-card-run-1'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/agent-runs/[id]',
      params: { id: 'run-1' },
    });
  });

  it('返回键调 router.back', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('agent-runs-back'));
    expect(mockBack).toHaveBeenCalled();
  });
});
