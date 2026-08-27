import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LibraryScreen, collectArtifacts, columnCount } from '../library-screen';
import { LIBRARY_PAGE_SIZE } from '../library-paging';
import { deleteJob, listJobs } from '@/lib/api';
import { downloadAndSaveToLibrary } from '@/lib/media';
import type { JobItem } from '@/types/api';

// lucide 渲染链路在 jest 不稳定，替身隔离（与 jobs/generate 测试同理）
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

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
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

jest.mock('@/lib/api', () => ({
  listJobs: jest.fn(),
  deleteJob: jest.fn(),
  mediaUrl: (path: string) => `https://api.test${path}?token=t`,
}));

jest.mock('@/lib/media', () => ({
  downloadAndSaveToLibrary: jest.fn(async () => undefined),
}));

const mockListJobs = listJobs as jest.MockedFunction<typeof listJobs>;
const mockDeleteJob = deleteJob as jest.MockedFunction<typeof deleteJob>;
const mockDownload = downloadAndSaveToLibrary as jest.MockedFunction<
  typeof downloadAndSaveToLibrary
>;

function makeJob(overrides: Partial<JobItem>): JobItem {
  return {
    id: 'j1',
    prompt_id: 'p1',
    kind: 'txt2img',
    status: 'done',
    prompt: '一只猫',
    seed: 7,
    created_at: new Date().toISOString(),
    results: ['/outputs/a.png'],
    nsfw: false,
    parent_id: '',
    root_id: '',
    has_params: false,
    ...overrides,
  };
}

function makeJobs(prefix: string, count: number, overrides: Partial<JobItem> = {}): JobItem[] {
  return Array.from({ length: count }, (_, i) =>
    makeJob({ id: `${prefix}${i}`, prompt: `${prefix}${i}`, ...overrides }),
  );
}

/** 假服务端：按 limit/offset/kind 切片响应（server.jobs 可变，模拟分页间数据漂移） */
function mockJobsServer(server: { jobs: JobItem[] }) {
  mockListJobs.mockImplementation((options = {}) => {
    const { limit = 50, offset = 0, kind = '' } = options;
    let filtered = server.jobs;
    if (kind) {
      const kinds = kind.split(',').map((k) => k.trim()).filter(Boolean);
      filtered = server.jobs.filter((j) => kinds.includes(j.kind));
    }
    return Promise.resolve(filtered.slice(offset, offset + limit));
  });
}

function gridData(): JobItem[] {
  return screen.getByTestId('library-grid').props.data as JobItem[];
}

async function renderScreen() {
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
        <LibraryScreen />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  const utils = await render(tree as ReactElement);
  return { ...utils, client };
}

describe('columnCount 断点', () => {
  it('phone 2 列 / 大屏 3 列 / 平板 4 列', () => {
    expect(columnCount(390)).toBe(2);
    expect(columnCount(431)).toBe(3);
    expect(columnCount(768)).toBe(4);
  });
});

describe('collectArtifacts', () => {
  it('只收藏 done 且有产物的作业', () => {
    const jobs = [
      makeJob({ id: 'j1', status: 'done', results: ['/a.png'] }),
      makeJob({ id: 'j2', status: 'done', results: [] }),
      makeJob({ id: 'j3', status: 'running', results: [] }),
    ];
    expect(collectArtifacts(jobs).map((j) => j.id)).toEqual(['j1']);
    expect(collectArtifacts(undefined)).toEqual([]);
  });
});

