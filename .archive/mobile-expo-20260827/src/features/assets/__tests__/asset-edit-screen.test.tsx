import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AssetEditScreen } from '../asset-edit-screen';
import { buildAssetPrefillParam } from '../asset-prefill';
import { createAsset, deleteAsset, getAsset, updateAsset, uploadImage } from '@/lib/api';
import { useSettingsStore } from '@/stores/settings';
import { DEFAULT_PALETTE_ID } from '@/theme/tokens';
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

// 相册选择在 jest 无原生实现：用例按需 mockResolvedValue 构造 asset
const mockLaunchImageLibraryAsync = jest.fn();
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibraryAsync(...args),
}));

// expo-router 真身依赖原生导航栈，替身隔离；mockParams 按用例切换新建/编辑态
const mockBack = jest.fn();
let mockParams: { id?: string; prefill?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@/lib/api', () => ({
  assetImageUrl: (id: string, index: number) =>
    `https://api.test/api/assets/${id}/images/${index}?token=t`,
  createAsset: jest.fn(),
  deleteAsset: jest.fn(),
  getAsset: jest.fn(),
  updateAsset: jest.fn(),
  uploadImage: jest.fn(),
  setNsfwIntent: jest.fn(),
}));

jest.mock('@/lib/config', () => ({
  setApiBaseOverride: jest.fn(),
}));

const mockCreateAsset = createAsset as jest.MockedFunction<typeof createAsset>;
const mockDeleteAsset = deleteAsset as jest.MockedFunction<typeof deleteAsset>;
const mockGetAsset = getAsset as jest.MockedFunction<typeof getAsset>;
const mockUpdateAsset = updateAsset as jest.MockedFunction<typeof updateAsset>;
const mockUploadImage = uploadImage as jest.MockedFunction<typeof uploadImage>;

const SAMPLE: AssetItem = {
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
};

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
        <AssetEditScreen />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(tree as ReactElement);
}

/** 选一张合法图并等待上传完成落进表单 */
async function pickOneImage() {
  mockLaunchImageLibraryAsync.mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: 'file:///tmp/x.png', fileName: 'x.png', mimeType: 'image/png' }],
  });
  mockUploadImage.mockResolvedValueOnce({ filename: 'up-x.png', worker: 'http://w1' });
  await fireEvent.press(screen.getByTestId('asset-edit-pick'));
  await waitFor(() => expect(screen.getByTestId('asset-edit-item-0')).toBeTruthy());
}

