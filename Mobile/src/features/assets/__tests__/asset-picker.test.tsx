import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AssetPicker } from '../asset-picker';
import { listAssets } from '@/lib/api';
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

jest.mock('@/lib/api', () => ({
  listAssets: jest.fn(),
  assetImageUrl: (id: string, index: number) =>
    `https://api.test/api/assets/${id}/images/${index}?token=t`,
}));

const mockListAssets = listAssets as jest.MockedFunction<typeof listAssets>;

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

async function renderPicker(visible = true) {
  const onSelect = jest.fn();
  const onClose = jest.fn();
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
        <AssetPicker visible={visible} onClose={onClose} onSelect={onSelect} testID="picker" />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  await render(tree as ReactElement);
  return { onSelect, onClose };
}

describe('AssetPicker（资产选择器，M13.3）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListAssets.mockResolvedValue([]);
  });

  it('渲染 kind 过滤 chips（全部/角色/场景/道具/风格）', async () => {
    await renderPicker();
    expect(screen.getByTestId('picker-filter-all')).toBeTruthy();
    expect(screen.getByTestId('picker-filter-character')).toBeTruthy();
    expect(screen.getByTestId('picker-filter-scene')).toBeTruthy();
    expect(screen.getByTestId('picker-filter-prop')).toBeTruthy();
    expect(screen.getByTestId('picker-filter-style')).toBeTruthy();
  });

  it('visible=false 时不发起列表请求（抽屉关闭不后台轮询）', () => {
    renderPicker(false);
    expect(mockListAssets).not.toHaveBeenCalled();
  });

  it('资产行渲染：名称 / kind 标签 / 图片数；nsfw 资产带 R18 徽标', async () => {
    mockListAssets.mockResolvedValue([
      makeAsset({ id: 'as-1' }),
      makeAsset({ id: 'as-2', name: '霓虹街道', kind: 'scene', nsfw: true, images: [{ filename: 'c.png', worker: 'http://w2' }] }),
    ]);
    await renderPicker();
    await waitFor(() => expect(screen.getByTestId('picker-asset-as-1')).toBeTruthy());
    expect(screen.getByText('女主-A')).toBeTruthy();
    expect(screen.getByText('角色 · 2 张')).toBeTruthy();
    expect(screen.getByText('霓虹街道')).toBeTruthy();
    expect(screen.getByText('场景 · 1 张')).toBeTruthy();
    expect(screen.getByTestId('picker-asset-as-2-r18')).toBeTruthy();
    expect(screen.queryByTestId('picker-asset-as-1-r18')).toBeNull();
  });

  it('点过滤 chip 后按 kind 重新查询（服务端过滤）', async () => {
    await renderPicker();
    await waitFor(() => expect(mockListAssets).toHaveBeenCalledWith(undefined));
    await fireEvent.press(screen.getByTestId('picker-filter-style'));
    await waitFor(() => expect(mockListAssets).toHaveBeenCalledWith('style'));
  });

  it('点资产行展开其 1-4 张图，再点收起', async () => {
    mockListAssets.mockResolvedValue([makeAsset({ id: 'as-1' })]);
    await renderPicker();
    await waitFor(() => expect(screen.getByTestId('picker-asset-as-1')).toBeTruthy());
    // 初始收起
    expect(screen.queryByTestId('picker-image-as-1-0')).toBeNull();
    await fireEvent.press(screen.getByTestId('picker-asset-as-1'));
    expect(screen.getByTestId('picker-image-as-1-0')).toBeTruthy();
    expect(screen.getByTestId('picker-image-as-1-1')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('picker-asset-as-1'));
    expect(screen.queryByTestId('picker-image-as-1-0')).toBeNull();
  });

  it('点选资产图回填 {filename, worker, previewUri, name} 句柄并关闭（不重新上传）', async () => {
    mockListAssets.mockResolvedValue([makeAsset({ id: 'as-1' })]);
    const { onSelect, onClose } = await renderPicker();
    await waitFor(() => expect(screen.getByTestId('picker-asset-as-1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('picker-asset-as-1'));
    await fireEvent.press(screen.getByTestId('picker-image-as-1-1'));
    expect(onSelect).toHaveBeenCalledWith({
      filename: 'b.png',
      worker: 'http://w1',
      previewUri: 'https://api.test/api/assets/as-1/images/1?token=t',
      name: '女主-A · 图2',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('空库文案引导去「我的 → 参考资产库」新建；分类空态文案区分', async () => {
    await renderPicker();
    await waitFor(() => expect(screen.getByTestId('picker-empty')).toBeTruthy());
    expect(screen.getByText('资产库为空，先去「我的 → 参考资产库」新建')).toBeTruthy();
    // 切到分类过滤后的空态
    await fireEvent.press(screen.getByTestId('picker-filter-prop'));
    await waitFor(() => expect(screen.getByText('该分类暂无资产')).toBeTruthy());
  });

  it('点关闭按钮与背景蒙层均触发 onClose', async () => {
    const { onClose } = await renderPicker();
    await fireEvent.press(screen.getByTestId('picker-close'));
    await fireEvent.press(screen.getByTestId('picker-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
