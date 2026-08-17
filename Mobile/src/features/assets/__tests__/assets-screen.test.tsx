import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { assetColumnCount, AssetsScreen } from '../assets-screen';
import { deleteAsset, listAssets } from '@/lib/api';
import type { AssetItem } from '@/types/api';

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

// expo-image 原生组件在 jest 不可断言 props，替身透传
jest.mock('expo-image', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Image: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

// expo-router 真身依赖原生导航栈，替身隔离跳转断言
const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
}));

jest.mock('@/lib/api', () => ({
  listAssets: jest.fn(),
  deleteAsset: jest.fn(),
  assetImageUrl: (id: string, index: number) =>
    `https://api.test/api/assets/${id}/images/${index}?token=t`,
}));

const mockListAssets = listAssets as jest.MockedFunction<typeof listAssets>;
const mockDeleteAsset = deleteAsset as jest.MockedFunction<typeof deleteAsset>;

function makeAsset(overrides: Partial<AssetItem>): AssetItem {
  return {
    id: 'as-1',
    kind: 'character',
    name: '女主-A',
    description: '银发蓝瞳',
    images: [
      { filename: 'a.png', worker: 'http://w1' },
      { filename: 'b.png', worker: 'http://w1' },
    ],
    nsfw: false,
    created_at: '2026-08-14T10:00:00',
    updated_at: '2026-08-14T10:00:00',
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
        <AssetsScreen />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(tree as ReactElement);
}

describe('assetColumnCount 断点（与作品库同源，指南 7.1）', () => {
  it('phone 2 列 / 大屏 3 列 / 平板 4 列', () => {
    expect(assetColumnCount(390)).toBe(2);
    expect(assetColumnCount(431)).toBe(3);
    expect(assetColumnCount(768)).toBe(4);
  });
});

describe('AssetsScreen（参考资产库列表，M13.2）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListAssets.mockResolvedValue([]);
  });

  it('渲染标题 + 过滤 chips；初始缺省 kind 查询', async () => {
    await renderScreen();
    expect(screen.getByText('参考资产库')).toBeTruthy();
    expect(screen.getByTestId('asset-filter-all')).toBeTruthy();
    expect(screen.getByTestId('asset-filter-character')).toBeTruthy();
    expect(screen.getByTestId('asset-filter-scene')).toBeTruthy();
    expect(screen.getByTestId('asset-filter-prop')).toBeTruthy();
    expect(screen.getByTestId('asset-filter-style')).toBeTruthy();
    await waitFor(() => expect(mockListAssets).toHaveBeenCalledWith(undefined));
  });

  it('点过滤 chip 按 kind 重新查询（服务端 ?kind= 过滤）', async () => {
    await renderScreen();
    await waitFor(() => expect(mockListAssets).toHaveBeenCalledWith(undefined));
    await fireEvent.press(screen.getByTestId('asset-filter-character'));
    await waitFor(() => expect(mockListAssets).toHaveBeenCalledWith('character'));
  });

  it('空态（全部）：引导文案 + 新建按钮跳 /assets/edit', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('empty-assets')).toBeTruthy());
    expect(screen.getByText('还没有参考资产')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('empty-assets-action'));
    expect(mockPush).toHaveBeenCalledWith('/assets/edit');
  });

  it('空态（分类过滤后）：文案切换且不渲染新建引导', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('empty-assets')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('asset-filter-scene'));
    await waitFor(() => expect(screen.getByText('该分类暂无资产')).toBeTruthy());
    expect(screen.queryByTestId('empty-assets-action')).toBeNull();
  });

  it('头部新建按钮跳 /assets/edit；返回按钮回退', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('assets-new'));
    expect(mockPush).toHaveBeenCalledWith('/assets/edit');
    await fireEvent.press(screen.getByTestId('assets-back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('资产卡片渲染：名称 / kind 标签 / 图片数角标 / R18 徽标', async () => {
    mockListAssets.mockResolvedValue([
      makeAsset({ id: 'as-1' }),
      makeAsset({
        id: 'as-2',
        name: '赛博街道',
        kind: 'scene',
        nsfw: true,
        images: [{ filename: 'c.png', worker: 'http://w2' }],
      }),
    ]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());
    expect(screen.getByText('女主-A')).toBeTruthy();
    // 过滤 chip 也有「角色」文案，限定卡片作用域断言 kind 徽标
    expect(within(screen.getByTestId('asset-card-as-1')).getByText('角色')).toBeTruthy();
    // 多图角标 ×2；单图资产不渲染角标
    expect(screen.getByTestId('asset-card-as-1-count')).toBeTruthy();
    expect(screen.getByText('×2')).toBeTruthy();
    expect(screen.queryByTestId('asset-card-as-2-count')).toBeNull();
    // R18 徽标仅 nsfw 资产
    expect(screen.getByTestId('asset-card-as-2-r18')).toBeTruthy();
    expect(screen.queryByTestId('asset-card-as-1-r18')).toBeNull();
  });

  it('点资产卡片跳编辑页并携带 id', async () => {
    mockListAssets.mockResolvedValue([makeAsset({ id: 'as-9' })]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-9')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('asset-card-as-9'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/assets/edit', params: { id: 'as-9' } });
  });
});