describe('AssetEditScreen 新建态（M13.2）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = {};
    useSettingsStore.setState({ paletteId: DEFAULT_PALETTE_ID, mode: 'light', nsfwIntent: false });
  });

  it('渲染「新建资产」标题，不发起单查请求', async () => {
    await renderScreen();
    expect(screen.getByTestId('asset-edit-title')).toBeTruthy();
    expect(screen.getByText('新建资产')).toBeTruthy();
    expect(mockGetAsset).not.toHaveBeenCalled();
  });

  it('本地先验：名称为空拦截；有名称无图拦截；均不发创建请求', async () => {
    await renderScreen();
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    expect(screen.getByText('请填写资产名称')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('asset-edit-name-input'), '女主-A');
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    expect(screen.getByText('请至少添加 1 张参考图')).toBeTruthy();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('选图客户端先验：gif 拒绝（扩展名白名单与 upload.py 同源）', async () => {
    await renderScreen();
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/a.gif', fileName: 'a.gif', mimeType: 'image/gif' }],
    });
    await fireEvent.press(screen.getByTestId('asset-edit-pick'));
    expect(screen.getByText('仅支持 jpg / png / webp 图片')).toBeTruthy();
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  it('多选两张：第一张自由落点，第二张钉第一张落点 worker（互钉）', async () => {
    await renderScreen();
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: 'file:///tmp/a.png', fileName: 'a.png', mimeType: 'image/png' },
        { uri: 'file:///tmp/b.png', fileName: 'b.png', mimeType: 'image/png' },
      ],
    });
    mockUploadImage
      .mockResolvedValueOnce({ filename: 'up-a.png', worker: 'http://w7' })
      .mockResolvedValueOnce({ filename: 'up-b.png', worker: 'http://w7' });
    await fireEvent.press(screen.getByTestId('asset-edit-pick'));
    await waitFor(() => expect(screen.getByTestId('asset-edit-item-1')).toBeTruthy());
    expect(mockUploadImage).toHaveBeenNthCalledWith(
      1,
      { uri: 'file:///tmp/a.png', fileName: 'a.png', mimeType: 'image/png' },
      'img2img',
      undefined,
    );
    expect(mockUploadImage).toHaveBeenNthCalledWith(
      2,
      { uri: 'file:///tmp/b.png', fileName: 'b.png', mimeType: 'image/png' },
      'img2img',
      'http://w7',
    );
  });

  it('创建流：kind 切换 + 名称 + 描述 + 1 图 → createAsset 请求体正确 → 返回', async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('asset-edit-name-input'), '霓虹街道');
    await fireEvent.press(screen.getByTestId('asset-kind-scene'));
    await fireEvent.changeText(screen.getByTestId('asset-edit-desc-input'), '雨后夜景');
    await pickOneImage();
    mockCreateAsset.mockResolvedValueOnce(SAMPLE);
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockCreateAsset).toHaveBeenCalledWith({
      kind: 'scene',
      name: '霓虹街道',
      description: '雨后夜景',
      images: [{ filename: 'up-x.png', worker: 'http://w1' }],
      nsfw: false,
    });
    expect(mockUpdateAsset).not.toHaveBeenCalled();
  });

  it('创建失败展示后端人话，不返回', async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('asset-edit-name-input'), '女主-A');
    await pickOneImage();
    mockCreateAsset.mockRejectedValueOnce(new Error('参考图最多 4 张'));
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    await waitFor(() => expect(screen.getByText('参考图最多 4 张')).toBeTruthy());
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('SFW 上下文（nsfwIntent=false）不渲染 R18 开关', async () => {
    await renderScreen();
    expect(screen.queryByTestId('asset-nsfw-row')).toBeNull();
  });

  it('R18 上下文（nsfwIntent=true）渲染开关，开启后随创建落库', async () => {
    useSettingsStore.setState({ nsfwIntent: true });
    await renderScreen();
    expect(screen.getByTestId('asset-nsfw-row')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('asset-edit-name-input'), '女主-A');
    await pickOneImage();
    await fireEvent(screen.getByTestId('asset-nsfw-switch'), 'valueChange', true);
    mockCreateAsset.mockResolvedValueOnce({ ...SAMPLE, nsfw: true });
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    await waitFor(() => expect(mockCreateAsset).toHaveBeenCalled());
    expect(mockCreateAsset.mock.calls[0][0].nsfw).toBe(true);
  });
});

describe('AssetEditScreen 编辑态（M13.2）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { id: 'as-1' };
    useSettingsStore.setState({ paletteId: DEFAULT_PALETTE_ID, mode: 'light', nsfwIntent: false });
    mockGetAsset.mockResolvedValue(SAMPLE);
  });

  it('getAsset 回显：标题/名称/kind 选中/描述/图片数', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByText('编辑资产')).toBeTruthy());
    expect(mockGetAsset).toHaveBeenCalledWith('as-1');
    await waitFor(() =>
      expect(screen.getByTestId('asset-edit-name-input').props.value).toBe('女主-A'),
    );
    expect(screen.getByTestId('asset-edit-desc-input').props.value).toBe('银发蓝瞳');
    // kind 选中态
    expect(screen.getByTestId('asset-kind-character').props.accessibilityState.selected).toBe(true);
    // 两张参考图回显（远程代理预览）
    expect(screen.getByTestId('asset-edit-item-0')).toBeTruthy();
    expect(screen.getByTestId('asset-edit-item-1')).toBeTruthy();
    expect(screen.getByText('参考图(2/4)')).toBeTruthy();
    // 编辑态渲染删除按钮
    expect(screen.getByTestId('asset-edit-delete')).toBeTruthy();
  });

  it('部分更新映射：仅改名 → PATCH 只携带 name', async () => {
    await renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('asset-edit-name-input').props.value).toBe('女主-A'),
    );
    await fireEvent.changeText(screen.getByTestId('asset-edit-name-input'), '女主-B');
    mockUpdateAsset.mockResolvedValueOnce({ ...SAMPLE, name: '女主-B' });
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockUpdateAsset).toHaveBeenCalledWith('as-1', { name: '女主-B' });
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('无变化时点保存不发 PATCH，直接返回（省一次往返）', async () => {
    await renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('asset-edit-name-input').props.value).toBe('女主-A'),
    );
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockUpdateAsset).not.toHaveBeenCalled();
  });

  it('移除一张已回显图片 → PATCH 携带缩减后的 images', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-edit-item-1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('asset-edit-remove-1'));
    expect(screen.getByText('参考图(1/4)')).toBeTruthy();
    mockUpdateAsset.mockResolvedValueOnce({
      ...SAMPLE,
      images: [{ filename: 'a.png', worker: 'http://w1' }],
    });
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    await waitFor(() => expect(mockUpdateAsset).toHaveBeenCalled());
    expect(mockUpdateAsset).toHaveBeenCalledWith('as-1', {
      images: [{ filename: 'a.png', worker: 'http://w1' }],
    });
  });

  it('删除流：确认 Alert → deleteAsset → 返回列表刷新', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-edit-delete')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('asset-edit-delete'));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [, message, buttons] = alertSpy.mock.calls[0];
    expect(String(message)).toContain('女主-A');
    // 点「取消」不触发删除
    const cancel = buttons?.find((b) => b.text === '取消');
    expect(cancel).toBeTruthy();
    // 模拟确认删除
    mockDeleteAsset.mockResolvedValueOnce(undefined);
    const destructive = buttons?.find((b) => b.style === 'destructive');
    await destructive?.onPress?.();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockDeleteAsset).toHaveBeenCalledWith('as-1');
    alertSpy.mockRestore();
  });

  it('单查 404（他人资产防枚举）展示加载错误', async () => {
    mockGetAsset.mockRejectedValueOnce(new Error('资源不存在或已被清理'));
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('asset-edit-load-error')).toBeTruthy());
    expect(screen.getByText('资源不存在或已被清理')).toBeTruthy();
  });
});

