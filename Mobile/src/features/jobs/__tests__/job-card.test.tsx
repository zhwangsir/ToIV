import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { formatRelativeTime, JOB_STATUS_META, JobCard } from '../job-card';
import { hasActiveJobs } from '../jobs-screen';
import type { JobItem } from '@/types/api';

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

jest.mock('@/lib/api', () => ({
  mediaUrl: (path: string) => `https://api.test${path}`,
}));

// expo-image 原生组件在 jest 不可断言 props，替身透传
jest.mock('expo-image', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Image: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

// jobs-screen 间接引入 ArtifactDetail → expo-router/media，ESM 在 jest 不可解析，替身隔离
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/lib/media', () => ({
  downloadAndSaveToLibrary: jest.fn(async () => undefined),
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

async function renderCard(ui: ReactElement) {
  // RNTL v14：render 是 async（内部 act），必须 await 才会绑定全局 screen
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      {ui}
    </SafeAreaProvider>,
  );
}

describe('formatRelativeTime（相对时间）', () => {
  const now = new Date('2026-08-12T12:00:00Z').getTime();

  it('一分钟内显示刚刚', () => {
    expect(formatRelativeTime('2026-08-12T11:59:40Z', now)).toBe('刚刚');
  });

  it('一小时内显示 N 分钟前', () => {
    expect(formatRelativeTime('2026-08-12T11:45:00Z', now)).toBe('15 分钟前');
  });

  it('24 小时内显示 N 小时前', () => {
    expect(formatRelativeTime('2026-08-12T09:00:00Z', now)).toBe('3 小时前');
  });

  it('超过 24 小时显示 M-D', () => {
    expect(formatRelativeTime('2026-08-10T12:00:00Z', now)).toBe('8-10');
  });

  it('非法时间返回空串', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});

describe('hasActiveJobs（轮询开关）', () => {
  it('queued/running 视为活跃', () => {
    expect(hasActiveJobs([makeJob({ status: 'queued' })])).toBe(true);
    expect(hasActiveJobs([makeJob({ status: 'running' })])).toBe(true);
  });

  it('done/error 或空列表不活跃', () => {
    expect(hasActiveJobs([makeJob({ status: 'done' }), makeJob({ id: 'j2', status: 'error' })])).toBe(false);
    expect(hasActiveJobs([])).toBe(false);
    expect(hasActiveJobs(undefined)).toBe(false);
  });
});

describe('JOB_STATUS_META（状态语义）', () => {
  it('四种后端状态全覆盖且有人话标签', () => {
    expect(Object.keys(JOB_STATUS_META).sort()).toEqual(['done', 'error', 'queued', 'running']);
    expect(JOB_STATUS_META.queued.label).toBe('排队中');
    expect(JOB_STATUS_META.running.label).toBe('生成中');
    expect(JOB_STATUS_META.done.label).toBe('已完成');
    expect(JOB_STATUS_META.error.label).toBe('失败');
  });
});

describe('JobCard（单元）', () => {
  it('error 态未传 onRetry 时不渲染动作区', async () => {
    await renderCard(<JobCard job={makeJob({ status: 'error' })} testID="card" />);
    expect(screen.queryByTestId('card-retry')).toBeNull();
  });

  it('done 但无产物时回退状态图标占位（不渲染图片）', async () => {
    await renderCard(<JobCard job={makeJob({ status: 'done', results: [] })} testID="card" />);
    expect(screen.queryByTestId('card-image')).toBeNull();
    expect(screen.getByTestId('card-thumb')).toBeTruthy();
  });
});
