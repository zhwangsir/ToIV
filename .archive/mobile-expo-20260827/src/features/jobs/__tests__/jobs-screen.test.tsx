import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { JobsScreen, hasActiveJobs } from '../jobs-screen';
import { getJobSseCreds, resetJobSseRegistry } from '../job-sse-registry';
import { listJobs, submitTxt2Img } from '@/lib/api';
import type { JobItem } from '@/types/api';

// lucide 渲染链路在 jest 不稳定，替身隔离（与 generate/profile 测试同理）
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
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

// expo-image 原生组件在 jest 不可断言 props，替身透传
jest.mock('expo-image', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Image: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

jest.mock('@/lib/api', () => ({
  listJobs: jest.fn(),
  submitTxt2Img: jest.fn(),
  deleteJob: jest.fn(),
  mediaUrl: (path: string) => `https://api.test${path}?token=t`,
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/lib/media', () => ({
  downloadAndSaveToLibrary: jest.fn(async () => undefined),
}));

// SSE 消费层替身（M29.3）：JobTracker 挂在屏内，隔离 expo/fetch 原生链路
jest.mock('@/lib/job-events', () => ({
  streamJobEvents: jest.fn(() => new Promise(() => undefined)),
}));

// expo-video 原生组件在 jest 需替身（ArtifactDetail 视频舞台）
jest.mock('expo-video', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    useVideoPlayer: jest.fn((source: unknown) => ({ loop: false, source })),
    VideoView: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

const mockListJobs = listJobs as jest.MockedFunction<typeof listJobs>;
const mockSubmit = submitTxt2Img as jest.MockedFunction<typeof submitTxt2Img>;

function makeJob(overrides: Partial<JobItem>): JobItem {
  return {
    id: 'j1',
    prompt_id: 'p1',
    kind: 'txt2img',
    status: 'queued',
    prompt: '一只猫',
    seed: 7,
    created_at: new Date().toISOString(),
    results: [],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: false,
    ...overrides,
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  const tree = (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <JobsScreen />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(tree as ReactElement);
}

describe('JobsScreen（作业）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetJobSseRegistry();
  });

  it('空列表展示空状态，不渲染列表', async () => {
    mockListJobs.mockResolvedValue([]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('empty-jobs')).toBeTruthy());
    expect(screen.queryByTestId('jobs-list')).toBeNull();
  });

  it('渲染作业卡片流：状态徽章 + prompt + 相对时间', async () => {
    mockListJobs.mockResolvedValue([
      makeJob({ id: 'j1', status: 'running', prompt: '奔跑的猫' }),
      makeJob({ id: 'j2', status: 'queued', prompt: '睡觉的狗' }),
    ]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('job-card-j1')).toBeTruthy());
    expect(screen.getByTestId('job-card-j2')).toBeTruthy();
    expect(screen.getByText('奔跑的猫')).toBeTruthy();
    expect(screen.getByText('生成中')).toBeTruthy();
    expect(screen.getByText('排队中')).toBeTruthy();
    expect(screen.getAllByText('刚刚')).toHaveLength(2);
  });

  it('done 作业用产物缩略图（mediaUrl 拼 token）并展示数量角标', async () => {
    mockListJobs.mockResolvedValue([
      makeJob({ id: 'j1', status: 'done', results: ['/outputs/a.png', '/outputs/b.png'] }),
    ]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('job-card-j1-image')).toBeTruthy());
    const image = screen.getByTestId('job-card-j1-image');
    expect(image.props.source.uri).toBe('https://api.test/outputs/a.png?token=t');
    expect(screen.getByText('×2')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('失败作业展示重试按钮，点按同 prompt 重提交并刷新列表', async () => {
    mockListJobs.mockResolvedValue([makeJob({ id: 'j1', status: 'error', prompt: '失败的任务' })]);
    mockSubmit.mockResolvedValue({ prompt_id: 'p2', client_id: 'c2', worker: 'w1', seed: 8 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('job-card-j1-retry')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('job-card-j1-retry'));
    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith({ positive: '失败的任务' }),
    );
    // 成功后失效 jobs 查询 → 重新拉取（首次 1 次 + 失效后 1 次）
    await waitFor(() => expect(mockListJobs.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('重试成功登记会话内 SSE 凭据（M29.3：新作业可被 SSE 追踪）', async () => {
    mockListJobs.mockResolvedValue([makeJob({ id: 'j1', status: 'error', prompt: '失败的任务' })]);
    mockSubmit.mockResolvedValue({ prompt_id: 'p-re', client_id: 'c-re', worker: 'w-re', seed: 8 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('job-card-j1-retry')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('job-card-j1-retry'));
    await waitFor(() =>
      expect(getJobSseCreds('p-re')).toEqual({ clientId: 'c-re', worker: 'w-re' }),
    );
  });

  it('非失败作业不渲染重试按钮', async () => {
    mockListJobs.mockResolvedValue([makeJob({ id: 'j1', status: 'done', results: ['/a.png'] })]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('job-card-j1')).toBeTruthy());
    expect(screen.queryByTestId('job-card-j1-retry')).toBeNull();
  });

  it('点按 running 卡片 → 打开单点追踪模态', async () => {
    mockListJobs.mockResolvedValue([makeJob({ id: 'j1', status: 'running', prompt: '追踪中的猫' })]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('job-card-j1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('job-card-j1'));
    await waitFor(() => expect(screen.getByTestId('job-tracker')).toBeTruthy());
    // 卡片徽章 + 追踪模态各一处「生成中」
    expect(screen.getAllByText('生成中').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('追踪中的猫').length).toBeGreaterThanOrEqual(2);
    // 追踪模态未请求详情前，产物详情不打开
    expect(screen.queryByTestId('job-artifact-detail-image')).toBeNull();
  });

  it('点按 done 卡片 → 直接打开产物详情', async () => {
    mockListJobs.mockResolvedValue([
      makeJob({ id: 'j1', status: 'done', results: ['/outputs/a.png'], prompt: '完成的猫' }),
    ]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('job-card-j1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('job-card-j1'));
    await waitFor(() => expect(screen.getByTestId('job-artifact-detail')).toBeTruthy());
    expect(screen.queryByTestId('job-tracker')).toBeNull();
  });
});

describe('hasActiveJobs(轮询开关)', () => {
  it('queued/running 视为活跃', () => {
    expect(hasActiveJobs([makeJob({ status: 'queued' })])).toBe(true);
    expect(hasActiveJobs([makeJob({ status: 'running' })])).toBe(true);
  });

  it('全终态即停(done/error)', () => {
    expect(hasActiveJobs([makeJob({ status: 'done' })])).toBe(false);
    expect(hasActiveJobs([makeJob({ status: 'error' })])).toBe(false);
    expect(hasActiveJobs([])).toBe(false);
    expect(hasActiveJobs(undefined)).toBe(false);
  });

  it('裁切窗口期(done + post_status=processing)保持轮询;清零后停止', () => {
    expect(
      hasActiveJobs([makeJob({ status: 'done', post_status: 'processing' })]),
    ).toBe(true);
    expect(hasActiveJobs([makeJob({ status: 'done', post_status: '' })])).toBe(false);
  });
});
