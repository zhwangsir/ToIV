import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import type { ReactElement } from 'react';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { JobTracker } from '../job-tracker';
import {
  getJobSseCreds,
  registerJobSseCreds,
  resetJobSseRegistry,
} from '../job-sse-registry';
import { streamJobEvents } from '@/lib/job-events';
import type { JobItem } from '@/types/api';

// lucide 渲染链路在 jest 不稳定，替身隔离（与 jobs/library 测试同理）
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

// expo-image 原生组件在 jest 不可断言 props，替身透传
jest.mock('expo-image', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Image: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

jest.mock('@/lib/api', () => ({
  mediaUrl: (path: string) => `https://api.test${path}?token=t`,
}));

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

// SSE 消费层替身：长连接挂起不 resolve，测试手动驱动 handlers（M29.3）
jest.mock('@/lib/job-events', () => ({
  streamJobEvents: jest.fn(() => new Promise(() => undefined)),
}));

const mockStreamJobEvents = streamJobEvents as jest.Mock;

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

/** 预填 ['jobs'] 缓存后渲染追踪模态 */
async function renderTracker(
  jobs: JobItem[],
  jobId: string | null,
  onRequestDetail = jest.fn(),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  client.setQueryData(['jobs'], jobs);
  const onClose = jest.fn();
  const tree = (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <JobTracker
          jobId={jobId}
          onClose={onClose}
          onRequestDetail={onRequestDetail}
          testID="tracker"
        />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  const result = await render(tree as ReactElement);
  // React 19 更新队列对齐：flush 挂载 effect（SSE 建流/终态清凭据在 effect 内）
  await act(async () => undefined);
  return { client, onClose, onRequestDetail, unmount: result.unmount };
}

/** 向组件推一帧 SSE 回调（await act 包裹，与 React 更新队列对齐，同 agent-run-detail 测试 emit） */
async function emit(fn: () => void) {
  await act(async () => {
    fn();
  });
}

describe('JobTracker（作业详情追踪）', () => {
  it('jobId 为 null 不渲染', async () => {
    await renderTracker([makeJob({})], null);
    expect(screen.queryByTestId('tracker')).toBeNull();
  });

  it('缓存中找不到该作业不渲染', async () => {
    await renderTracker([makeJob({ id: 'j1' })], 'j-other');
    expect(screen.queryByTestId('tracker')).toBeNull();
  });

  it('queued 态：状态图标 + 排队中文案 + prompt 摘要', async () => {
    await renderTracker([makeJob({ status: 'queued', prompt: '排队中的猫' })], 'j1');
    expect(screen.getByTestId('tracker')).toBeTruthy();
    expect(screen.getByText('排队中')).toBeTruthy();
    expect(screen.getByText('排队中的猫')).toBeTruthy();
    expect(screen.getByText(/seed 7/)).toBeTruthy();
    // 非 done 不展示「查看详情」
    expect(screen.queryByTestId('tracker-detail')).toBeNull();
  });

  it('running 态：生成中文案', async () => {
    await renderTracker([makeJob({ status: 'running' })], 'j1');
    expect(screen.getByText('生成中')).toBeTruthy();
  });

  it('error 态：失败文案 + 错误提示，无详情入口', async () => {
    await renderTracker([makeJob({ status: 'error' })], 'j1');
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText(/可返回列表重试/)).toBeTruthy();
    expect(screen.queryByTestId('tracker-detail')).toBeNull();
  });

  it('done 态：产物预览（mediaUrl 拼 token）+ 查看详情按钮', async () => {
    await renderTracker(
      [makeJob({ status: 'done', results: ['/outputs/a.png'] })],
      'j1',
    );
    const preview = screen.getByTestId('tracker-preview');
    expect(preview.props.source.uri).toBe('https://api.test/outputs/a.png?token=t');
    expect(screen.getByTestId('tracker-detail')).toBeTruthy();
  });

  it('裁切窗口期(done + post_status=processing):显示「精确裁切中」,不出预览/详情入口', async () => {
    await renderTracker(
      [makeJob({ status: 'done', results: ['/outputs/raw.mp4'], post_status: 'processing' })],
      'j1',
    );
    expect(screen.getByTestId('tracker-post-processing')).toBeTruthy();
    expect(screen.getByText('精确裁切中…')).toBeTruthy();
    expect(screen.queryByTestId('tracker-preview')).toBeNull();
    expect(screen.queryByTestId('tracker-detail')).toBeNull();
  });

  it('裁切完成(post_status 清零):回落正常预览与详情入口', async () => {
    await renderTracker(
      [makeJob({ status: 'done', results: ['/outputs/final.mp4'], post_status: '' })],
      'j1',
    );
    expect(screen.queryByTestId('tracker-post-processing')).toBeNull();
    expect(screen.getByTestId('tracker-detail')).toBeTruthy();
  });

  it('done 态视频作业：类型图标占位（不渲染位图预览），保留查看详情入口', async () => {
    await renderTracker(
      [makeJob({ kind: 'wan_t2v', status: 'done', results: ['/outputs/v.mp4'] })],
      'j1',
    );
    expect(screen.queryByTestId('tracker-preview')).toBeNull();
    expect(screen.getByTestId('tracker-preview-icon')).toBeTruthy();
    expect(screen.getByText(/查看与播放/)).toBeTruthy();
    expect(screen.getByTestId('tracker-detail')).toBeTruthy();
  });

  it('done 态音频作业：同样回退图标占位', async () => {
    await renderTracker(
      [makeJob({ kind: 'ace_audio', status: 'done', results: ['/outputs/a.mp3'] })],
      'j1',
    );
    expect(screen.queryByTestId('tracker-preview')).toBeNull();
    expect(screen.getByTestId('tracker-preview-icon')).toBeTruthy();
  });

  it('done 态点「查看详情」→ 回调 onRequestDetail 接管', async () => {
    const onRequestDetail = jest.fn();
    const job = makeJob({ status: 'done', results: ['/outputs/a.png'] });
    await renderTracker([job], 'j1', onRequestDetail);
    await fireEvent.press(screen.getByTestId('tracker-detail'));
    expect(onRequestDetail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j1', status: 'done' }),
    );
  });

  it('关闭按钮回调 onClose', async () => {
    const { onClose } = await renderTracker([makeJob({})], 'j1');
    await fireEvent.press(screen.getByTestId('tracker-close'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('JobTracker SSE 进度（M29.3 会话内作业 SSE 化）', () => {
  /** GenerateResponse 形状的登记入参（job.prompt_id = p1） */
  const RES = { prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 };

  beforeEach(() => {
    jest.clearAllMocks();
    resetJobSseRegistry();
  });

  /** 最近一次 streamJobEvents 调用的 [creds, handlers, options] */
  function lastCall() {
    const calls = mockStreamJobEvents.mock.calls;
    return calls[calls.length - 1] as [
      { promptId: string; clientId: string; worker: string },
      {
        onProgress?: (p: { value: number; max: number; pct: number }) => void;
        onQualityWarning?: (w: { issues: string[] }) => void;
        onDone?: (urls: string[]) => void;
        onError?: (message: string) => void;
      },
      { signal?: AbortSignal } | undefined,
    ];
  }

  it('未登记凭据的 running 作业不建流（非本次会话提交，轮询兜底不回退）', async () => {
    await renderTracker([makeJob({ status: 'running' })], 'j1');
    expect(mockStreamJobEvents).not.toHaveBeenCalled();
    expect(screen.getByText('生成中')).toBeTruthy();
  });

  it('登记凭据后按 promptId/clientId/worker 建流，携带 AbortSignal', async () => {
    registerJobSseCreds(RES);
    await renderTracker([makeJob({ status: 'running' })], 'j1');
    await waitFor(() => expect(mockStreamJobEvents).toHaveBeenCalledTimes(1));
    const [creds, , options] = lastCall();
    expect(creds).toEqual({ promptId: 'p1', clientId: 'c1', worker: 'w1' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
  });

  it('progress 事件渲染确定性百分比与进度条（保留生成中标签）', async () => {
    registerJobSseCreds(RES);
    await renderTracker([makeJob({ status: 'running' })], 'j1');
    await waitFor(() => expect(mockStreamJobEvents).toHaveBeenCalled());
    const [, handlers] = lastCall();
    await emit(() => handlers.onProgress?.({ value: 9, max: 20, pct: 45 }));
    expect(screen.getByText('45%')).toBeTruthy();
    expect(screen.getByTestId('tracker-progress-bar')).toBeTruthy();
    expect(screen.getByText('生成中')).toBeTruthy();
  });

  it('done 事件：成功震动 + 失效 jobs 查询 + 凭据清除', async () => {
    registerJobSseCreds(RES);
    const { client } = await renderTracker([makeJob({ status: 'running' })], 'j1');
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    await waitFor(() => expect(mockStreamJobEvents).toHaveBeenCalled());
    const [, handlers] = lastCall();
    await emit(() => handlers.onDone?.(['/outputs/a.png']));
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['jobs'] });
    expect(getJobSseCreds('p1')).toBeNull();
  });

  it('error 事件：渲染后端人话 + 失败舞台 + 错误震动 + 凭据清除', async () => {
    registerJobSseCreds(RES);
    await renderTracker([makeJob({ status: 'running' })], 'j1');
    await waitFor(() => expect(mockStreamJobEvents).toHaveBeenCalled());
    const [, handlers] = lastCall();
    await emit(() => handlers.onError?.('显存不足，请降低分辨率'));
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('显存不足，请降低分辨率')).toBeTruthy();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('error');
    expect(getJobSseCreds('p1')).toBeNull();
  });

  it('quality_warning 事件：温和提示，不阻断进度舞台', async () => {
    registerJobSseCreds(RES);
    await renderTracker([makeJob({ status: 'running' })], 'j1');
    await waitFor(() => expect(mockStreamJobEvents).toHaveBeenCalled());
    const [, handlers] = lastCall();
    await emit(() => handlers.onQualityWarning?.({ issues: ['画面偏暗'] }));
    expect(screen.getByTestId('tracker-quality-warning')).toBeTruthy();
    expect(screen.getByText(/画面偏暗/)).toBeTruthy();
    expect(screen.getByText('生成中')).toBeTruthy();
  });

  it('卸载中止 SSE 流（AbortSignal 落定 aborted）', async () => {
    registerJobSseCreds(RES);
    const { unmount } = await renderTracker([makeJob({ status: 'running' })], 'j1');
    await waitFor(() => expect(mockStreamJobEvents).toHaveBeenCalled());
    const [, , options] = lastCall();
    expect(options?.signal?.aborted).toBe(false);
    await emit(() => unmount());
    expect(options?.signal?.aborted).toBe(true);
  });

  it('App 退后台中止 SSE 流（前台轮询兜底）', async () => {
    registerJobSseCreds(RES);
    const changeHandlers: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      event: string,
      cb: (state: string) => void,
    ) => {
      if (event === 'change') changeHandlers.push(cb);
      return { remove: jest.fn() };
    }) as typeof AppState.addEventListener);
    await renderTracker([makeJob({ status: 'running' })], 'j1');
    await waitFor(() => expect(mockStreamJobEvents).toHaveBeenCalled());
    const [, , options] = lastCall();
    expect(changeHandlers.length).toBeGreaterThan(0);
    await emit(() => changeHandlers.forEach((h) => h('background')));
    expect(options?.signal?.aborted).toBe(true);
  });

  it('轮询先到终态（done）：清除凭据不建流', async () => {
    registerJobSseCreds(RES);
    await renderTracker([makeJob({ status: 'done', results: ['/outputs/a.png'] })], 'j1');
    expect(mockStreamJobEvents).not.toHaveBeenCalled();
    expect(getJobSseCreds('p1')).toBeNull();
  });
});