describe('M27 批量管理（多选模式 + 批量删除）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // mockReset 清掉上个用例的实现（clearAllMocks 不清实现，防跨用例泄漏，M25 踩坑）
    mockListAssets.mockReset();
    mockListAssets.mockResolvedValue([]);
    mockDeleteAsset.mockReset();
    mockDeleteAsset.mockResolvedValue(undefined);
  });

  function threeAssets(): AssetItem[] {
    return [
      makeAsset({ id: 'as-1', name: '女主-A' }),
      makeAsset({
        id: 'as-2',
        name: '赛博街道',
        kind: 'scene',
        images: [{ filename: 'c.png', worker: 'http://w2' }],
      }),
      makeAsset({
        id: 'as-3',
        name: '法杖',
        kind: 'prop',
        images: [{ filename: 'd.png', worker: 'http://w1' }],
      }),
    ];
  }

  it('「选择」钮进入选择模式：操作条出现且头部入口隐藏，点卡切换勾选而非进编辑', async () => {
    mockListAssets.mockResolvedValue(threeAssets());
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());

    expect(screen.getByTestId('assets-select-toggle')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('assets-select-toggle'));
    expect(screen.getByTestId('assets-batch-bar')).toBeTruthy();
    expect(screen.getByText('已选 0 项')).toBeTruthy();
    // 选择态下头部「新建/选择」入口隐藏（退出靠操作条取消，对齐作品库）
    expect(screen.queryByTestId('assets-select-toggle')).toBeNull();
    expect(screen.queryByTestId('assets-new')).toBeNull();

    // 选择模式下点卡 = 切换勾选，不进编辑
    await fireEvent.press(screen.getByTestId('asset-card-as-1'));
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    expect(screen.getByTestId('asset-card-as-1-check-mark')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    // 未选卡为空心圈（有圈无 Check 标记）
    expect(screen.getByTestId('asset-card-as-2-check')).toBeTruthy();
    expect(screen.queryByTestId('asset-card-as-2-check-mark')).toBeNull();

    // 再点已选卡取消勾选，计数回落，选择模式保持
    await fireEvent.press(screen.getByTestId('asset-card-as-1'));
    expect(screen.getByText('已选 0 项')).toBeTruthy();
    expect(screen.queryByTestId('asset-card-as-1-check-mark')).toBeNull();
    expect(screen.getByTestId('assets-batch-bar')).toBeTruthy();
  });

  it('长按卡片直接进入选择模式并选中该卡（accent 描边 + 左上选择圈 Check）', async () => {
    mockListAssets.mockResolvedValue(threeAssets());
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());

    // RNTL 14 无 fireEvent.longPress 便捷方法，用通用形式（M24 踩坑）
    await fireEvent(screen.getByTestId('asset-card-as-1'), 'longPress');
    expect(screen.getByTestId('assets-batch-bar')).toBeTruthy();
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    expect(screen.getByTestId('asset-card-as-1-check-mark')).toBeTruthy();

    // 已选卡 accent 描边：borderColor 与未选卡不同（兼容函数/对象/数组 style 形态，M25 踩坑）
    const borderColorOf = (testID: string) => {
      const s = screen.getByTestId(testID).props.style;
      const resolved = typeof s === 'function' ? s({ pressed: false }) : s;
      const flat = Array.isArray(resolved) ? Object.assign({}, ...resolved) : resolved;
      return flat?.borderColor;
    };
    expect(borderColorOf('asset-card-as-1')).not.toBe(borderColorOf('asset-card-as-2'));
  });

  it('取消退出选择模式并清空勾选，头部入口恢复', async () => {
    mockListAssets.mockResolvedValue([makeAsset({ id: 'as-1' })]);
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());

    await fireEvent(screen.getByTestId('asset-card-as-1'), 'longPress');
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('assets-batch-cancel'));
    expect(screen.queryByTestId('assets-batch-bar')).toBeNull();
    expect(screen.getByTestId('assets-new')).toBeTruthy();

    // 重新进入：勾选已清空
    await fireEvent.press(screen.getByTestId('assets-select-toggle'));
    expect(screen.getByText('已选 0 项')).toBeTruthy();
    expect(screen.queryByTestId('asset-card-as-1-check-mark')).toBeNull();
  });

  it('全选选中当前列表全部项；未勾选时删除钮禁用', async () => {
    mockListAssets.mockResolvedValue(threeAssets());
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('assets-select-toggle'));
    // N=0：删除禁用
    expect(
      screen.getByTestId('assets-batch-delete').props.accessibilityState.disabled,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('assets-batch-select-all'));
    expect(screen.getByText('已选 3 项')).toBeTruthy();
    expect(screen.getByTestId('asset-card-as-1-check-mark')).toBeTruthy();
    expect(screen.getByTestId('asset-card-as-2-check-mark')).toBeTruthy();
    expect(screen.getByTestId('asset-card-as-3-check-mark')).toBeTruthy();
    expect(
      screen.getByTestId('assets-batch-delete').props.accessibilityState.disabled,
    ).toBe(false);
  });

  it('切换 kind 过滤清空并退出选择模式（对齐作品库切桶语义）', async () => {
    mockListAssets.mockImplementation((kind?: string) =>
      Promise.resolve(threeAssets().filter((a) => !kind || a.kind === kind)),
    );
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());

    await fireEvent(screen.getByTestId('asset-card-as-1'), 'longPress');
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('asset-filter-scene'));
    expect(screen.queryByTestId('assets-batch-bar')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-2')).toBeTruthy());
    expect(screen.queryByTestId('asset-card-as-1')).toBeNull();

    // 重新进入：勾选已清空
    await fireEvent.press(screen.getByTestId('assets-select-toggle'));
    expect(screen.getByText('已选 0 项')).toBeTruthy();
  });

  it('批量删除全成：确认 Alert → 循环单删 → 失效重取 → 汇总并退出选择模式', async () => {
    const server = { assets: threeAssets() };
    mockListAssets.mockImplementation((kind?: string) =>
      Promise.resolve(server.assets.filter((a) => !kind || a.kind === kind)),
    );
    // 假后端：单删成功即从列表移除（无批量端点，客户端循环 DELETE /api/assets/{id}）
    mockDeleteAsset.mockImplementation(async (id: string) => {
      server.assets = server.assets.filter((a) => a.id !== id);
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());

    await fireEvent(screen.getByTestId('asset-card-as-1'), 'longPress');
    await fireEvent.press(screen.getByTestId('asset-card-as-2'));
    expect(screen.getByText('已选 2 项')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('assets-batch-delete'));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alertSpy.mock.calls[0];
    expect(String(title)).toContain('删除');
    expect(String(message)).toContain('2 项');
    expect(String(message)).toContain('worker 上的图片文件保留');
    // 取消钮存在（不触发删除）
    expect(buttons?.some((b) => b.style === 'cancel')).toBe(true);

    await act(async () => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await waitFor(() => expect(screen.getByText('已删除 2 项')).toBeTruthy());
    expect(mockDeleteAsset).toHaveBeenCalledTimes(2);
    expect(mockDeleteAsset).toHaveBeenCalledWith('as-1');
    expect(mockDeleteAsset).toHaveBeenCalledWith('as-2');
    // 全成退出选择模式；失效重取后两项消失
    expect(screen.queryByTestId('assets-batch-bar')).toBeNull();
    await waitFor(() => {
      expect(screen.queryByTestId('asset-card-as-1')).toBeNull();
      expect(screen.queryByTestId('asset-card-as-2')).toBeNull();
    });
    expect(screen.getByTestId('asset-card-as-3')).toBeTruthy();
    alertSpy.mockRestore();
  });

  it('批量删除部分失败：失败项保留勾选停留选择模式，成功项移出列表', async () => {
    const server = { assets: threeAssets() };
    mockListAssets.mockImplementation((kind?: string) =>
      Promise.resolve(server.assets.filter((a) => !kind || a.kind === kind)),
    );
    mockDeleteAsset.mockImplementation(async (id: string) => {
      if (id === 'as-2') throw new Error('服务暂时不可用，请稍后重试');
      server.assets = server.assets.filter((a) => a.id !== id);
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());

    await fireEvent(screen.getByTestId('asset-card-as-1'), 'longPress');
    await fireEvent.press(screen.getByTestId('asset-card-as-2'));
    await fireEvent.press(screen.getByTestId('assets-batch-delete'));
    await act(async () => {
      alertSpy.mock.calls[0][2]?.find((b) => b.style === 'destructive')?.onPress?.();
    });

    await waitFor(() =>
      expect(screen.getByText('成功 1 项，失败 1 项，失败项已保留勾选')).toBeTruthy(),
    );
    // 不退出选择模式，失败项 as-2 保留勾选
    expect(screen.getByTestId('assets-batch-bar')).toBeTruthy();
    expect(screen.getByText('已选 1 项')).toBeTruthy();
    expect(screen.getByTestId('asset-card-as-2-check-mark')).toBeTruthy();
    // 成功项 as-1 失效重取后消失
    await waitFor(() => expect(screen.queryByTestId('asset-card-as-1')).toBeNull());
    alertSpy.mockRestore();
  });

  it('删除进度态：删除中 x/N，操作钮禁用防重复点，完成后汇总退出', async () => {
    const server = { assets: threeAssets().slice(0, 2) };
    mockListAssets.mockImplementation(() => Promise.resolve(server.assets));
    const resolvers: (() => void)[] = [];
    mockDeleteAsset.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-card-as-1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('assets-select-toggle'));
    await fireEvent.press(screen.getByTestId('assets-batch-select-all'));
    await fireEvent.press(screen.getByTestId('assets-batch-delete'));
    await act(async () => {
      alertSpy.mock.calls[0][2]?.find((b) => b.style === 'destructive')?.onPress?.();
    });

    await waitFor(() => expect(screen.getByText('删除中 0/2')).toBeTruthy());
    expect(
      screen.getByTestId('assets-batch-delete').props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByTestId('assets-batch-cancel').props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByTestId('assets-batch-select-all').props.accessibilityState.disabled,
    ).toBe(true);

    await act(async () => {
      resolvers.shift()?.();
    });
    await waitFor(() => expect(screen.getByText('删除中 1/2')).toBeTruthy());
    await act(async () => {
      resolvers.shift()?.();
    });
    await waitFor(() => expect(screen.getByText('已删除 2 项')).toBeTruthy());
    expect(screen.queryByTestId('assets-batch-bar')).toBeNull();
    alertSpy.mockRestore();
  });
});
