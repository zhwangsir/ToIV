import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ArtifactDetail } from '../artifact-detail';
import { deleteJob, fetchVersions, rerunJob, uploadImage } from '@/lib/api';
import { downloadAndSaveToLibrary, downloadToCache } from '@/lib/media';
import { useGenerationDraft } from '@/stores/generation-draft';
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

// expo-video 原生组件在 jest 需替身（v57：useVideoPlayer + VideoView）
jest.mock('expo-video', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    useVideoPlayer: jest.fn((source: unknown) => ({ loop: false, source })),
    VideoView: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/lib/api', () => ({
  deleteJob: jest.fn(),
  fetchVersions: jest.fn(async () => []),
  rerunJob: jest.fn(),
  uploadImage: jest.fn(),
  mediaUrl: (path: string) => `https://api.test${path}?token=t`,
}));

jest.mock('@/lib/media', () => ({
  downloadAndSaveToLibrary: jest.fn(async () => undefined),
  downloadToCache: jest.fn(async () => 'file:///cache/a.png'),
}));

const mockDeleteJob = deleteJob as jest.MockedFunction<typeof deleteJob>;
const mockFetchVersions = fetchVersions as jest.MockedFunction<typeof fetchVersions>;
const mockRerunJob = rerunJob as jest.MockedFunction<typeof rerunJob>;
const mockDownload = downloadAndSaveToLibrary as jest.MockedFunction<
  typeof downloadAndSaveToLibrary
>;
const mockDownloadToCache = downloadToCache as jest.MockedFunction<typeof downloadToCache>;
const mockUploadImage = uploadImage as jest.MockedFunction<typeof uploadImage>;

function makeJob(overrides: Partial<JobItem> = {}): JobItem {
  return {
    id: 'j1',
    prompt_id: 'p1',
    kind: 'txt2img',
    status: 'done',
    prompt: '一只在月球上的猫',
    seed: 42,
    created_at: new Date().toISOString(),
    results: ['/outputs/a.png'],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: false,
    ...overrides,
  };
}

async function renderDetail(
  job: JobItem | null,
  handlers: {
    onDeleted?: jest.Mock;
    onClose?: jest.Mock;
    onSelectVersion?: jest.Mock;
  } = {},
) {
  const { onDeleted = jest.fn(), onClose = jest.fn(), onSelectVersion } = handlers;
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
        <ArtifactDetail
          job={job}
          onClose={onClose}
          onDeleted={onDeleted}
          onSelectVersion={onSelectVersion}
          testID="detail"
        />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  await render(tree as ReactElement);
  return { onDeleted, onClose, onSelectVersion };
}

