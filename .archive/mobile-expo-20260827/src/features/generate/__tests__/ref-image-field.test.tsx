import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { RefImageField } from '../ref-image-field';
import { uploadImage } from '@/lib/api';
import type { EngineParam, UploadedRefImage } from '@/types/api';

// lucide 渲染链路在 jest 不稳定，替身隔离
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

const mockLaunchImageLibraryAsync = jest.fn();
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibraryAsync(...args),
}));

// AssetPicker 依赖 SafeArea/QueryClient 容器，其内部逻辑由 features/assets 独立套件覆盖；
// 此处替身聚焦字段联动：visible 时渲染一个「点选资产图」按钮，模拟库内图回填 + 关闭
jest.mock('@/features/assets/asset-picker', () => {
  const React = jest.requireActual('react');
  const { Pressable } = jest.requireActual('react-native');
  return {
    AssetPicker: (props: {
      visible: boolean;
      onSelect: (image: UploadedRefImage) => void;
      onClose: () => void;
      testID?: string;
    }) =>
      props.visible
        ? React.createElement(Pressable, {
            testID: `${props.testID ?? 'asset-picker'}-stub-pick`,
            onPress: () => {
              props.onSelect({
                filename: 'lib-a.png',
                worker: 'http://w9',
                previewUri: 'https://api.test/api/assets/as-1/images/0?token=t',
                name: '女主-A · 图1',
              });
              props.onClose();
            },
          })
        : null,
  };
});

jest.mock('@/lib/api', () => ({
  uploadImage: jest.fn(),
  setNsfwIntent: jest.fn(),
}));

jest.mock('@/lib/config', () => ({
  setApiBaseOverride: jest.fn(),
}));

const mockUploadImage = uploadImage as jest.MockedFunction<typeof uploadImage>;

const PARAM: EngineParam = {
  key: 'images',
  label: '参考图',
  type: 'images',
  default: null,
  hint: '支持 jpg / png / webp，≤20MB',
};

const UPLOADED: UploadedRefImage = {
  filename: 'ref.png',
  worker: 'http://w1',
  previewUri: 'file:///tmp/ref.png',
  name: 'ref.png',
};

async function renderField(value: UploadedRefImage | null = null) {
  const onChange = jest.fn();
  await render(
    <RefImageField param={PARAM} value={value} onChange={onChange} testID="ref-image-field" />,
  );
  return { onChange };
}

