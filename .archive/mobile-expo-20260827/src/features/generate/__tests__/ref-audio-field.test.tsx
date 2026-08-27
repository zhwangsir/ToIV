import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { RefAudioField } from '../ref-audio-field';
import { uploadAudio } from '@/lib/api';
import type { EngineParam, UploadedRefAudio } from '@/types/api';

// lucide 渲染链路在 jest 不稳定，替身隔离（与 ref-image-field.test.tsx 同理）
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

// 文档选择器在 jest 无原生实现：用例按需 mockResolvedValue 构造 asset（v57 getDocumentAsync 契约）
const mockGetDocumentAsync = jest.fn();
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args),
}));

jest.mock('@/lib/api', () => ({
  uploadAudio: jest.fn(),
}));

const mockUploadAudio = uploadAudio as jest.MockedFunction<typeof uploadAudio>;

const PARAM: EngineParam = {
  key: 'audio',
  label: '驱动音频',
  type: 'audio',
  default: null,
  hint: 'wav / mp3 / m4a / ogg / flac，≤20MB（与参考图同 worker 互钉）',
};

const UPLOADED: UploadedRefAudio = {
  filename: 'voice.wav',
  worker: 'http://w1',
  name: 'voice.wav',
};

/** 构造音频 asset（expo-document-picker v57 DocumentPickerAsset 字段子集） */
function audioAsset(name: string, over: Record<string, unknown> = {}) {
  return {
    uri: `file:///tmp/${name}`,
    name,
    mimeType: 'audio/wav',
    size: 1024,
    lastModified: 1720000000000,
    ...over,
  };
}

async function renderField(
  value: UploadedRefAudio | null = null,
  props: { uploadKind?: string; pinWorker?: string | null } = {},
) {
  const onChange = jest.fn();
  await render(
    <RefAudioField
      param={PARAM}
      value={value}
      onChange={onChange}
      uploadKind={props.uploadKind ?? 'ltx_lipsync'}
      pinWorker={props.pinWorker}
      testID="ref-audio-field"
    />,
  );
  return { onChange };
}

describe('RefAudioField（驱动音频字段，M11.3）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('无值时渲染上传按钮 + hint 文案', async () => {
    await renderField(null);
    expect(screen.getByTestId('ref-audio-field-pick')).toBeTruthy();
    expect(screen.getByText('上传驱动音频')).toBeTruthy();
    expect(screen.getByText('wav / mp3 / m4a / ogg / flac，≤20MB（与参考图同 worker 互钉）')).toBeTruthy();
  });

  it('有值时渲染音频行（文件名 + 移除按钮），上传按钮隐藏', async () => {
    await renderField(UPLOADED);
    expect(screen.getByTestId('ref-audio-field-preview')).toBeTruthy();
    expect(screen.getByText('voice.wav')).toBeTruthy();
    expect(screen.getByTestId('ref-audio-field-remove')).toBeTruthy();
    expect(screen.queryByTestId('ref-audio-field-pick')).toBeNull();
  });

  it('点按移除按钮清空值并触发 onChange(null)', async () => {
    const { onChange } = await renderField(UPLOADED);
    fireEvent.press(screen.getByTestId('ref-audio-field-remove'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('点按上传按钮调用系统文档选择器（getDocumentAsync，type audio/*）', async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    await renderField(null);
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() => expect(mockGetDocumentAsync).toHaveBeenCalledTimes(1));
    expect(mockGetDocumentAsync).toHaveBeenCalledWith({ type: 'audio/*' });
  });

  it('取消选择时不触发上传', async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() => expect(mockGetDocumentAsync).toHaveBeenCalled());
    expect(mockUploadAudio).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('客户端校验扩展名（拒绝 aac），展示错误人话', async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [audioAsset('song.aac', { mimeType: 'audio/aac' })],
    });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() =>
      expect(screen.getByText('仅支持 wav / mp3 / m4a / ogg / flac 音频')).toBeTruthy(),
    );
    expect(mockUploadAudio).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('客户端校验体积（>20MB 拒绝），展示错误人话', async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [audioAsset('big.wav', { size: 21 * 1024 * 1024 })],
    });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() => expect(screen.getByText('音频超过 20MB 上限')).toBeTruthy());
    expect(mockUploadAudio).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('合法音频上传成功：onChange 携带 {filename, worker, name}，pinWorker 透传上传路由', async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [audioAsset('voice.wav')],
    });
    mockUploadAudio.mockResolvedValueOnce({ filename: 'uploaded-voice.wav', worker: 'http://w1' });
    const { onChange } = await renderField(null, { pinWorker: 'http://w1' });
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() => expect(mockUploadAudio).toHaveBeenCalledTimes(1));
    expect(mockUploadAudio).toHaveBeenCalledWith(
      {
        uri: 'file:///tmp/voice.wav',
        fileName: 'voice.wav',
        mimeType: 'audio/wav',
      },
      'ltx_lipsync',
      'http://w1',
    );
    expect(onChange).toHaveBeenCalledWith({
      filename: 'uploaded-voice.wav',
      worker: 'http://w1',
      name: 'voice.wav',
    });
  });

  it('name 无扩展名时按 mimeType 推断（audio/mpeg → mp3 放行）', async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [audioAsset('track', { mimeType: 'audio/mpeg' })],
    });
    mockUploadAudio.mockResolvedValueOnce({ filename: 'track.mp3', worker: 'http://w1' });
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() => expect(mockUploadAudio).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith({
      filename: 'track.mp3',
      worker: 'http://w1',
      name: 'track',
    });
  });

  it('上传失败展示后端人话错误，不触发 onChange', async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [audioAsset('voice.wav')],
    });
    mockUploadAudio.mockRejectedValueOnce(new Error('文件内容与扩展名不符'));
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() => expect(screen.getByText('文件内容与扩展名不符')).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('上传中展示 loading 态，禁止重复点击', async () => {
    let resolveUpload: (v: { filename: string; worker: string }) => void;
    mockUploadAudio.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveUpload = r;
        }),
    );
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [audioAsset('voice.wav')],
    });
    await renderField(null);
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() => expect(mockUploadAudio).toHaveBeenCalledTimes(1));

    // 上传中：按钮禁用 + loading 指示器
    expect(screen.getByTestId('ref-audio-field-uploading')).toBeTruthy();
    expect(screen.getByTestId('ref-audio-field-pick').props.accessibilityState.busy).toBe(true);
    expect(screen.getByTestId('ref-audio-field-pick').props.accessibilityState.disabled).toBe(true);

    // 重复点击不触发第二次上传
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    expect(mockUploadAudio).toHaveBeenCalledTimes(1);

    // 上传完成
    resolveUpload!({ filename: 'a.wav', worker: 'w1' });
    await waitFor(() => expect(screen.queryByTestId('ref-audio-field-uploading')).toBeNull());
  });

  it('文档选择器打开失败（异常）展示兜底人话', async () => {
    mockGetDocumentAsync.mockRejectedValueOnce(new Error('permission denied'));
    const { onChange } = await renderField(null);
    fireEvent.press(screen.getByTestId('ref-audio-field-pick'));
    await waitFor(() => expect(screen.getByText('无法打开文件选择器，请重试')).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
  });
});