describe('ArtifactDetail（产物详情）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
  });

  it('渲染 prompt 全文 / seed / 类型徽章 / 大图（mediaUrl 拼 token）', async () => {
    await renderDetail(makeJob());
    expect(screen.getByText('一只在月球上的猫')).toBeTruthy();
    expect(screen.getByText(/seed 42/)).toBeTruthy();
    expect(screen.getByText('文生图')).toBeTruthy();
    const image = screen.getByTestId('detail-image');
    expect(image.props.source.uri).toBe('https://api.test/outputs/a.png?token=t');
  });

  it('多产物渲染缩略条，点按切换舞台图', async () => {
    await renderDetail(makeJob({ results: ['/outputs/a.png', '/outputs/b.png'] }));
    expect(screen.getByTestId('detail-thumbs')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('detail-thumb-1'));
    const image = screen.getByTestId('detail-image');
    expect(image.props.source.uri).toBe('https://api.test/outputs/b.png?token=t');
  });

  it('视频类型内嵌 VideoView 播放（拼 token URL），不渲染占位图标', async () => {
    await renderDetail(makeJob({ kind: 'wan_t2v', results: ['/outputs/v.mp4'] }));
    const video = screen.getByTestId('detail-video');
    expect(video.props.player.source).toBe('https://api.test/outputs/v.mp4?token=t');
    expect(video.props.nativeControls).toBe(true);
    expect(screen.queryByTestId('detail-image')).toBeNull();
    expect(screen.queryByTestId('detail-placeholder')).toBeNull();
    expect(screen.getByText('文生视频')).toBeTruthy();
  });

  it('音频/3D 类型用图标占位，不渲染大图或播放器', async () => {
    await renderDetail(makeJob({ kind: 'ace_audio', results: ['/outputs/a.mp3'] }));
    expect(screen.queryByTestId('detail-image')).toBeNull();
    expect(screen.queryByTestId('detail-video')).toBeNull();
    expect(screen.getByTestId('detail-placeholder')).toBeTruthy();
    expect(screen.getByText('音乐')).toBeTruthy();
  });

  it('复用提示词：写入草稿 store 并跳转创作屏', async () => {
    await renderDetail(makeJob());
    await fireEvent.press(screen.getByTestId('detail-reuse'));
    expect(useGenerationDraft.getState().draft).toEqual({ prompt: '一只在月球上的猫' });
    expect(mockPush).toHaveBeenCalledWith('/');
  });

  it('下载成功：以拼 token 的 URL 保存到相册', async () => {
    await renderDetail(makeJob());
    await fireEvent.press(screen.getByTestId('detail-download'));
    await waitFor(() =>
      expect(mockDownload).toHaveBeenCalledWith('https://api.test/outputs/a.png?token=t'),
    );
  });

  it('下载失败：展示人话错误', async () => {
    mockDownload.mockRejectedValueOnce(new Error('需要相册权限以保存作品'));
    await renderDetail(makeJob());
    await fireEvent.press(screen.getByTestId('detail-download'));
    await waitFor(() => expect(screen.getByTestId('detail-download-error')).toBeTruthy());
    expect(screen.getByText('需要相册权限以保存作品')).toBeTruthy();
  });

  it('删除：二次确认后调 deleteJob 并回调 onDeleted', async () => {
    const onDeleted = jest.fn();
    mockDeleteJob.mockResolvedValue(undefined);
    await renderDetail(makeJob(), { onDeleted });

    await fireEvent.press(screen.getByTestId('detail-delete'));
    expect(screen.getByText('删除这件作品？')).toBeTruthy();
    expect(mockDeleteJob).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('detail-confirm-confirm'));
    await waitFor(() => expect(mockDeleteJob).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('j1'));
  });

  it('删除失败：对话框内展示错误，不关闭', async () => {
    mockDeleteJob.mockRejectedValue(new Error('网络异常，请稍后再试'));
    await renderDetail(makeJob());

    await fireEvent.press(screen.getByTestId('detail-delete'));
    await fireEvent.press(screen.getByTestId('detail-confirm-confirm'));
    await waitFor(() => expect(screen.getByText('网络异常，请稍后再试')).toBeTruthy());
  });

  it('版本链 >1：渲染条带，点按其他版本回调 onSelectVersion；当前版本不重复触发', async () => {
    const onSelectVersion = jest.fn();
    const v1 = makeJob({ id: 'j1', root_id: 'j1' });
    const v2 = makeJob({ id: 'j2', root_id: 'j1', results: ['/outputs/b.png'] });
    mockFetchVersions.mockResolvedValue([v1, v2]);
    await renderDetail(v1, { onSelectVersion });

    await waitFor(() => expect(screen.getByTestId('detail-versions')).toBeTruthy());
    expect(mockFetchVersions).toHaveBeenCalledWith('j1');
    // 当前版本 v1 selected，点按不触发回调
    const current = screen.getByTestId('detail-version-j1');
    expect(current.props.accessibilityState.selected).toBe(true);
    await fireEvent.press(current);
    expect(onSelectVersion).not.toHaveBeenCalled();
    // 点 v2 → 回调携带该版本
    await fireEvent.press(screen.getByTestId('detail-version-j2'));
    expect(onSelectVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'j2' }));
  });

  it('单版本作品不渲染版本条带', async () => {
    mockFetchVersions.mockResolvedValue([makeJob({ id: 'j1', root_id: 'j1' })]);
    await renderDetail(makeJob({ id: 'j1', root_id: 'j1' }));
    await waitFor(() => expect(mockFetchVersions).toHaveBeenCalled());
    expect(screen.queryByTestId('detail-versions')).toBeNull();
  });

  it('has_params=false 旧作品不渲染重新生成入口', async () => {
    await renderDetail(makeJob({ has_params: false }));
    expect(screen.queryByTestId('detail-rerun')).toBeNull();
  });

  it('重新生成：选随机种子确认 → rerunJob 提交，成功后关闭并跳作业屏', async () => {
    mockRerunJob.mockResolvedValue({
      prompt_id: 'p2',
      client_id: 'c1',
      worker: 'w1',
      seed: 99,
      job_id: 'j2',
      parent_id: 'j1',
      root_id: 'j1',
    });
    const onClose = jest.fn();
    await renderDetail(makeJob({ has_params: true }), { onClose });

    await fireEvent.press(screen.getByTestId('detail-rerun'));
    expect(screen.getByTestId('detail-rerun-sheet')).toBeTruthy();
    // 默认保持种子；切到随机种子
    await fireEvent.press(screen.getByTestId('detail-rerun-sheet-seed-random'));
    await fireEvent.press(screen.getByTestId('detail-rerun-sheet-confirm'));

    await waitFor(() => expect(mockRerunJob).toHaveBeenCalledWith('j1', { seed_mode: 'random' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockPush).toHaveBeenCalledWith('/jobs');
  });

  it('重新生成默认保持种子（不点开选项直接确认）', async () => {
    mockRerunJob.mockResolvedValue({
      prompt_id: 'p2',
      client_id: 'c1',
      worker: 'w1',
      seed: 42,
    });
    await renderDetail(makeJob({ has_params: true }));
    await fireEvent.press(screen.getByTestId('detail-rerun'));
    await fireEvent.press(screen.getByTestId('detail-rerun-sheet-confirm'));
    await waitFor(() => expect(mockRerunJob).toHaveBeenCalledWith('j1', { seed_mode: 'keep' }));
  });

  it('重新生成失败（旧快照/类型不支持）：抽屉内展示人话错误，不关闭详情', async () => {
    mockRerunJob.mockRejectedValue(new Error('该类型作业暂不支持重新生成:raw'));
    const onClose = jest.fn();
    await renderDetail(makeJob({ has_params: true }), { onClose });

    await fireEvent.press(screen.getByTestId('detail-rerun'));
    await fireEvent.press(screen.getByTestId('detail-rerun-sheet-confirm'));
    await waitFor(() =>
      expect(screen.getByText('该类型作业暂不支持重新生成:raw')).toBeTruthy(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalledWith('/jobs');
  });
});

describe('存为资产（M28 产物 → 资产联动）', () => {
  beforeEach(() => {
    // 与主 describe 平级：自带 clearAllMocks + mockReset 防跨 describe 泄漏（M27 踩坑）
    jest.clearAllMocks();
    mockDownloadToCache.mockReset().mockResolvedValue('file:///cache/a.png');
    mockUploadImage.mockReset().mockResolvedValue({ filename: 'up-a.png', worker: 'http://w1' });
  });

  it('image 类产物渲染「存为资产」入口', async () => {
    await renderDetail(makeJob());
    expect(screen.getByTestId('detail-save-asset')).toBeTruthy();
  });

  it('video / audio 类产物不渲染「存为资产」入口', async () => {
    await renderDetail(makeJob({ kind: 'wan_t2v', results: ['/outputs/v.mp4'] }));
    expect(screen.queryByTestId('detail-save-asset')).toBeNull();
  });

  it('点击：下载缓存 → uploadImage(img2img) → push /assets/edit 带 prefill', async () => {
    await renderDetail(makeJob({ nsfw: true }));
    await fireEvent.press(screen.getByTestId('detail-save-asset'));

    await waitFor(() =>
      expect(mockDownloadToCache).toHaveBeenCalledWith('https://api.test/outputs/a.png?token=t'),
    );
    await waitFor(() =>
      expect(mockUploadImage).toHaveBeenCalledWith({ uri: 'file:///cache/a.png' }, 'img2img'),
    );
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));

    const arg = mockPush.mock.calls[0][0] as {
      pathname: string;
      params: { prefill: string };
    };
    expect(arg.pathname).toBe('/assets/edit');
    const prefill = JSON.parse(decodeURIComponent(arg.params.prefill));
    expect(prefill).toEqual({
      images: [
        {
          filename: 'up-a.png',
          worker: 'http://w1',
          preview: 'https://api.test/outputs/a.png?token=t',
        },
      ],
      name: '一只在月球上的猫',
      nsfw: true,
    });
  });

  it('多产物：切到第 2 张后存为资产，prefill 预览对应该张', async () => {
    await renderDetail(makeJob({ results: ['/outputs/a.png', '/outputs/b.png'] }));
    await fireEvent.press(screen.getByTestId('detail-thumb-1'));
    await fireEvent.press(screen.getByTestId('detail-save-asset'));

    await waitFor(() =>
      expect(mockDownloadToCache).toHaveBeenCalledWith('https://api.test/outputs/b.png?token=t'),
    );
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    const arg = mockPush.mock.calls[0][0] as { params: { prefill: string } };
    const prefill = JSON.parse(decodeURIComponent(arg.params.prefill));
    expect(prefill.images[0].preview).toBe('https://api.test/outputs/b.png?token=t');
  });

  it('下载失败：内联人话提示且不跳转', async () => {
    mockDownloadToCache.mockRejectedValueOnce(new Error('下载失败，请检查网络'));
    await renderDetail(makeJob());
    await fireEvent.press(screen.getByTestId('detail-save-asset'));

    await waitFor(() => expect(screen.getByTestId('detail-save-asset-error')).toBeTruthy());
    expect(screen.getByText('下载失败，请检查网络')).toBeTruthy();
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('上传失败：内联人话提示且不跳转', async () => {
    mockUploadImage.mockRejectedValueOnce(new Error('图片超过 20MB 上限'));
    await renderDetail(makeJob());
    await fireEvent.press(screen.getByTestId('detail-save-asset'));

    await waitFor(() => expect(screen.getByText('图片超过 20MB 上限')).toBeTruthy());
    expect(mockPush).not.toHaveBeenCalled();
  });
});