describe('RefImageField（参考图字段，M8.4）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('无值时渲染上传按钮 + hint 文案', async () => {
    await renderField(null);
    expect(screen.getByTestId('ref-image-field-pick')).toBeTruthy();
    expect(screen.getByText('上传参考图')).toBeTruthy();
    expect(screen.getByText('支持 jpg / png / webp，≤20MB')).toBeTruthy();
  });

  it('有值时渲染预览缩略图 + 文件名 + 移除按钮', async () => {
    await renderField(UPLOADED);
    expect(screen.getByTestId('ref-image-field-preview')).toBeTruthy();
    expect(screen.getByTestId('ref-image-field-thumb')).toBeTruthy();
    expect(screen.getByText('ref.png')).toBeTruthy();
    expect(screen.getByTestId('ref-image-field-remove')).toBeTruthy();
    // 上传按钮隐藏
    expect(screen.queryByTestId('ref-image-field-pick')).toBeNull();
  });

  it('点按移除按钮清空值并触发 onChange(null)', async () => {
    const { onChange } = await renderField(UPLOADED);
    fireEvent.press(screen.getByTestId('ref-image-field-remove'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('点按上传按钮调用系统相册（launchImageLibraryAsync）', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: [] });
    await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(mockLaunchImageLibraryAsync).toHaveBeenCalledTimes(1));
    expect(mockLaunchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      quality: 1,
    });
  });

  it('相册取消选择时不触发上传', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: [] });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(mockLaunchImageLibraryAsync).toHaveBeenCalled());
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('选中图片后客户端校验扩展名（拒绝 gif），展示错误人话', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/anim.gif', fileName: 'anim.gif', mimeType: 'image/gif' }],
    });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(screen.getByText('仅支持 jpg / png / webp 图片')).toBeTruthy());
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('选中图片后客户端校验体积（>20MB 拒绝），展示错误人话', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/big.png',
          fileName: 'big.png',
          mimeType: 'image/png',
          fileSize: 21 * 1024 * 1024,
        },
      ],
    });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(screen.getByText('图片超过 20MB 上限')).toBeTruthy());
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('选中合法图片后上传成功：onChange 携带 {filename, worker, previewUri, name}', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/ref.png', fileName: 'ref.png', mimeType: 'image/png' }],
    });
    mockUploadImage.mockResolvedValueOnce({ filename: 'uploaded-ref.png', worker: 'http://w2' });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(mockUploadImage).toHaveBeenCalledTimes(1));
    expect(mockUploadImage).toHaveBeenCalledWith(
      {
        uri: 'file:///tmp/ref.png',
        fileName: 'ref.png',
        mimeType: 'image/png',
      },
      undefined,
    );
    expect(onChange).toHaveBeenCalledWith({
      filename: 'uploaded-ref.png',
      worker: 'http://w2',
      previewUri: 'file:///tmp/ref.png',
      name: 'ref.png',
    });
  });

  it('上传失败展示后端人话错误，不触发 onChange', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/ref.png', fileName: 'ref.png', mimeType: 'image/png' }],
    });
    mockUploadImage.mockRejectedValueOnce(new Error('文件内容与扩展名不符'));
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(screen.getByText('文件内容与扩展名不符')).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('上传中展示 loading 态，禁止重复点击', async () => {
    let resolveUpload: (v: { filename: string; worker: string }) => void;
    mockUploadImage.mockImplementationOnce(
      () => new Promise((r) => { resolveUpload = r; }),
    );
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/ref.png', fileName: 'ref.png', mimeType: 'image/png' }],
    });
    await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(mockUploadImage).toHaveBeenCalledTimes(1));

    // 上传中：按钮禁用 + loading 指示器
    expect(screen.getByTestId('ref-image-field-uploading')).toBeTruthy();
    expect(screen.getByTestId('ref-image-field-pick').props.accessibilityState.busy).toBe(true);
    // disabled 状态通过 accessibilityState 或 onPress 拦截验证（RN Pressable props.disabled 可能为 undefined）
    expect(screen.getByTestId('ref-image-field-pick').props.accessibilityState.disabled).toBe(true);

    // 重复点击不触发第二次上传
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    expect(mockUploadImage).toHaveBeenCalledTimes(1);

    // 上传完成
    resolveUpload!({ filename: 'a.png', worker: 'w1' });
    await waitFor(() => expect(screen.queryByTestId('ref-image-field-uploading')).toBeNull());
  });

  it('fileName 缺失时按 mimeType 推断扩展名上传', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/x', fileName: null, mimeType: 'image/webp' }],
    });
    mockUploadImage.mockResolvedValueOnce({ filename: 'x.webp', worker: 'w1' });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(mockUploadImage).toHaveBeenCalledTimes(1));
    expect(mockUploadImage).toHaveBeenCalledWith(
      {
        uri: 'file:///tmp/x',
        fileName: null,
        mimeType: 'image/webp',
      },
      undefined,
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'upload.webp' }),
    );
  });

  it('相册打开失败（异常）展示兜底人话', async () => {
    mockLaunchImageLibraryAsync.mockRejectedValueOnce(new Error('permission denied'));
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-image-field-pick'));
    await waitFor(() => expect(screen.getByText('无法打开相册，请重试')).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('渲染「资产库」次级入口（M13.3），点按打开选择器', async () => {
    await renderField(null);
    const entry = screen.getByTestId('ref-image-field-asset-entry');
    expect(entry).toBeTruthy();
    // 选择器初始关闭（替身不渲染）
    expect(screen.queryByTestId('ref-image-field-asset-picker-stub-pick')).toBeNull();
    await fireEvent.press(entry);
    expect(screen.getByTestId('ref-image-field-asset-picker-stub-pick')).toBeTruthy();
  });

  it('点选库内资产图直接替换当前参考图句柄（不重新上传）并关闭选择器', async () => {
    const { onChange } = await renderField(null);
    await fireEvent.press(screen.getByTestId('ref-image-field-asset-entry'));
    await fireEvent.press(screen.getByTestId('ref-image-field-asset-picker-stub-pick'));
    expect(onChange).toHaveBeenCalledWith({
      filename: 'lib-a.png',
      worker: 'http://w9',
      previewUri: 'https://api.test/api/assets/as-1/images/0?token=t',
      name: '女主-A · 图1',
    });
    // 选中即完成态：不走上传链路
    expect(mockUploadImage).not.toHaveBeenCalled();
    // 选择器随 onClose 关闭
    expect(screen.queryByTestId('ref-image-field-asset-picker-stub-pick')).toBeNull();
  });
});