describe('AssetEditScreen 预填（M28 产物存为资产）', () => {
  const PREFILL = buildAssetPrefillParam({
    filename: 'up-a.png',
    worker: 'http://w1',
    preview: 'https://api.test/outputs/a.png?token=t',
    prompt: '一只在月球上的猫',
    nsfw: true,
  });

  beforeEach(() => {
    // 与既有 describe 平级：自带 clearAllMocks + mockReset 防跨 describe 泄漏（M27 踩坑）
    jest.clearAllMocks();
    mockGetAsset.mockReset();
    mockParams = {};
    useSettingsStore.setState({ paletteId: DEFAULT_PALETTE_ID, mode: 'light', nsfwIntent: false });
  });

  it('新建带 prefill：名称/图片计数/缩略图预览/nsfw 开关预填', async () => {
    useSettingsStore.setState({ nsfwIntent: true });
    mockParams = { prefill: PREFILL };
    await renderScreen();
    expect(screen.getByText('新建资产')).toBeTruthy();
    expect(screen.getByTestId('asset-edit-name-input').props.value).toBe('一只在月球上的猫');
    expect(screen.getByText('参考图(1/4)')).toBeTruthy();
    expect(screen.getByTestId('asset-edit-thumb-0').props.source.uri).toBe(
      'https://api.test/outputs/a.png?token=t',
    );
    expect(screen.getByTestId('asset-nsfw-switch').props.value).toBe(true);
    // 预填非编辑态：不发起单查
    expect(mockGetAsset).not.toHaveBeenCalled();
  });

  it('新建带 prefill 直接保存：走 createAsset 且 images 含预填句柄', async () => {
    mockParams = { prefill: PREFILL };
    await renderScreen();
    mockCreateAsset.mockResolvedValueOnce({ ...SAMPLE, nsfw: true });
    await fireEvent.press(screen.getByTestId('asset-edit-save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockCreateAsset).toHaveBeenCalledWith({
      kind: 'character',
      name: '一只在月球上的猫',
      description: '',
      images: [{ filename: 'up-a.png', worker: 'http://w1' }],
      nsfw: true,
    });
    expect(mockUpdateAsset).not.toHaveBeenCalled();
  });

  it('畸形 prefill 静默忽略：按空白新建表单渲染', async () => {
    mockParams = { prefill: 'not-a-json' };
    await renderScreen();
    expect(screen.getByTestId('asset-edit-name-input').props.value).toBe('');
    expect(screen.getByText('参考图(0/4)')).toBeTruthy();
  });

  it('编辑模式（带 id）忽略 prefill：回显 getAsset 数据', async () => {
    mockGetAsset.mockResolvedValue(SAMPLE);
    mockParams = { id: 'as-1', prefill: PREFILL };
    await renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('asset-edit-name-input').props.value).toBe('女主-A'),
    );
    expect(screen.getByText('参考图(2/4)')).toBeTruthy();
    expect(mockGetAsset).toHaveBeenCalledWith('as-1');
  });
});