describe('LibraryScreen（作品库）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('加载中显示 spinner', async () => {
    mockListJobs.mockReturnValue(new Promise(() => {}));
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-loading')).toBeTruthy());
  });

  it('无作品显示空状态语义', async () => {
    mockListJobs.mockResolvedValue([]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('empty-library')).toBeTruthy());
    expect(screen.getByText('还没有作品')).toBeTruthy();
    expect(screen.queryByTestId('library-grid')).toBeNull();
  });

  it('渲染双列网格：只含 done 且有产物的作业，缩略图走 mediaUrl', async () => {
    mockListJobs.mockResolvedValue([
      makeJob({ id: 'j1', prompt: '猫' }),
      makeJob({ id: 'j2', prompt: '狗', results: ['/outputs/b.png'] }),
      makeJob({ id: 'j3', prompt: '进行中', status: 'running', results: [] }),
    ]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());
    expect(screen.getByTestId('library-card-j1')).toBeTruthy();
    expect(screen.getByTestId('library-card-j2')).toBeTruthy();
    expect(screen.queryByTestId('library-card-j3')).toBeNull();
    const image = screen.getByTestId('library-card-j1-image');
    expect(image.props.source.uri).toBe('https://api.test/outputs/a.png?token=t');
  });

  it('类型过滤 chips：计数正确，点按后只显示对应类型', async () => {
    const server = {
      jobs: [
        makeJob({ id: 'j1', kind: 'txt2img' }),
        makeJob({ id: 'j2', kind: 'wan_t2v', results: ['/outputs/v.mp4'] }),
        makeJob({ id: 'j3', kind: 'upscale', results: ['/outputs/c.png'] }),
      ],
    };
    mockJobsServer(server);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    // 全部 3 / 图像 2 / 视频 1
    const allChip = screen.getByTestId('filter-all');
    expect(allChip.props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('filter-image')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('filter-video'));
    // M16 服务端过滤：切换后重新查询，网格显示服务端过滤后的数据
    await waitFor(() => expect(screen.getByTestId('library-card-j2')).toBeTruthy());
    expect(screen.queryByTestId('library-card-j1')).toBeNull();
    expect(screen.queryByTestId('library-card-j3')).toBeNull();
  });

  it('过滤后且整体无作品：保持「该分类暂无作品」', async () => {
    mockListJobs.mockResolvedValue([]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('empty-library')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('filter-audio'));
    // M16 服务端过滤：切换后重新查询，等待加载完成
    await waitFor(() => expect(screen.getByText('该分类暂无作品')).toBeTruthy());
  });

  it('点按卡片打开产物详情', async () => {
    mockListJobs.mockResolvedValue([makeJob({ id: 'j1', prompt: '细节满满的猫' })]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-card-j1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('library-card-j1'));
    await waitFor(() => expect(screen.getByTestId('artifact-detail')).toBeTruthy());
    expect(screen.getByText('细节满满的猫')).toBeTruthy();
  });

  it('首屏按页大小 limit=50 + offset=0 拉取第一页', async () => {
    mockListJobs.mockResolvedValue([]);
    await renderScreen();
    await waitFor(() => expect(mockListJobs).toHaveBeenCalled());
    expect(LIBRARY_PAGE_SIZE).toBe(50);
    expect(mockListJobs).toHaveBeenCalledWith({ limit: 50, offset: 0, kind: '' });
  });

  it('FlatList 虚拟化参数就位（initialNumToRender/windowSize/removeClippedSubviews/onEndReachedThreshold）', async () => {
    mockListJobs.mockResolvedValue([makeJob({ id: 'j1' })]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());
    const grid = screen.getByTestId('library-grid');
    expect(grid.props.initialNumToRender).toBe(12);
    expect(grid.props.maxToRenderPerBatch).toBe(12);
    expect(grid.props.windowSize).toBe(7);
    expect(grid.props.removeClippedSubviews).toBe(true);
    expect(grid.props.onEndReachedThreshold).toBe(0.5);
  });

  it('onEndReached 追加下一页（offset=50），跨页重复 id 只保留一份', async () => {
    const server = { jobs: makeJobs('j', 60) };
    mockJobsServer(server);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());
    expect(gridData()).toHaveLength(50);
    expect(mockListJobs).toHaveBeenCalledTimes(1);

    // 模拟页边界漂移：第二页与第一页重叠一行（j49 已在第一页出现）
    mockListJobs.mockImplementation((options = {}) => {
      const { offset = 0, kind = '' } = options;
      if (offset === 50) {
        return Promise.resolve([makeJob({ id: 'j49' }), ...makeJobs('k', 10)]);
      }
      let filtered = server.jobs;
      if (kind) {
        const kinds = kind.split(',').map((k) => k.trim()).filter(Boolean);
        filtered = server.jobs.filter((j) => kinds.includes(j.kind));
      }
      return Promise.resolve(filtered.slice(offset, offset + 50));
    });
    await fireEvent(screen.getByTestId('library-grid'), 'onEndReached');
    await waitFor(() => expect(gridData()).toHaveLength(60));
    expect(mockListJobs).toHaveBeenCalledWith({ limit: 50, offset: 50, kind: '' });
    expect(gridData().filter((j) => j.id === 'j49')).toHaveLength(1);
    expect(gridData().map((j) => j.id)).toContain('k9');
  });

  it('加载下一页期间重复 onEndReached 不重入，footer 显示加载中', async () => {
    mockJobsServer({ jobs: makeJobs('j', 50) });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    let resolvePage2: ((jobs: JobItem[]) => void) | undefined;
    mockListJobs.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage2 = resolve;
        }),
    );
    // RNTL 14 的 fireEvent 是 async（内部 await act）：必须逐个 await，
    // 否则两个 act 作用域交错会污染后续用例（act 栈损坏 → 后续更新不冲刷）
    await fireEvent(screen.getByTestId('library-grid'), 'onEndReached');
    await fireEvent(screen.getByTestId('library-grid'), 'onEndReached');
    await waitFor(() => expect(screen.getByTestId('library-footer-loading')).toBeTruthy());
    // 首屏 + 首次 onEndReached，共 2 次请求（第二次 onEndReached 被防重入拦截）
    expect(mockListJobs).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvePage2?.([]);
    });
    await waitFor(() => expect(screen.getByTestId('library-footer-end')).toBeTruthy());
    expect(screen.getByText('没有更多了')).toBeTruthy();
  });

  it('首页不足页大小即到底：footer 显示「没有更多了」，onEndReached 不再发请求', async () => {
    mockJobsServer({ jobs: makeJobs('j', 3) });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-footer-end')).toBeTruthy());
    await fireEvent(screen.getByTestId('library-grid'), 'onEndReached');
    expect(mockListJobs).toHaveBeenCalledTimes(1);
  });

  it('下拉刷新重置 offset=0 重拉：抛弃已加载后续页，新作出现在顶部', async () => {
    const server = { jobs: makeJobs('j', 60) };
    mockJobsServer(server);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());
    await fireEvent(screen.getByTestId('library-grid'), 'onEndReached');
    await waitFor(() => expect(gridData()).toHaveLength(60));

    // 刷新时刻服务端顶部插入新作
    server.jobs = [makeJob({ id: 'fresh', prompt: '新作' }), ...server.jobs];
    await act(async () => {
      screen.getByTestId('library-grid').props.refreshControl.props.onRefresh();
    });
    await waitFor(() => {
      expect(gridData()[0].id).toBe('fresh');
      expect(gridData()).toHaveLength(50);
    });
    expect(mockListJobs).toHaveBeenLastCalledWith({ limit: 50, offset: 0, kind: '' });
  });

  it('「jobs」前缀失效（轮询/新完成作业）后重取：新作插入顶部且不重复', async () => {
    const server = { jobs: makeJobs('j', 60) };
    mockJobsServer(server);
    const { client } = await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());
    await fireEvent(screen.getByTestId('library-grid'), 'onEndReached');
    await waitFor(() => expect(gridData()).toHaveLength(60));

    server.jobs = [makeJob({ id: 'fresh', prompt: '刚完成' }), ...server.jobs];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] });
    });
    await waitFor(() => expect(gridData()[0].id).toBe('fresh'));
    const ids = gridData().map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('j59');
  });

  it('M16 服务端过滤：切换过滤桶时重置分页，按 kind 参数重新查询', async () => {
    const server = {
      jobs: [
        ...makeJobs('img', 50, { kind: 'txt2img' }),
        ...makeJobs('vid', 10, { kind: 'wan_t2v', results: ['/v.mp4'] }),
      ],
    };
    mockJobsServer(server);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    // 全部 60 条
    expect(gridData()).toHaveLength(50);
    expect(mockListJobs).toHaveBeenCalledWith({ limit: 50, offset: 0, kind: '' });

    // 切换到视频过滤桶：重新查询，只返回视频类型
    await fireEvent.press(screen.getByTestId('filter-video'));
    await waitFor(() => expect(gridData()).toHaveLength(10));
    expect(gridData().every((j) => j.kind === 'wan_t2v')).toBe(true);
    expect(mockListJobs).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      kind: expect.stringContaining('wan_t2v'),
    });

    // 切回全部：重新查询全部数据
    await fireEvent.press(screen.getByTestId('filter-all'));
    await waitFor(() => expect(gridData()).toHaveLength(50));
  });

  it('M16 服务端过滤：过滤后无匹配显示空态，继续加载无数据', async () => {
    const server = { jobs: makeJobs('j', 50) };
    mockJobsServer(server);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    // 切换到音频过滤桶：服务端返回空（没有音频类型作业）
    await fireEvent.press(screen.getByTestId('filter-audio'));
    await waitFor(() => expect(screen.getByTestId('empty-library')).toBeTruthy());
    expect(screen.getByText('该分类暂无作品')).toBeTruthy();
  });

  it('首屏加载失败显示错误态，点重试恢复', async () => {
    mockListJobs.mockRejectedValueOnce(new Error('boom'));
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-error')).toBeTruthy());
    expect(screen.getByText('作品库加载失败')).toBeTruthy();

    mockListJobs.mockResolvedValue([makeJob({ id: 'j1' })]);
    await fireEvent.press(screen.getByTestId('library-error-action'));
    await waitFor(() => expect(screen.getByTestId('library-card-j1')).toBeTruthy());
  });

  it('下一页加载失败：footer 提示加载失败，恢复后可继续加载', async () => {
    mockJobsServer({ jobs: makeJobs('j', 50) });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    mockListJobs.mockRejectedValueOnce(new Error('boom'));
    await fireEvent(screen.getByTestId('library-grid'), 'onEndReached');
    await waitFor(() => expect(screen.getByTestId('library-footer-error')).toBeTruthy());
    expect(screen.getByText('加载失败，上拉重试')).toBeTruthy();

    mockListJobs.mockResolvedValueOnce([makeJob({ id: 'x0' })]);
    await fireEvent(screen.getByTestId('library-grid'), 'onEndReached');
    await waitFor(() => expect(gridData().map((j) => j.id)).toContain('x0'));
  });
});

