import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { RefImagesField } from '../ref-images-field';
import { uploadImage } from '@/lib/api';
import type { EngineParam, UploadedRefImage } from '@/types/api';

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
  max: 4,
  hint: '支持 jpg / png / webp，≤20MB',
};

function img(name: string, worker = 'http://w1'): UploadedRefImage {
  return { filename: name, worker, previewUri: `file:///tmp/${name}`, name };
}

async function renderField(value: UploadedRefImage[] | null = null, param: EngineParam = PARAM) {
  const onChange = jest.fn();
  const utils = await render(
    <RefImagesField
      param={param}
      value={value}
      onChange={onChange}
      uploadKind="wan_vace"
      testID="ref-images-field"
    />,
  );
  const setValue = (next: UploadedRefImage[] | null) =>
    utils.rerender(
      <RefImagesField
        param={param}
        value={next}
        onChange={onChange}
        uploadKind="wan_vace"
        testID="ref-images-field"
      />,
    );
  return { onChange, setValue };
}

describe('RefImagesField（多参考图字段，M9/M13.3）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('空态渲染上传按钮 + 计数标签 (0/4)', async () => {
    await renderField(null);
    expect(screen.getByTestId('ref-images-field-pick')).toBeTruthy();
    expect(screen.getByText('参考图(0/4)')).toBeTruthy();
    expect(screen.getByText('上传参考图')).toBeTruthy();
  });

  it('多选两张上传：第一张自由落点，第二张钉第一张落点 worker（互钉）', async () => {
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
    const { onChange } = await renderField([]);
    fireEvent.press(screen.getByTestId('ref-images-field-pick'));
    await waitFor(() => expect(mockUploadImage).toHaveBeenCalledTimes(2));
    expect(mockUploadImage).toHaveBeenNthCalledWith(
      1,
      { uri: 'file:///tmp/a.png', fileName: 'a.png', mimeType: 'image/png' },
      'wan_vace',
      undefined,
    );
    expect(mockUploadImage).toHaveBeenNthCalledWith(
      2,
      { uri: 'file:///tmp/b.png', fileName: 'b.png', mimeType: 'image/png' },
      'wan_vace',
      'http://w7',
    );
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ filename: 'up-a.png', worker: 'http://w7' }),
      expect.objectContaining({ filename: 'up-b.png', worker: 'http://w7' }),
    ]);
  });

  it('点按移除按钮按索引剔除对应句柄', async () => {
    const { onChange } = await renderField([img('a.png'), img('b.png')]);
    await fireEvent.press(screen.getByTestId('ref-images-field-remove-0'));
    expect(onChange).toHaveBeenCalledWith([img('b.png')]);
  });

  it('「资产库」入口点选库内图追加句柄（不重新上传，不走相册）', async () => {
    const { onChange } = await renderField([img('a.png')]);
    await fireEvent.press(screen.getByTestId('ref-images-field-asset-entry'));
    await fireEvent.press(screen.getByTestId('ref-images-field-asset-picker-stub-pick'));
    expect(onChange).toHaveBeenCalledWith([
      img('a.png'),
      {
        filename: 'lib-a.png',
        worker: 'http://w9',
        previewUri: 'https://api.test/api/assets/as-1/images/0?token=t',
        name: '女主-A · 图1',
      },
    ]);
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(mockLaunchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('满员（=max）后上传按钮与资产库入口均隐藏', async () => {
    await renderField([img('a.png'), img('b.png'), img('c.png'), img('d.png')]);
    expect(screen.getByText('参考图(4/4)')).toBeTruthy();
    expect(screen.queryByTestId('ref-images-field-pick')).toBeNull();
    expect(screen.queryByTestId('ref-images-field-asset-entry')).toBeNull();
  });

  it('追加上限：3/4 时点选 1 张到 4/4，入口随后隐藏（不超 max）', async () => {
    const three = [img('a.png'), img('b.png'), img('c.png')];
    const { onChange, setValue } = await renderField(three);
    await fireEvent.press(screen.getByTestId('ref-images-field-asset-entry'));
    await fireEvent.press(screen.getByTestId('ref-images-field-asset-picker-stub-pick'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const appended = onChange.mock.calls[0][0] as UploadedRefImage[];
    expect(appended).toHaveLength(4);
    // 父组件受控回写 4 张后：入口与上传按钮消失
    await setValue(appended);
    expect(screen.queryByTestId('ref-images-field-asset-entry')).toBeNull();
    expect(screen.queryByTestId('ref-images-field-pick')).toBeNull();
  });
});