describe('M25 批量管理（多选模式 + 批量删除 + 批量保存相册）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // mockReset 清掉上个用例的实现（clearAllMocks 不清实现，防跨用例泄漏）
    mockDeleteJob.mockReset();
    mockDownload.mockReset();
    mockDownload.mockImplementation(async () => undefined);
  });

  it('「选择」钮进入选择模式：操作条出现，点卡片勾选而非打开详情', async () => {
    mockListJobs.mockResolvedValue([
      makeJob({ id: 'j1', prompt: '猫' }),
      makeJob({ id: 'j2', prompt: '狗', results: ['/outputs/b.png'] }),
    ]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('library-select-toggle'));
    expect(screen.getByTestId('library-batch-bar')).toBeTruthy();
    expect(screen.getByText('已选 0 项')).toBeTruthy();

    // 选择模式下点卡片 = 勾选，不打开详情
    await fireEvent.press(screen.getByTestId('library-card-j1'));
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    expect(screen.getByTestId('library-card-j1-check-mark')).toBeTruthy();
    expect(screen.queryByTestId('artifact-detail')).toBeNull();
    // 未选卡为空心圈（有圈无 Check 标记）
    expect(screen.getByTestId('library-card-j2-check')).toBeTruthy();
    expect(screen.queryByTestId('library-card-j2-check-mark')).toBeNull();
  });

  it('长按卡片直接进入选择模式并选中该卡（accent 细边框 + Check 标记）', async () => {
    mockListJobs.mockResolvedValue([
      makeJob({ id: 'j1', prompt: '猫' }),
      makeJob({ id: 'j2', prompt: '狗', results: ['/outputs/b.png'] }),
    ]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    // RNTL 14 无 fireEvent.longPress 便捷方法，用通用形式（M24 踩坑）
    await fireEvent(screen.getByTestId('library-card-j1'), 'longPress');
    expect(screen.getByTestId('library-batch-bar')).toBeTruthy();
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    expect(screen.getByTestId('library-card-j1-check-mark')).toBeTruthy();

    // 已选卡 accent 细边框：borderColor 与未选卡不同
    // （Pressable 会把函数 style 解析后传给宿主 View，兼容函数/对象/数组三种形态）
    const borderColorOf = (testID: string) => {
      const s = screen.getByTestId(testID).props.style;
      const resolved = typeof s === 'function' ? s({ pressed: false }) : s;
      const flat = Array.isArray(resolved) ? Object.assign({}, ...resolved) : resolved;
      return flat?.borderColor;
    };
    expect(borderColorOf('library-card-j1')).not.toBe(borderColorOf('library-card-j2'));
  });

  it('再点已选卡取消勾选，计数回落，选择模式保持', async () => {
    mockListJobs.mockResolvedValue([makeJob({ id: 'j1', prompt: '猫' })]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent(screen.getByTestId('library-card-j1'), 'longPress');
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('library-card-j1'));
    expect(screen.getByText('已选 0 项')).toBeTruthy();
    expect(screen.queryByTestId('library-card-j1-check-mark')).toBeNull();
    expect(screen.getByTestId('library-batch-bar')).toBeTruthy();
  });

  it('全选：选中当前已加载全部项', async () => {
    mockListJobs.mockResolvedValue([
      makeJob({ id: 'j1' }),
      makeJob({ id: 'j2', results: ['/outputs/b.png'] }),
      makeJob({ id: 'j3', results: ['/outputs/c.png'] }),
    ]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('library-select-toggle'));
    await fireEvent.press(screen.getByTestId('library-batch-select-all'));
    expect(screen.getByText('已选 3 项')).toBeTruthy();
    expect(screen.getByTestId('library-card-j1-check-mark')).toBeTruthy();
    expect(screen.getByTestId('library-card-j2-check-mark')).toBeTruthy();
    expect(screen.getByTestId('library-card-j3-check-mark')).toBeTruthy();
  });

  it('取消退出选择模式并清空勾选', async () => {
    mockListJobs.mockResolvedValue([makeJob({ id: 'j1' })]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent(screen.getByTestId('library-card-j1'), 'longPress');
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('library-batch-cancel'));
    expect(screen.queryByTestId('library-batch-bar')).toBeNull();

    // 重新进入：勾选已清空
    await fireEvent.press(screen.getByTestId('library-select-toggle'));
    expect(screen.getByText('已选 0 项')).toBeTruthy();
    expect(screen.queryByTestId('library-card-j1-check-mark')).toBeNull();
  });

  it('切换过滤桶清空并退出选择模式', async () => {
    const server = {
      jobs: [
        makeJob({ id: 'img', kind: 'txt2img' }),
        makeJob({ id: 'vid', kind: 'wan_t2v', results: ['/outputs/v.mp4'] }),
      ],
    };
    mockJobsServer(server);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent(screen.getByTestId('library-card-img'), 'longPress');
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('filter-video'));
    expect(screen.queryByTestId('library-batch-bar')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('library-card-vid')).toBeTruthy());

    // 重新进入：勾选已清空
    await fireEvent.press(screen.getByTestId('library-select-toggle'));
    expect(screen.getByText('已选 0 项')).toBeTruthy();
  });

  it('下拉刷新清空并退出选择模式', async () => {
    mockJobsServer({ jobs: makeJobs('j', 3) });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent(screen.getByTestId('library-card-j0'), 'longPress');
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    await act(async () => {
      screen.getByTestId('library-grid').props.refreshControl.props.onRefresh();
    });
    expect(screen.queryByTestId('library-batch-bar')).toBeNull();
  });

  it('批量删除全成：确认 Alert → 限速循环单删 → 汇总并退出，列表失效重取', async () => {
    const server = {
      jobs: [
        makeJob({ id: 'j1', prompt: '猫' }),
        makeJob({ id: 'j2', prompt: '狗', results: ['/outputs/b.png'] }),
        makeJob({ id: 'j3', prompt: '鸟', results: ['/outputs/c.png'] }),
      ],
    };
    mockJobsServer(server);
    // 假后端：单删成功即从列表移除（无批量端点，客户端循环 DELETE /api/jobs/{id}）
    mockDeleteJob.mockImplementation(async (id: string) => {
      server.jobs = server.jobs.filter((j) => j.id !== id);
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent(screen.getByTestId('library-card-j1'), 'longPress');
    await fireEvent.press(screen.getByTestId('library-card-j2'));
    expect(screen.getByText('已选 2 项')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('library-batch-delete'));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alertSpy.mock.calls[0];
    expect(String(title)).toContain('删除');
    expect(String(message)).toContain('2 项');
    // 取消钮存在（不触发删除）
    expect(buttons?.some((b) => b.style === 'cancel')).toBe(true);

    await act(async () => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await waitFor(() => expect(screen.getByText('已删除 2 项')).toBeTruthy());
    expect(mockDeleteJob).toHaveBeenCalledTimes(2);
    expect(mockDeleteJob).toHaveBeenCalledWith('j1');
    expect(mockDeleteJob).toHaveBeenCalledWith('j2');
    // 全成退出选择模式；失效重取后两项消失
    expect(screen.queryByTestId('library-batch-bar')).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId('library-card-j1')).toBeNull();
      expect(screen.queryByTestId('library-card-j2')).toBeNull();
    });
    expect(screen.getByTestId('library-card-j3')).toBeTruthy();
    alertSpy.mockRestore();
  });

  it('批量删除部分失败：失败项保留勾选，成功项移出列表', async () => {
    const server = {
      jobs: [
        makeJob({ id: 'j1', prompt: '猫' }),
        makeJob({ id: 'j2', prompt: '狗', results: ['/outputs/b.png'] }),
      ],
    };
    mockJobsServer(server);
    mockDeleteJob.mockImplementation(async (id: string) => {
      if (id === 'j2') throw new Error('服务暂时不可用，请稍后重试');
      server.jobs = server.jobs.filter((j) => j.id !== id);
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent(screen.getByTestId('library-card-j1'), 'longPress');
    await fireEvent.press(screen.getByTestId('library-card-j2'));
    await fireEvent.press(screen.getByTestId('library-batch-delete'));
    await act(async () => {
      alertSpy.mock.calls[0][2]?.find((b) => b.style === 'destructive')?.onPress?.();
    });

    await waitFor(() =>
      expect(screen.getByText('成功 1 项，失败 1 项，失败项已保留勾选')).toBeTruthy(),
    );
    // 不退出选择模式，失败项 j2 保留勾选
    expect(screen.getByTestId('library-batch-bar')).toBeTruthy();
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    expect(screen.getByTestId('library-card-j2-check-mark')).toBeTruthy();
    // 成功项 j1 失效重取后消失
    await waitFor(() => expect(screen.queryByTestId('library-card-j1')).toBeNull());
    alertSpy.mockRestore();
  });

  it('删除进度态：删除中 x/N，操作钮禁用，完成后汇总', async () => {
    const server = {
      jobs: [makeJob({ id: 'j1' }), makeJob({ id: 'j2', results: ['/outputs/b.png'] })],
    };
    mockJobsServer(server);
    const resolvers: (() => void)[] = [];
    mockDeleteJob.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(() => {
            server.jobs = server.jobs.filter((j) => j.id !== 'x');
            resolve();
          });
        }),
    );
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('library-select-toggle'));
    await fireEvent.press(screen.getByTestId('library-batch-select-all'));
    await fireEvent.press(screen.getByTestId('library-batch-delete'));
    await act(async () => {
      alertSpy.mock.calls[0][2]?.find((b) => b.style === 'destructive')?.onPress?.();
    });

    await waitFor(() => expect(screen.getByText('删除中 0/2')).toBeTruthy());
    expect(
      screen.getByTestId('library-batch-save').props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByTestId('library-batch-delete').props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByTestId('library-batch-cancel').props.accessibilityState.disabled,
    ).toBe(true);

    await act(async () => {
      resolvers.shift()?.();
    });
    await waitFor(() => expect(screen.getByText('删除中 1/2')).toBeTruthy());
    await act(async () => {
      resolvers.shift()?.();
    });
    await waitFor(() => expect(screen.getByText('已删除 2 项')).toBeTruthy());
    alertSpy.mockRestore();
  });

  it('批量保存分流：image/video 保存、audio 跳过计入汇总并保留勾选', async () => {
    const server = {
      jobs: [
        makeJob({ id: 'img', kind: 'txt2img', results: ['/outputs/a.png'] }),
        makeJob({ id: 'vid', kind: 'wan_t2v', results: ['/outputs/v.mp4'] }),
        makeJob({ id: 'aud', kind: 'ace_audio', results: ['/outputs/a.mp3'] }),
      ],
    };
    mockJobsServer(server);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('library-select-toggle'));
    await fireEvent.press(screen.getByTestId('library-batch-select-all'));
    expect(screen.getByText('已选 3 项')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('library-batch-save'));

    await waitFor(() =>
      expect(screen.getByText('已保存 2 项到相册，跳过 1 项不支持的类型')).toBeTruthy(),
    );
    // 仅 image/video 走下载封装（URL 拼 token），audio 不下载
    expect(mockDownload).toHaveBeenCalledTimes(2);
    expect(mockDownload).toHaveBeenCalledWith('https://api.test/outputs/a.png?token=t');
    expect(mockDownload).toHaveBeenCalledWith('https://api.test/outputs/v.mp4?token=t');
    // 跳过的 audio 保留勾选，不退出选择模式
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    expect(screen.getByTestId('library-card-aud-check-mark')).toBeTruthy();
  });

  it('保存进度态：保存中 x/N，完成后汇总并退出', async () => {
    mockJobsServer({
      jobs: [
        makeJob({ id: 'j1', results: ['/outputs/a.png'] }),
        makeJob({ id: 'j2', results: ['/outputs/b.png'] }),
      ],
    });
    const resolvers: (() => void)[] = [];
    mockDownload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('library-grid')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('library-select-toggle'));
    await fireEvent.press(screen.getByTestId('library-batch-select-all'));
    await fireEvent.press(screen.getByTestId('library-batch-save'));

    await waitFor(() => expect(screen.getByText('保存中 0/2')).toBeTruthy());
    expect(
      screen.getByTestId('library-batch-save').props.accessibilityState.disabled,
    ).toBe(true);

    await act(async () => {
      resolvers.forEach((r) => r());
    });
    await waitFor(() => expect(screen.getByText('已保存 2 项到相册')).toBeTruthy());
    // 全成退出选择模式
    expect(screen.queryByTestId('library-batch-bar')).toBeNull();
  });
});
