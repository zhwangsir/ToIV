import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { GenerateScreen } from '../generate-screen';
import { getJobSseCreds, resetJobSseRegistry } from '@/features/jobs/job-sse-registry';
import {
  fetchEngines,
  optimizePrompt,
  reversePrompt,
  submitAceMusic,
  submitAvatarTalk,
  submitH3I2V,
  submitH3T2V,
  submitImg2Img,
  submitLongCatContinue,
  submitLongCatT2V,
  submitLtx25I2V,
  submitLtx25T2V,
  submitLtxNsfwI2V,
  submitLtxNsfwLipsync,
  submitLtxNsfwT2V,
  submitTxt2Img,
  submitWanAnimate,
  submitWanVace,
  uploadAudio,
  uploadImage,
  uploadVideo,
} from '@/lib/api';
import { useGenerationDraft } from '@/stores/generation-draft';
import type { EngineInfo } from '@/types/api';

// lucide 渲染链路在 jest 不稳定，替身隔离（与 profile-screen.test.tsx 同理）
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

// 触觉反馈无原生实现，替身
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  // tab 常驻场景的焦点钩子：挂载即首次聚焦
  useFocusEffect: (cb: () => void) => {
    const React = jest.requireActual('react') as typeof import('react');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 替身语义：挂载即聚焦一次
    React.useEffect(cb, []);
  },
}));

jest.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
  fetchEngines: jest.fn(),
  reversePrompt: jest.fn(),
  optimizePrompt: jest.fn(),
  submitTxt2Img: jest.fn(),
  submitImg2Img: jest.fn(),
  submitLtx25T2V: jest.fn(),
  submitLtx25I2V: jest.fn(),
  submitWanAnimate: jest.fn(),
  submitWanVace: jest.fn(),
  submitH3T2V: jest.fn(),
  submitH3I2V: jest.fn(),
  submitLongCatT2V: jest.fn(),
  submitLongCatI2V: jest.fn(),
  submitLongCatContinue: jest.fn(),
  submitAceMusic: jest.fn(),
  submitLtxNsfwT2V: jest.fn(),
  submitLtxNsfwI2V: jest.fn(),
  submitLtxNsfwLipsync: jest.fn(),
  submitAvatarTalk: jest.fn(),
  uploadImage: jest.fn(),
  uploadVideo: jest.fn(),
  uploadAudio: jest.fn(),
  // 与真实实现同逻辑（M11.1 api.ts uploadKindForEngine）：组件侧算上传 kind 用
  uploadKindForEngine: (engineId: string) => {
    switch (engineId) {
      case 'wan-animate':
        return 'wan_animate';
      case 'wan-vace':
        return 'wan_vace';
      case 'h3-i2v':
      case 'h3-nsfw-i2v':
        return 'h3_i2v';
      case 'ltx-nsfw-lipsync':
        return 'ltx_lipsync';
      case 'avatar-talk':
        return 'avatar';
      case 'ltx25-i2v':
      case 'longcat-i2v':
      case 'ltx-nsfw-i2v':
        return 'ltx_i2v';
      default:
        return 'img2img';
    }
  },
}));

// 相册选择在 jest 无原生实现：用例按需 mockResolvedValue 构造 asset
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
}));

// 文档选择器在 jest 无原生实现（M11 驱动音频）：用例按需 mockResolvedValue 构造 asset
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

const mockFetchEngines = fetchEngines as jest.MockedFunction<typeof fetchEngines>;
const mockSubmit = submitTxt2Img as jest.MockedFunction<typeof submitTxt2Img>;
const mockSubmitImg2Img = submitImg2Img as jest.MockedFunction<typeof submitImg2Img>;

/** 与后端 engine_registry txt2img 参数 schema 同形（默认值/边界一致） */
const TXT2IMG: EngineInfo = {
  id: 'txt2img',
  label: '文生图',
  kind: 'image',
  available: true,
  nsfw: false,
  params: [
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '', hint: '描述不想要的内容' },
    {
      key: 'ckpt_name',
      label: '底模',
      type: 'select',
      default: '',
      options: [
        { value: '', label: '平台默认底模' },
        { value: 'sdxl.safetensors', label: 'SDXL' },
      ],
    },
    {
      key: 'sampler',
      label: '采样器',
      type: 'select',
      default: 'euler',
      options: [
        { value: 'euler', label: 'euler' },
        { value: 'dpmpp_2m', label: 'dpmpp_2m' },
      ],
    },
    {
      key: 'scheduler',
      label: '调度器',
      type: 'select',
      default: 'normal',
      options: [{ value: 'normal', label: 'normal' }],
    },
    { key: 'width', label: '宽度', type: 'number', default: 1024, min: 64, max: 2048, step: 8 },
    { key: 'height', label: '高度', type: 'number', default: 1024, min: 64, max: 2048, step: 8 },
    { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 150 },
    { key: 'cfg', label: 'CFG', type: 'number', default: 7, min: 0, max: 30, step: 0.5 },
    { key: 'seed', label: '随机种子', type: 'text', default: '', hint: '留空随机' },
    { key: 'batch_size', label: '批量张数', type: 'number', default: 1, min: 1, max: 8 },
  ],
};

/** 第二个可提交图像引擎：steps 默认值不同，用于验证切换重置 */
const TXT2IMG_PRO: EngineInfo = {
  ...TXT2IMG,
  id: 'txt2img-pro',
  label: '文生图 Pro',
  params: TXT2IMG.params.map((p) => (p.key === 'steps' ? { ...p, default: 30 } : p)),
};

const IMG2IMG: EngineInfo = {
  id: 'img2img',
  label: '图生图',
  kind: 'image',
  available: true,
  nsfw: false,
  params: [{ key: 'images', label: '参考图', type: 'images', default: null }],
};

const VIDEO: EngineInfo = {
  id: 'ltx2-t2v',
  label: '文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [],
};

/** schema 默认值全量提交时的期望请求体（number 全送、非空字符串送、空 select/seed 省略） */
const DEFAULT_BODY = {
  width: 1024,
  height: 1024,
  steps: 20,
  cfg: 7,
  batch_size: 1,
  sampler: 'euler',
  scheduler: 'normal',
};

function renderScreen() {
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
        <GenerateScreen />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(tree as ReactElement);
}

async function submitPrompt(text: string) {
  await fireEvent.changeText(screen.getByTestId('prompt-bar-input'), text);
  await fireEvent.press(screen.getByTestId('prompt-bar-send'));
}

describe('GenerateScreen（创作）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchEngines.mockResolvedValue([TXT2IMG, IMG2IMG, VIDEO]);
  });

  it('引擎列表展示图像+视频引擎（M9 放开），未接入引擎禁用态', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    // M8 起 img2img 引擎也展示（参考图选中即传）
    expect(screen.getByTestId('engine-chip-img2img')).toBeTruthy();
    // M9.3 起视频引擎进入列表；ltx2-t2v 不在移动端白名单（h3/longcat 同理）→ 禁用态展示
    const video = screen.getByTestId('engine-chip-ltx2-t2v');
    expect(video.props.accessibilityState.disabled).toBe(true);
  });

  it('空提示词时发送按钮禁用', async () => {
    await renderScreen();
    const send = screen.getByTestId('prompt-bar-send');
    expect(send.props.accessibilityState.disabled).toBe(true);
  });

  it('输入提示词后提交：schema 默认值全量进请求体，成功清空输入并展示成功横幅', async () => {
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await submitPrompt('  一只猫  ');

    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith({ positive: '一只猫', ...DEFAULT_BODY });
    expect(screen.getByTestId('prompt-bar-input').props.value).toBe('');
  });

  it('成功横幅点按跳转作业页', async () => {
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await submitPrompt('一只猫');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('submit-success-banner'));
    expect(mockPush).toHaveBeenCalledWith('/jobs');
  });

  it('提交成功登记会话内 SSE 凭据（M29.3：作业屏追踪经 SSE 推确定性进度）', async () => {
    resetJobSseRegistry();
    mockSubmit.mockResolvedValueOnce({
      prompt_id: 'p-m29',
      client_id: 'c-m29',
      worker: 'w-m29',
      seed: 7,
    });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await submitPrompt('一只猫');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(getJobSseCreds('p-m29')).toEqual({ clientId: 'c-m29', worker: 'w-m29' });
    resetJobSseRegistry();
  });

  it('提交失败展示 ApiError 人话', async () => {
    const { ApiError } = jest.requireActual('@/lib/api') as { ApiError: new (s: number, m: string) => Error };
    mockSubmit.mockRejectedValueOnce(new ApiError(429, '请求过于频繁，请稍后再试'));
    await renderScreen();
    await submitPrompt('一只猫');
    await waitFor(() => expect(screen.getByTestId('submit-error-banner')).toBeTruthy());
    expect(screen.getByText('请求过于频繁，请稍后再试')).toBeTruthy();
  });

  it('参数抽屉切换 3:4 并填负向提示词，提交体随之变化', async () => {
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-size-3:4'));
    await fireEvent.changeText(screen.getByTestId('param-sheet-field-negative-input'), '低画质');
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('一只猫');

    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith({
      positive: '一只猫',
      ...DEFAULT_BODY,
      width: 832,
      height: 1216,
      negative: '低画质',
    });
  });
});

describe('GenerateScreen 动态参数表单（M7.4）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue([TXT2IMG, IMG2IMG, VIDEO]);
  });

  it('按引擎 schema 渲染字段：select chips / number / text / textarea 齐备，width/height 由画幅预设承载', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));

    // select → chips（底模/采样器/调度器）
    expect(screen.getByTestId('param-sheet-field-ckpt_name-opt-default')).toBeTruthy();
    expect(screen.getByTestId('param-sheet-field-ckpt_name-opt-sdxl.safetensors')).toBeTruthy();
    expect(screen.getByTestId('param-sheet-field-sampler-opt-dpmpp_2m')).toBeTruthy();
    // number / text / textarea 输入框
    expect(screen.getByTestId('param-sheet-field-steps-input')).toBeTruthy();
    expect(screen.getByTestId('param-sheet-field-seed-input')).toBeTruthy();
    expect(screen.getByTestId('param-sheet-field-negative-input')).toBeTruthy();
    // width/height 不在动态区重复渲染
    expect(screen.queryByTestId('param-sheet-field-width')).toBeNull();
    expect(screen.queryByTestId('param-sheet-field-height')).toBeNull();
  });

  it('select 选择底模 + 填写 seed，提交体精确携带（seed 文本转整数）', async () => {
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 42 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-ckpt_name-opt-sdxl.safetensors'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-sampler-opt-dpmpp_2m'));
    await fireEvent.changeText(screen.getByTestId('param-sheet-field-seed-input'), '42');
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('一只猫');

    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith({
      positive: '一只猫',
      ...DEFAULT_BODY,
      sampler: 'dpmpp_2m',
      ckpt_name: 'sdxl.safetensors',
      seed: 42,
    });
  });

  it('number 越界失焦 clamp 到 schema 上限，清空失焦回落 default', async () => {
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));

    const steps = screen.getByTestId('param-sheet-field-steps-input');
    // 越界 999 → clamp 150
    await fireEvent.changeText(steps, '999');
    await fireEvent(steps, 'endEditing');
    expect(screen.getByTestId('param-sheet-field-steps-input').props.value).toBe('150');
    // 清空 → 回落 default 20
    await fireEvent.changeText(screen.getByTestId('param-sheet-field-steps-input'), '');
    await fireEvent(screen.getByTestId('param-sheet-field-steps-input'), 'endEditing');
    expect(screen.getByTestId('param-sheet-field-steps-input').props.value).toBe('20');
    // 再改一个合法值提交验证
    await fireEvent.changeText(screen.getByTestId('param-sheet-field-steps-input'), '28');
    await fireEvent(screen.getByTestId('param-sheet-field-steps-input'), 'endEditing');
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('一只猫');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith({
      positive: '一只猫',
      ...DEFAULT_BODY,
      steps: 28,
    });
  });

  it('切换引擎后表单重置为新引擎 schema 默认值', async () => {
    mockFetchEngines.mockResolvedValue([TXT2IMG, TXT2IMG_PRO]);
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img-pro')).toBeTruthy());

    // 默认引擎 txt2img：steps 改 50
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.changeText(screen.getByTestId('param-sheet-field-steps-input'), '50');
    await fireEvent(screen.getByTestId('param-sheet-field-steps-input'), 'endEditing');
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    // 切到 txt2img-pro → steps 回其 default 30
    await fireEvent.press(screen.getByTestId('engine-chip-txt2img-pro'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    expect(screen.getByTestId('param-sheet-field-steps-input').props.value).toBe('30');
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('一只猫');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith({
      positive: '一只猫',
      ...DEFAULT_BODY,
      steps: 30,
    });
  });

  it('seed 填非法文本（小数/负数/非数字）视为留空，不进请求体', async () => {
    mockSubmit.mockResolvedValue({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.changeText(screen.getByTestId('param-sheet-field-seed-input'), 'abc');
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('一只猫');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith({ positive: '一只猫', ...DEFAULT_BODY });
  });

  it('作品库复用草稿：进入创作屏自动回填提示词（一次性消费）', async () => {
    useGenerationDraft.getState().setDraft({ prompt: '月球上的猫' });
    await renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('prompt-bar-input').props.value).toBe('月球上的猫'),
    );
    expect(useGenerationDraft.getState().draft).toBeNull();
  });
});

describe('GenerateScreen img2img 功能（M8.4）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue([TXT2IMG, IMG2IMG, VIDEO]);
  });

  it('img2img 引擎出现在列表中，选中后参数抽屉展示参考图上传区域', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-img2img')).toBeTruthy());

    // 切换到 img2img 引擎
    await fireEvent.press(screen.getByTestId('engine-chip-img2img'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));

    // 参考图上传区域出现
    expect(screen.getByTestId('param-sheet-field-images')).toBeTruthy();
    // 无 width/height 参数，画幅比例预设隐藏
    expect(screen.queryByTestId('param-sheet-size-label')).toBeNull();
    expect(screen.queryByTestId('param-sheet-size-1:1')).toBeNull();
  });

  it('img2img 未上传参考图时提交，展示本地错误提示', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-img2img')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-img2img'));

    await submitPrompt('一只猫');

    // 本地校验错误文案与 Web submitEngineGeneration 一致
    expect(screen.getByText('请先上传参考图')).toBeTruthy();
    // 不应调用任何提交 API
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockSubmitImg2Img).not.toHaveBeenCalled();
  });

  it('buildImg2ImgRequest 纯函数：参考图句柄 + denoise/steps/cfg 正确序列化', () => {
    const { buildImg2ImgRequest } = jest.requireActual('../generate-screen') as {
      buildImg2ImgRequest: (engine: EngineInfo, values: Record<string, unknown>, positive: string) => Record<string, unknown> | null;
    };
    const engine: EngineInfo = {
      ...IMG2IMG,
      params: [
        { key: 'images', label: '参考图', type: 'images', default: null },
        { key: 'denoise', label: '重绘幅度', type: 'number', default: 0.6, min: 0.1, max: 1.0 },
        { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 150 },
        { key: 'cfg', label: 'CFG', type: 'number', default: 7, min: 0, max: 30 },
        { key: 'seed', label: '随机种子', type: 'text', default: '', hint: '留空随机' },
        { key: 'negative', label: '负向提示词', type: 'textarea', default: '', hint: '描述不想要的内容' },
      ],
    };
    const values = {
      images: { filename: 'ref.png', worker: 'http://w1', previewUri: 'file:///tmp/ref.png', name: 'ref.png' },
      denoise: 0.45,
      steps: 28,
      cfg: 7,
      seed: '42',
      negative: '低画质',
    };
    const req = buildImg2ImgRequest(engine, values, '一只猫');
    expect(req).toEqual({
      positive: '一只猫',
      image: 'ref.png',
      worker: 'http://w1',
      denoise: 0.45,
      steps: 28,
      cfg: 7,
      seed: 42,
      negative: '低画质',
    });
  });

  it('buildImg2ImgRequest 纯函数：无参考图句柄返回 null', () => {
    const { buildImg2ImgRequest } = jest.requireActual('../generate-screen') as {
      buildImg2ImgRequest: (engine: EngineInfo, values: Record<string, unknown>, positive: string) => Record<string, unknown> | null;
    };
    expect(buildImg2ImgRequest(IMG2IMG, {}, '一只猫')).toBeNull();
  });

  it('buildImg2ImgRequest 纯函数：denoise/steps/cfg 缺省回落 default，非法 seed 省略', () => {
    const { buildImg2ImgRequest } = jest.requireActual('../generate-screen') as {
      buildImg2ImgRequest: (engine: EngineInfo, values: Record<string, unknown>, positive: string) => Record<string, unknown> | null;
    };
    const engine: EngineInfo = {
      ...IMG2IMG,
      params: [
        { key: 'images', label: '参考图', type: 'images', default: null },
        { key: 'denoise', label: '重绘幅度', type: 'number', default: 0.6, min: 0.1, max: 1.0 },
        { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 150 },
        { key: 'cfg', label: 'CFG', type: 'number', default: 7, min: 0, max: 30 },
        { key: 'seed', label: '随机种子', type: 'text', default: '', hint: '留空随机' },
      ],
    };
    const values = {
      images: { filename: 'a.png', worker: 'w1', previewUri: 'file:///a.png', name: 'a.png' },
      seed: 'abc',
    };
    const req = buildImg2ImgRequest(engine, values, '一只猫');
    expect(req).toEqual({
      positive: '一只猫',
      image: 'a.png',
      worker: 'w1',
      denoise: 0.6,
      steps: 20,
      cfg: 7,
    });
  });

  it('buildTxt2ImgRequest 纯函数：width/height/steps/cfg/batch_size 全量提交，空字符串省略', () => {
    const { buildTxt2ImgRequest } = jest.requireActual('../generate-screen') as {
      buildTxt2ImgRequest: (engine: EngineInfo, values: Record<string, unknown>, positive: string) => Record<string, unknown>;
    };
    // 空 values：number 回落 default，select 空字符串省略（后端走默认），seed 省略
    const req = buildTxt2ImgRequest(TXT2IMG, {}, '一只猫');
    expect(req).toEqual({
      positive: '一只猫',
      width: 1024,
      height: 1024,
      steps: 20,
      cfg: 7,
      batch_size: 1,
    });
  });

  it('txt2img 引擎参数抽屉展示画幅比例预设（无 images 参数）', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));

    // 画幅比例预设显示
    expect(screen.getByTestId('param-sheet-size-label')).toBeTruthy();
    expect(screen.getByTestId('param-sheet-size-1:1')).toBeTruthy();
    // 无参考图字段
    expect(screen.queryByTestId('param-sheet-field-images')).toBeNull();
  });
});

// ── M9：SFW 视频引擎（ltx25-t2v / ltx25-i2v / wan-animate / wan-vace）──

/** 与后端 engine_registry _ltx25_video_params 同形 */
const LTX25_T2V: EngineInfo = {
  id: 'ltx25-t2v',
  label: 'LTX 2.5 文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 960, min: 256, max: 1920, step: 32 },
    { key: 'height', label: '高度', type: 'number', default: 544, min: 256, max: 1088, step: 32 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 5, min: 0.5, max: 60, step: 0.5 },
    { key: 'fps', label: '帧率', type: 'number', default: 24, min: 8, max: 60 },
    { key: 'steps', label: '采样步数', type: 'number', default: 8, min: 1, max: 50 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
  ],
};

/** ltx25-i2v = 参考图（max=1）+ t2v 参数 + strength */
const LTX25_I2V: EngineInfo = {
  id: 'ltx25-i2v',
  label: 'LTX 2.5 图生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...LTX25_T2V.params,
    { key: 'strength', label: '首帧强度', type: 'number', default: 0.7, min: 0, max: 1, step: 0.05 },
  ],
};

/** 与后端 engine_registry _wan_animate_params 同形（参考图 + video 型驱动视频） */
const WAN_ANIMATE: EngineInfo = {
  id: 'wan-animate',
  label: 'Wan2.2 动作迁移',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    { key: 'video', label: '驱动视频', type: 'video', default: null },
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
    { key: 'height', label: '高度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 7.5, min: 0.5, max: 31, step: 0.5 },
    { key: 'steps', label: '采样步数', type: 'number', default: 6, min: 1, max: 50 },
    { key: 'fps', label: '帧率', type: 'number', default: 16, min: 8, max: 30 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
  ],
};

/** 与后端 engine_registry _wan_vace_params 同形（多参考图 max=4） */
const WAN_VACE: EngineInfo = {
  id: 'wan-vace',
  label: 'VACE 多参考视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'images', label: '参考图(1-4 张)', type: 'images', max: 4, default: null },
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
    { key: 'height', label: '高度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 5, min: 0.5, max: 15, step: 0.5 },
    { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 50 },
    { key: 'fps', label: '帧率', type: 'number', default: 16, min: 8, max: 30 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
  ],
};

// ── M10：H3 / LongCat / ACE 引擎 fixture（与后端 engine_registry schema 同形）──

/** H3 LoRA 选项（注册表 loras 参数 options 运行时注入，测试给两项） */
const H3_LORA_OPTIONS = [
  { value: 'film.safetensors', label: '胶片质感' },
  { value: 'motion.safetensors', label: '运动增强' },
];

/** 与后端 engine_registry _h3_video_params 同形（含 loras 叠加参数） */
const H3_T2V: EngineInfo = {
  id: 'h3-t2v',
  label: 'MiniMax H3 文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 1344, min: 256, max: 1344, step: 32 },
    { key: 'height', label: '高度', type: 'number', default: 768, min: 256, max: 1344, step: 32 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 5, min: 0.5, max: 60, step: 0.5 },
    { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 50 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
    {
      key: 'loras',
      label: 'LoRA 叠加',
      type: 'loras',
      default: [],
      options: H3_LORA_OPTIONS,
      min: 0.5,
      max: 1.0,
      step: 0.05,
    },
  ],
};

/** h3-i2v = 参考图（max=1）+ h3 t2v 参数全集 */
const H3_I2V: EngineInfo = {
  id: 'h3-i2v',
  label: 'MiniMax H3 图生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [{ key: 'images', label: '参考图', type: 'images', max: 1, default: null }, ...H3_T2V.params],
};

/** 与后端 engine_registry _longcat_video_params 同形（无 cfg，蒸馏链路固定 1.0） */
const LONGCAT_T2V: EngineInfo = {
  id: 'longcat-t2v',
  label: 'LongCat 文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
    { key: 'height', label: '高度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 7.5, min: 0.5, max: 60, step: 0.5 },
    { key: 'steps', label: '采样步数', type: 'number', default: 10, min: 1, max: 50 },
    { key: 'fps', label: '帧率', type: 'number', default: 16, min: 8, max: 30 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
  ],
};

/** longcat-i2v = 参考图（max=1）+ longcat 参数全集 */
const LONGCAT_I2V: EngineInfo = {
  id: 'longcat-i2v',
  label: 'LongCat 图生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...LONGCAT_T2V.params,
  ],
};

/** longcat-continue = 源视频产物 URL（text 参数）+ longcat 参数全集 */
const LONGCAT_CONTINUE: EngineInfo = {
  id: 'longcat-continue',
  label: 'LongCat 视频续写',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'video', label: '源视频', type: 'text', default: '' },
    ...LONGCAT_T2V.params,
  ],
};

/** 与后端 engine_registry _ace_audio_params 同形（kind=audio） */
const ACE_MUSIC: EngineInfo = {
  id: 'ace-music',
  label: 'ACE 文生音乐',
  kind: 'audio',
  available: true,
  nsfw: false,
  params: [
    { key: 'lyrics', label: '歌词', type: 'textarea', default: '' },
    { key: 'seconds', label: '时长(秒)', type: 'number', default: 30, min: 5, max: 240, step: 1 },
    { key: 'steps', label: '采样步数', type: 'number', default: 50, min: 10, max: 150 },
    { key: 'cfg', label: 'CFG', type: 'number', default: 5, min: 0, max: 20, step: 0.5 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
  ],
};

/**
 * M14 接入引擎样本：avatar-talk 数字人（与后端 engine_registry._avatar_talk_params 同形——
 * 注册表把驱动音频声明为 text 型，移动端 normalizeEngineSchema 归一为 audio 型复用 RefAudioField 链路）
 */
const AVATAR_TALK: EngineInfo = {
  id: 'avatar-talk',
  label: 'LongCat-Avatar 数字人',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [
    { key: 'images', label: '人像首帧', type: 'images', max: 1, default: null },
    { key: 'audio', label: '驱动音频', type: 'text', default: '' },
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    { key: 'width', label: '宽度', type: 'number', default: 480, min: 320, max: 1280, step: 16 },
    { key: 'height', label: '高度', type: 'number', default: 832, min: 320, max: 1280, step: 16 },
    { key: 'duration', label: '时长(秒)', type: 'number', default: 3.7, min: 0.5, max: 100, step: 0.1 },
    { key: 'fps', label: '帧率', type: 'number', default: 25, min: 8, max: 30 },
    { key: 'steps', label: '采样步数', type: 'number', default: 12, min: 1, max: 50 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
  ],
};

/** 归一化后的 avatar-talk（audio 已转 audio 型）：纯逻辑构建用例直接消费 */
const AVATAR_TALK_NORMALIZED: EngineInfo = {
  ...AVATAR_TALK,
  params: AVATAR_TALK.params.map((p) =>
    p.key === 'audio' ? { ...p, type: 'audio' as const, default: null } : p,
  ),
};

/** 未接入引擎样本（白名单外）：禁用态展示 */
const UNKNOWN_VIDEO: EngineInfo = {
  id: 'ltx2-t2v',
  label: 'LTX2 文生视频',
  kind: 'video',
  available: true,
  nsfw: false,
  params: [],
};

// ── M11：R18 视频引擎 fixture（与后端 engine_registry _ltx_nsfw_video_params/_h3_nsfw_video_params 同形）──

/** 与后端 engine_registry _ltx_nsfw_video_params 同形（resolution/duration 预设 select + fps/steps/cfg + 双 switch） */
const LTX_NSFW_T2V: EngineInfo = {
  id: 'ltx-nsfw-t2v',
  label: 'LTX 2.3 文生视频(R18)',
  kind: 'video',
  available: true,
  nsfw: true,
  params: [
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    {
      key: 'resolution',
      label: '分辨率',
      type: 'select',
      default: '1280x720',
      options: [
        { value: '864x480', label: '480p 横版 (864×480)' },
        { value: '1280x720', label: '720p 横版 (1280×720)' },
        { value: '1920x1080', label: '1080p 横版 (1920×1080)' },
        { value: '480x864', label: '480p 竖版 (480×864)' },
        { value: '720x1280', label: '720p 竖版 (720×1280)' },
      ],
    },
    {
      key: 'duration',
      label: '时长',
      type: 'select',
      default: '6',
      options: [
        { value: '6', label: '6 秒' },
        { value: '10', label: '10 秒' },
        { value: '15', label: '15 秒' },
      ],
    },
    { key: 'fps', label: '帧率', type: 'number', default: 16, min: 4, max: 30 },
    { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 50 },
    { key: 'cfg', label: 'CFG', type: 'number', default: 1.0, min: 0, max: 20, step: 0.5 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
    { key: 'use_upscale', label: '高清放大(2 阶段)', type: 'switch', default: false },
    { key: 'use_rife', label: 'RIFE 补帧', type: 'switch', default: false },
  ],
};

/** ltx-nsfw-i2v = 参考图（max=1）+ ltx-nsfw t2v 参数全集 */
const LTX_NSFW_I2V: EngineInfo = {
  id: 'ltx-nsfw-i2v',
  label: 'LTX 2.3 图生视频(R18)',
  kind: 'video',
  available: true,
  nsfw: true,
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...LTX_NSFW_T2V.params,
  ],
};

/** ltx-nsfw-lipsync = 人物参考图 + audio 型驱动音频 + t2v 参数 + ID LoRA */
const LTX_NSFW_LIPSYNC: EngineInfo = {
  id: 'ltx-nsfw-lipsync',
  label: 'LTX 2.3 对口型(R18)',
  kind: 'video',
  available: true,
  nsfw: true,
  params: [
    { key: 'images', label: '人物参考图', type: 'images', max: 1, default: null },
    { key: 'audio', label: '驱动音频', type: 'audio', default: null },
    ...LTX_NSFW_T2V.params,
    { key: 'id_lora', label: 'ID LoRA(可选)', type: 'text', default: '' },
    { key: 'id_lora_strength', label: 'ID LoRA 强度', type: 'number', default: 0.8, min: 0, max: 2, step: 0.1 },
  ],
};

/** 与后端 engine_registry _h3_nsfw_video_params 同形（resolution/duration 预设 select + steps + loras，无 fps/cfg） */
const H3_NSFW_T2V: EngineInfo = {
  id: 'h3-nsfw-t2v',
  label: 'MiniMax H3 文生视频(R18)',
  kind: 'video',
  available: true,
  nsfw: true,
  params: [
    { key: 'negative', label: '负向提示词', type: 'textarea', default: '' },
    {
      key: 'resolution',
      label: '分辨率',
      type: 'select',
      default: '1280x736',
      options: [
        { value: '832x480', label: '480p 横版 (832×480)' },
        { value: '1280x736', label: '720p 横版 (1280×736)' },
        { value: '768x1344', label: '768p 竖版 (768×1344)' },
      ],
    },
    {
      key: 'duration',
      label: '时长',
      type: 'select',
      default: '6',
      options: [
        { value: '6', label: '6 秒 (141 帧)' },
        { value: '10', label: '10 秒 (243 帧)' },
        { value: '15', label: '15 秒 (362 帧)' },
      ],
    },
    { key: 'steps', label: '采样步数', type: 'number', default: 20, min: 1, max: 50 },
    { key: 'seed', label: '随机种子', type: 'text', default: '' },
    {
      key: 'loras',
      label: 'LoRA 叠加',
      type: 'loras',
      default: [],
      options: H3_LORA_OPTIONS,
      min: 0.5,
      max: 1.0,
      step: 0.05,
    },
  ],
};

/** h3-nsfw-i2v = 参考图（max=1）+ h3-nsfw t2v 参数全集 */
const H3_NSFW_I2V: EngineInfo = {
  id: 'h3-nsfw-i2v',
  label: 'MiniMax H3 图生视频(R18)',
  kind: 'video',
  available: true,
  nsfw: true,
  params: [
    { key: 'images', label: '参考图', type: 'images', max: 1, default: null },
    ...H3_NSFW_T2V.params,
  ],
};

const REF_A = { filename: 'a.png', worker: 'http://w1', previewUri: 'file:///tmp/a.png', name: 'a.png' };
const REF_B = { filename: 'b.png', worker: 'http://w1', previewUri: 'file:///tmp/b.png', name: 'b.png' };
const VIDEO_REF = { filename: 'drive.mp4', worker: 'http://w1', name: 'drive.mp4', durationMs: 5200 };
const AUDIO_REF = { filename: 'voice.wav', worker: 'http://w1', name: 'voice.wav' };

/** M9/M10/M11 纯逻辑出口（jest.requireActual 取真实模块，与 buildImg2ImgRequest 既有用例同模式） */
const logic = jest.requireActual('../generate-screen') as {
  buildLtx25T2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown>;
  buildLtx25I2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildWanAnimateRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildWanVaceRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildH3T2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown>;
  buildH3I2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildLongCatT2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown>;
  buildLongCatI2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildLongCatContinueRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildAceMusicRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown>;
  buildLtxNsfwT2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown>;
  buildLtxNsfwI2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildLtxNsfwLipsyncRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildH3NsfwT2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown>;
  buildH3NsfwI2VRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  buildAvatarTalkRequest: (e: EngineInfo, v: Record<string, unknown>, p: string) => Record<string, unknown> | null;
  normalizeEngineSchema: (e: EngineInfo) => EngineInfo;
  parseLoraValues: (raw: unknown) => { name: string; strength: number }[];
  buildEngineSubmit: (
    e: EngineInfo,
    v: Record<string, unknown>,
    p: string,
  ) => { ok: true; payload: { type: string; req: Record<string, unknown> } } | { ok: false; error: string };
  engineNeedsVideo: (e: EngineInfo) => boolean;
  engineNeedsAudio: (e: EngineInfo) => boolean;
  engineMaxRefImages: (e: EngineInfo) => number;
  isSupportedEngine: (e: EngineInfo) => boolean;
  readUploadedRefs: (e: EngineInfo, v: Record<string, unknown>) => unknown[];
  syncVideoWithRefImage: (
    e: EngineInfo,
    v: Record<string, unknown>,
    changedKey: string,
  ) => Record<string, unknown>;
  syncAudioWithRefImage: (
    e: EngineInfo,
    v: Record<string, unknown>,
    changedKey: string,
  ) => Record<string, unknown>;
};

describe('GenerateScreen 视频引擎请求构建（M9.2 纯逻辑）', () => {
  it('buildLtx25T2VRequest：schema 默认值全量进请求体，空 negative/seed 省略', () => {
    expect(logic.buildLtx25T2VRequest(LTX25_T2V, {}, '一只猫在跑步')).toEqual({
      positive: '一只猫在跑步',
      width: 960,
      height: 544,
      duration_sec: 5,
      fps: 24,
      steps: 8,
    });
  });

  it('buildLtx25T2VRequest：自定义数值 + negative + seed 精确序列化，编辑中 "" 回落 default', () => {
    const req = logic.buildLtx25T2VRequest(
      LTX25_T2V,
      { width: 1280, height: '', duration: 10, fps: 30, steps: 12, negative: ' 低画质 ', seed: '42' },
      '一只猫',
    );
    expect(req).toEqual({
      positive: '一只猫',
      negative: '低画质',
      width: 1280,
      height: 544,
      duration_sec: 10,
      fps: 30,
      steps: 12,
      seed: 42,
    });
  });

  it('buildLtx25I2VRequest：无参考图返回 null；有参考图携 image/worker + strength 默认 0.7', () => {
    expect(logic.buildLtx25I2VRequest(LTX25_I2V, {}, '一只猫')).toBeNull();
    const req = logic.buildLtx25I2VRequest(LTX25_I2V, { images: REF_A }, '一只猫');
    expect(req).toEqual({
      positive: '一只猫',
      image: 'a.png',
      worker: 'http://w1',
      width: 960,
      height: 544,
      duration_sec: 5,
      fps: 24,
      steps: 8,
      strength: 0.7,
    });
  });

  it('buildLtx25I2VRequest：自定义 strength 覆盖默认', () => {
    const req = logic.buildLtx25I2VRequest(LTX25_I2V, { images: REF_A, strength: 1 }, '一只猫');
    expect(req).toMatchObject({ strength: 1 });
  });

  it('buildWanAnimateRequest：缺参考图或缺驱动视频返回 null', () => {
    expect(logic.buildWanAnimateRequest(WAN_ANIMATE, {}, '跳舞')).toBeNull();
    expect(logic.buildWanAnimateRequest(WAN_ANIMATE, { images: REF_A }, '跳舞')).toBeNull();
    expect(logic.buildWanAnimateRequest(WAN_ANIMATE, { video: VIDEO_REF }, '跳舞')).toBeNull();
  });

  it('buildWanAnimateRequest：image/video 互钉（worker 取参考图落点）+ wan 数值键全量', () => {
    const req = logic.buildWanAnimateRequest(
      WAN_ANIMATE,
      { images: REF_A, video: VIDEO_REF, negative: '模糊', seed: '7' },
      '跳舞',
    );
    expect(req).toEqual({
      positive: '跳舞',
      image: 'a.png',
      video: 'drive.mp4',
      worker: 'http://w1',
      negative: '模糊',
      width: 832,
      height: 480,
      duration_sec: 7.5,
      steps: 6,
      fps: 16,
      seed: 7,
    });
  });

  it('buildWanAnimateRequest：驱动视频钉在别的 worker 时不兜底（构建期不纠，联动清理由 syncVideoWithRefImage 负责）', () => {
    const strayVideo = { ...VIDEO_REF, worker: 'http://w2' };
    const req = logic.buildWanAnimateRequest(WAN_ANIMATE, { images: REF_A, video: strayVideo }, '跳舞');
    expect(req).toMatchObject({ video: 'drive.mp4', worker: 'http://w1' });
  });

  it('buildWanVaceRequest：无参考图返回 null；多张取 filename 数组 + 第一张落点 worker', () => {
    expect(logic.buildWanVaceRequest(WAN_VACE, { images: [] }, '多图视频')).toBeNull();
    const req = logic.buildWanVaceRequest(WAN_VACE, { images: [REF_A, REF_B] }, '多图视频');
    expect(req).toEqual({
      positive: '多图视频',
      images: ['a.png', 'b.png'],
      worker: 'http://w1',
      width: 832,
      height: 480,
      duration_sec: 5,
      steps: 20,
      fps: 16,
    });
  });

  it('buildEngineSubmit 路由：ltx25-t2v / ltx25-i2v / wan-animate / wan-vace 各归其位', () => {
    expect(logic.buildEngineSubmit(LTX25_T2V, {}, '一只猫')).toEqual({
      ok: true,
      payload: {
        type: 'ltx25-t2v',
        req: { positive: '一只猫', width: 960, height: 544, duration_sec: 5, fps: 24, steps: 8 },
      },
    });
    const i2v = logic.buildEngineSubmit(LTX25_I2V, { images: REF_A }, '一只猫');
    expect(i2v).toMatchObject({ ok: true, payload: { type: 'ltx25-i2v' } });
    const animate = logic.buildEngineSubmit(WAN_ANIMATE, { images: REF_A, video: VIDEO_REF }, '跳舞');
    expect(animate).toMatchObject({ ok: true, payload: { type: 'wan-animate' } });
    const vace = logic.buildEngineSubmit(WAN_VACE, { images: [REF_A] }, '多图');
    expect(vace).toMatchObject({ ok: true, payload: { type: 'wan-vace' } });
  });

  it('buildEngineSubmit 校验文案对齐 Web：缺单图/缺多图/缺驱动视频', () => {
    expect(logic.buildEngineSubmit(LTX25_I2V, {}, '一只猫')).toEqual({
      ok: false,
      error: '请先上传参考图',
    });
    expect(logic.buildEngineSubmit(WAN_VACE, {}, '多图')).toEqual({
      ok: false,
      error: '请先上传参考图(至少 1 张)',
    });
    expect(logic.buildEngineSubmit(WAN_ANIMATE, { images: REF_A }, '跳舞')).toEqual({
      ok: false,
      error: '请先上传驱动视频',
    });
    // 校验顺序：参考图先于驱动视频（对齐 Web submitEngineGeneration）
    expect(logic.buildEngineSubmit(WAN_ANIMATE, {}, '跳舞')).toEqual({
      ok: false,
      error: '请先上传参考图',
    });
  });

  it('buildEngineSubmit 既有图像引擎行为不变：txt2img / img2img（缺图报错）', () => {
    const txt = logic.buildEngineSubmit(TXT2IMG, {}, '一只猫');
    expect(txt).toMatchObject({ ok: true, payload: { type: 'txt2img' } });
    expect(logic.buildEngineSubmit(IMG2IMG, {}, '一只猫')).toEqual({
      ok: false,
      error: '请先上传参考图',
    });
    const i2i = logic.buildEngineSubmit(IMG2IMG, { images: REF_A }, '一只猫');
    expect(i2i).toMatchObject({ ok: true, payload: { type: 'img2img' } });
  });

  it('buildEngineSubmit 未知引擎兜底：带 images 走 img2img，否则 txt2img', () => {
    const unknownWithImages: EngineInfo = { ...IMG2IMG, id: 'mystery-i2i' };
    const unknownPlain: EngineInfo = { ...TXT2IMG, id: 'mystery-t2i' };
    expect(logic.buildEngineSubmit(unknownWithImages, { images: REF_A }, 'x')).toMatchObject({
      ok: true,
      payload: { type: 'img2img' },
    });
    expect(logic.buildEngineSubmit(unknownPlain, {}, 'x')).toMatchObject({
      ok: true,
      payload: { type: 'txt2img' },
    });
  });

  it('engineNeedsVideo / engineMaxRefImages 判定', () => {
    expect(logic.engineNeedsVideo(WAN_ANIMATE)).toBe(true);
    expect(logic.engineNeedsVideo(LTX25_T2V)).toBe(false);
    expect(logic.engineNeedsVideo(LTX25_I2V)).toBe(false);
    expect(logic.engineMaxRefImages(WAN_VACE)).toBe(4);
    expect(logic.engineMaxRefImages(LTX25_I2V)).toBe(1);
    expect(logic.engineMaxRefImages(TXT2IMG)).toBe(1);
  });

  it('isSupportedEngine 白名单：M9/M10/M11/M14 引擎 + 既有图像引擎可选，未知引擎不可选', () => {
    for (const e of [
      TXT2IMG,
      IMG2IMG,
      LTX25_T2V,
      LTX25_I2V,
      WAN_ANIMATE,
      WAN_VACE,
      H3_T2V,
      H3_I2V,
      LONGCAT_T2V,
      LONGCAT_I2V,
      LONGCAT_CONTINUE,
      ACE_MUSIC,
      LTX_NSFW_T2V,
      LTX_NSFW_I2V,
      LTX_NSFW_LIPSYNC,
      H3_NSFW_T2V,
      H3_NSFW_I2V,
      AVATAR_TALK,
    ]) {
      expect(logic.isSupportedEngine(e)).toBe(true);
    }
    // 白名单外未知引擎未接入移动端提交链路
    expect(logic.isSupportedEngine(UNKNOWN_VIDEO)).toBe(false);
  });

  it('readUploadedRefs：多图数组过滤脏数据；单图对象归一为数组；缺失空数组', () => {
    expect(logic.readUploadedRefs(WAN_VACE, { images: [REF_A, { bad: true }, REF_B] })).toEqual([
      REF_A,
      REF_B,
    ]);
    expect(logic.readUploadedRefs(LTX25_I2V, { images: REF_A })).toEqual([REF_A]);
    expect(logic.readUploadedRefs(WAN_VACE, {})).toEqual([]);
    expect(logic.readUploadedRefs(WAN_VACE, { images: 'not-an-object' })).toEqual([]);
  });

  it('syncVideoWithRefImage：参考图换 worker 后清空钉在旧 worker 的驱动视频（对齐 Web 强制重传）', () => {
    const values = { images: REF_A, video: VIDEO_REF };
    // 参考图换成另一台 worker 的图 → 视频清空
    const moved = { ...REF_A, filename: 'c.png', worker: 'http://w2' };
    expect(logic.syncVideoWithRefImage(WAN_ANIMATE, { images: moved, video: VIDEO_REF }, 'images')).toEqual({
      images: moved,
      video: null,
    });
    // 同 worker 换图 → 视频保留
    expect(logic.syncVideoWithRefImage(WAN_ANIMATE, values, 'images')).toEqual(values);
    // 改其他键 → 原样
    expect(logic.syncVideoWithRefImage(WAN_ANIMATE, { ...values, negative: 'x' }, 'negative')).toEqual({
      ...values,
      negative: 'x',
    });
    // 移除参考图（null）→ 视频也清空（无钉点可依附）
    expect(logic.syncVideoWithRefImage(WAN_ANIMATE, { images: null, video: VIDEO_REF }, 'images')).toEqual({
      images: null,
      video: null,
    });
    // 无 video 参数引擎 → 原样
    expect(logic.syncVideoWithRefImage(LTX25_I2V, { images: REF_A }, 'images')).toEqual({
      images: REF_A,
    });
  });
});

// ── M9.3：视频引擎 UI（列表放开 + 禁用态 + 多图 + 驱动视频字段）──

const mockSubmitLtx25T2V = submitLtx25T2V as jest.MockedFunction<typeof submitLtx25T2V>;
const mockSubmitLtx25I2V = submitLtx25I2V as jest.MockedFunction<typeof submitLtx25I2V>;
const mockSubmitWanAnimate = submitWanAnimate as jest.MockedFunction<typeof submitWanAnimate>;
const mockSubmitWanVace = submitWanVace as jest.MockedFunction<typeof submitWanVace>;
const mockUploadImage = uploadImage as jest.MockedFunction<typeof uploadImage>;
const mockUploadVideo = uploadVideo as jest.MockedFunction<typeof uploadVideo>;
const mockLaunch = ImagePicker.launchImageLibraryAsync as jest.MockedFunction<
  typeof ImagePicker.launchImageLibraryAsync
>;
const mockReverse = reversePrompt as jest.MockedFunction<typeof reversePrompt>;
const mockOptimize = optimizePrompt as jest.MockedFunction<typeof optimizePrompt>;

/** 构造图片 asset（expo-image-picker v57 字段子集） */
function imageAsset(name: string) {
  return {
    uri: `file:///tmp/${name}`,
    fileName: name,
    mimeType: 'image/png',
    fileSize: 1024,
    width: 512,
    height: 512,
  };
}

/** 构造视频 asset（duration 毫秒，对齐 v57 asset 契约） */
function videoAsset(name: string) {
  return {
    uri: `file:///tmp/${name}`,
    fileName: name,
    mimeType: 'video/mp4',
    fileSize: 2048,
    duration: 5200,
    width: 1280,
    height: 720,
  };
}

/** 可提交视频引擎全量（含 M14 avatar-talk）+ 白名单外禁用样本 */
const M9_ENGINES = [TXT2IMG, LTX25_T2V, LTX25_I2V, WAN_ANIMATE, WAN_VACE, AVATAR_TALK, UNKNOWN_VIDEO];

describe('GenerateScreen 视频引擎 UI（M9.3）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue(M9_ENGINES);
  });

  it('4 个 SFW 视频引擎芯片 + avatar-talk（M14）可选，白名单外引擎禁用态且点击不切换选中', async () => {
    mockSubmit.mockResolvedValue({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx25-t2v')).toBeTruthy());
    for (const id of ['ltx25-t2v', 'ltx25-i2v', 'wan-animate', 'wan-vace', 'avatar-talk']) {
      expect(screen.getByTestId(`engine-chip-${id}`).props.accessibilityState.disabled).toBe(false);
    }
    // 未接入引擎禁用态，点击不生效（默认选中仍是首个可提交引擎 txt2img）
    const unknown = screen.getByTestId('engine-chip-ltx2-t2v');
    expect(unknown.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(unknown);
    await submitPrompt('一只猫');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalled();
    expect(mockSubmitLtx25T2V).not.toHaveBeenCalled();
  });

  it('选中 ltx25-t2v 提交：路由到 submitLtx25T2V 并携 schema 默认值', async () => {
    mockSubmitLtx25T2V.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx25-t2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ltx25-t2v'));
    await submitPrompt('一只猫在跑步');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitLtx25T2V).toHaveBeenCalledWith({
      positive: '一只猫在跑步',
      width: 960,
      height: 544,
      duration_sec: 5,
      fps: 24,
      steps: 8,
    });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('ltx25-i2v 未上传参考图提交报「请先上传参考图」，不调提交 API', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx25-i2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ltx25-i2v'));
    await submitPrompt('一只猫');
    expect(screen.getByText('请先上传参考图')).toBeTruthy();
    expect(mockSubmitLtx25I2V).not.toHaveBeenCalled();
  });

  it('wan-animate 抽屉展示驱动视频字段；wan-vace 抽屉展示多图字段（label 带计数）', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-wan-animate')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-wan-animate'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    expect(screen.getByTestId('param-sheet-field-video-pick')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await fireEvent.press(screen.getByTestId('engine-chip-wan-vace'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    expect(screen.getByTestId('param-sheet-field-images-pick')).toBeTruthy();
    expect(screen.getByText('参考图(1-4 张)(0/4)')).toBeTruthy();
  });

  it('wan-animate 有参考图无驱动视频提交报「请先上传驱动视频」（上传走 wan_animate kind）', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('a.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-wan-animate')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-wan-animate'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));

    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());
    expect(mockUploadImage).toHaveBeenCalledWith(
      { uri: 'file:///tmp/a.png', fileName: 'a.png', mimeType: 'image/png' },
      'wan_animate',
    );
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('跳舞');
    expect(screen.getByText('请先上传驱动视频')).toBeTruthy();
    expect(mockSubmitWanAnimate).not.toHaveBeenCalled();
  });

  it('wan-animate 驱动视频上传钉参考图落点 worker，选视频用 videos 媒体类型', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('a.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-wan-animate')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-wan-animate'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());

    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [videoAsset('d.mp4')] } as never);
    mockUploadVideo.mockResolvedValueOnce({ filename: 'drive.mp4', worker: 'http://w1' });
    await fireEvent.press(screen.getByTestId('param-sheet-field-video-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-video-preview')).toBeTruthy());

    // 选视频媒体类型 + 上传钉参考图 worker（对齐 Web RefVideoUpload pinWorker）
    expect(mockLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ mediaTypes: ['videos'] }),
    );
    expect(mockUploadVideo).toHaveBeenCalledWith(
      { uri: 'file:///tmp/d.mp4', fileName: 'd.mp4', mimeType: 'video/mp4' },
      'wan_animate',
      'http://w1',
    );
  });

  it('wan-animate 完整链路：参考图 + 驱动视频 → submitWanAnimate 携互钉句柄', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('a.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' });
    mockSubmitWanAnimate.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-wan-animate')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-wan-animate'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());

    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [videoAsset('d.mp4')] } as never);
    mockUploadVideo.mockResolvedValueOnce({ filename: 'drive.mp4', worker: 'http://w1' });
    await fireEvent.press(screen.getByTestId('param-sheet-field-video-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-video-preview')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('跳舞');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitWanAnimate).toHaveBeenCalledWith({
      positive: '跳舞',
      image: 'a.png',
      video: 'drive.mp4',
      worker: 'http://w1',
      width: 832,
      height: 480,
      duration_sec: 7.5,
      steps: 6,
      fps: 16,
    });
  });

  it('wan-vace 多图一次多选：第二张起钉第一张落点 worker，提交携 filename 数组', async () => {
    mockLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [imageAsset('a.png'), imageAsset('b.png')],
    } as never);
    mockUploadImage
      .mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' })
      .mockResolvedValueOnce({ filename: 'b.png', worker: 'http://w1' });
    mockSubmitWanVace.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-wan-vace')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-wan-vace'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));

    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-item-1')).toBeTruthy());
    // 多图互钉：第一张自由落点，第二张钉第一张 worker（对齐 Web RefImagesUpload）
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
      'http://w1',
    );
    expect(screen.getByText('参考图(1-4 张)(2/4)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('多图视频');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitWanVace).toHaveBeenCalledWith({
      positive: '多图视频',
      images: ['a.png', 'b.png'],
      worker: 'http://w1',
      width: 832,
      height: 480,
      duration_sec: 5,
      steps: 20,
      fps: 16,
    });
  });

  it('移除参考图后已上传驱动视频同步清空（联动对齐 Web 强制重传）', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('a.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-wan-animate')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-wan-animate'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());

    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [videoAsset('d.mp4')] } as never);
    mockUploadVideo.mockResolvedValueOnce({ filename: 'drive.mp4', worker: 'http://w1' });
    await fireEvent.press(screen.getByTestId('param-sheet-field-video-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-video-preview')).toBeTruthy());

    // 移除参考图 → 驱动视频钉点失效，同步清空回到待上传态
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-remove'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-video-pick')).toBeTruthy());
    expect(screen.queryByTestId('param-sheet-field-video-preview')).toBeNull();
  });
});

// ── M10.2：H3 / LongCat / ACE 请求构建与提交路由 ──

describe('GenerateScreen H3/LongCat/ACE 请求构建（M10.2 纯逻辑）', () => {
  it('buildH3T2VRequest：schema 默认值全量进请求体，空 negative/seed 省略，loras 缺省空数组', () => {
    expect(logic.buildH3T2VRequest(H3_T2V, {}, '海浪拍打礁石')).toEqual({
      positive: '海浪拍打礁石',
      width: 1344,
      height: 768,
      duration_sec: 5,
      steps: 20,
      loras: [],
    });
  });

  it('buildH3T2VRequest：自定义数值构建期 clamp 到 schema 边界，negative/seed 精确序列化', () => {
    const req = logic.buildH3T2VRequest(
      H3_T2V,
      { width: 9999, duration: 10, steps: 28, negative: ' 低画质 ', seed: '42' },
      '一只猫',
    );
    expect(req).toEqual({
      positive: '一只猫',
      negative: '低画质',
      width: 1344, // 超 max 1344 被 clamp
      height: 768,
      duration_sec: 10,
      steps: 28,
      seed: 42,
      loras: [],
    });
  });

  it('buildH3T2VRequest：loras 数组原样透传，强度缺省 0.6 并钳到 0.5-1.0', () => {
    const req = logic.buildH3T2VRequest(
      H3_T2V,
      {
        loras: [
          { name: 'film.safetensors', strength: 0.85 },
          { name: 'motion.safetensors' }, // 缺 strength → 0.6
          { name: 'hot.safetensors', strength: 1.4 }, // 超上限 → 钳 1.0
          { name: 'weak.safetensors', strength: 0.1 }, // 低下限 → 钳 0.5
        ],
      },
      '一只猫',
    );
    expect(req).toMatchObject({
      loras: [
        { name: 'film.safetensors', strength: 0.85 },
        { name: 'motion.safetensors', strength: 0.6 },
        { name: 'hot.safetensors', strength: 1.0 },
        { name: 'weak.safetensors', strength: 0.5 },
      ],
    });
  });

  it('parseLoraValues：非数组/脏项过滤，强度非法回落 0.6', () => {
    expect(logic.parseLoraValues(null)).toEqual([]);
    expect(logic.parseLoraValues('not-array')).toEqual([]);
    expect(
      logic.parseLoraValues([{ name: 'a.safetensors', strength: 0.7 }, { bad: true }, null, 'junk']),
    ).toEqual([{ name: 'a.safetensors', strength: 0.7 }]);
    expect(logic.parseLoraValues([{ name: 'a.safetensors', strength: Number.NaN }])).toEqual([
      { name: 'a.safetensors', strength: 0.6 },
    ]);
  });

  it('buildH3I2VRequest：无参考图返回 null；有参考图携 image/worker + loras', () => {
    expect(logic.buildH3I2VRequest(H3_I2V, {}, '一只猫')).toBeNull();
    const req = logic.buildH3I2VRequest(
      H3_I2V,
      { images: REF_A, loras: [{ name: 'film.safetensors', strength: 0.6 }] },
      '一只猫',
    );
    expect(req).toEqual({
      positive: '一只猫',
      image: 'a.png',
      worker: 'http://w1',
      width: 1344,
      height: 768,
      duration_sec: 5,
      steps: 20,
      loras: [{ name: 'film.safetensors', strength: 0.6 }],
    });
  });

  it('buildLongCatT2VRequest：schema 默认值全量进请求体（无 cfg），空 negative/seed 省略', () => {
    expect(logic.buildLongCatT2VRequest(LONGCAT_T2V, {}, '延时摄影的城市')).toEqual({
      positive: '延时摄影的城市',
      width: 832,
      height: 480,
      duration_sec: 7.5,
      steps: 10,
      fps: 16,
    });
  });

  it('buildLongCatI2VRequest：无参考图返回 null；有参考图携 image/worker', () => {
    expect(logic.buildLongCatI2VRequest(LONGCAT_I2V, {}, '一只猫')).toBeNull();
    const req = logic.buildLongCatI2VRequest(LONGCAT_I2V, { images: REF_A, duration: 15 }, '一只猫');
    expect(req).toEqual({
      positive: '一只猫',
      image: 'a.png',
      worker: 'http://w1',
      width: 832,
      height: 480,
      duration_sec: 15,
      steps: 10,
      fps: 16,
    });
  });

  it('buildLongCatContinueRequest：源视频 URL 空/空白返回 null；合法 URL trim 后携带', () => {
    expect(logic.buildLongCatContinueRequest(LONGCAT_CONTINUE, {}, '续写')).toBeNull();
    expect(logic.buildLongCatContinueRequest(LONGCAT_CONTINUE, { video: '   ' }, '续写')).toBeNull();
    const req = logic.buildLongCatContinueRequest(
      LONGCAT_CONTINUE,
      { video: '  /api/images?path=x.mp4  ', duration: 12.5 },
      '续写',
    );
    expect(req).toEqual({
      positive: '续写',
      video: '/api/images?path=x.mp4',
      width: 832,
      height: 480,
      duration_sec: 12.5,
      steps: 10,
      fps: 16,
    });
  });

  it('buildAceMusicRequest：positive 映射 tags，lyrics 空省略/非空携带，数值默认 30/50/5', () => {
    expect(logic.buildAceMusicRequest(ACE_MUSIC, {}, '轻快的 lo-fi')).toEqual({
      tags: '轻快的 lo-fi',
      seconds: 30,
      steps: 50,
      cfg: 5,
    });
    const req = logic.buildAceMusicRequest(
      ACE_MUSIC,
      { lyrics: ' [verse] 月光下 ', seconds: 60, seed: '7' },
      '钢琴曲',
    );
    expect(req).toEqual({
      tags: '钢琴曲',
      lyrics: '[verse] 月光下',
      seconds: 60,
      steps: 50,
      cfg: 5,
      seed: 7,
    });
  });

  it('buildEngineSubmit 路由：h3-t2v / longcat-t2v / ace-music 纯参数引擎各归其位', () => {
    const h3 = logic.buildEngineSubmit(H3_T2V, {}, '海浪');
    expect(h3).toMatchObject({ ok: true, payload: { type: 'h3-t2v' } });
    const longcat = logic.buildEngineSubmit(LONGCAT_T2V, {}, '城市');
    expect(longcat).toMatchObject({ ok: true, payload: { type: 'longcat-t2v' } });
    const ace = logic.buildEngineSubmit(ACE_MUSIC, {}, 'lo-fi');
    expect(ace).toEqual({
      ok: true,
      payload: { type: 'ace-music', req: { tags: 'lo-fi', seconds: 30, steps: 50, cfg: 5 } },
    });
  });

  it('buildEngineSubmit 路由：h3-i2v / longcat-i2v 缺参考图报错，有图各归其位', () => {
    expect(logic.buildEngineSubmit(H3_I2V, {}, '一只猫')).toEqual({
      ok: false,
      error: '请先上传参考图',
    });
    expect(logic.buildEngineSubmit(LONGCAT_I2V, {}, '一只猫')).toEqual({
      ok: false,
      error: '请先上传参考图',
    });
    expect(logic.buildEngineSubmit(H3_I2V, { images: REF_A }, '一只猫')).toMatchObject({
      ok: true,
      payload: { type: 'h3-i2v' },
    });
    expect(logic.buildEngineSubmit(LONGCAT_I2V, { images: REF_A }, '一只猫')).toMatchObject({
      ok: true,
      payload: { type: 'longcat-i2v' },
    });
  });

  it('buildEngineSubmit 校验：longcat-continue 缺源视频 URL 文案对齐 Web', () => {
    expect(logic.buildEngineSubmit(LONGCAT_CONTINUE, {}, '续写')).toEqual({
      ok: false,
      error: '请填写源视频产物 URL(/api/images?...)',
    });
    const ok = logic.buildEngineSubmit(
      LONGCAT_CONTINUE,
      { video: '/api/images?path=x.mp4' },
      '续写',
    );
    expect(ok).toMatchObject({ ok: true, payload: { type: 'longcat-continue' } });
  });
});

// ── M10.2：H3 / LongCat / ACE 提交链路 UI ──

const mockSubmitH3T2V = submitH3T2V as jest.MockedFunction<typeof submitH3T2V>;
const mockSubmitH3I2V = submitH3I2V as jest.MockedFunction<typeof submitH3I2V>;
const mockSubmitLongCatT2V = submitLongCatT2V as jest.MockedFunction<typeof submitLongCatT2V>;
const mockSubmitLongCatContinue = submitLongCatContinue as jest.MockedFunction<
  typeof submitLongCatContinue
>;
const mockSubmitAceMusic = submitAceMusic as jest.MockedFunction<typeof submitAceMusic>;

const M10_ENGINES = [TXT2IMG, H3_T2V, H3_I2V, LONGCAT_T2V, LONGCAT_I2V, LONGCAT_CONTINUE, ACE_MUSIC, AVATAR_TALK];

describe('GenerateScreen H3/LongCat/ACE 提交链路（M10.2 UI）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue(M10_ENGINES);
  });

  it('M10 引擎芯片全可选（含 kind=audio 的 ace-music 与 M14 avatar-talk）', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-h3-t2v')).toBeTruthy());
    for (const id of [
      'h3-t2v',
      'h3-i2v',
      'longcat-t2v',
      'longcat-i2v',
      'longcat-continue',
      'ace-music',
      'avatar-talk',
    ]) {
      expect(screen.getByTestId(`engine-chip-${id}`).props.accessibilityState.disabled).toBe(false);
    }
  });

  it('选中 h3-t2v 提交：路由 submitH3T2V 携 schema 默认值 + loras 空数组', async () => {
    mockSubmitH3T2V.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-h3-t2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-h3-t2v'));
    await submitPrompt('海浪拍打礁石');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitH3T2V).toHaveBeenCalledWith({
      positive: '海浪拍打礁石',
      width: 1344,
      height: 768,
      duration_sec: 5,
      steps: 20,
      loras: [],
    });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('h3-i2v 未上传参考图提交报「请先上传参考图」，不调提交 API', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-h3-i2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-h3-i2v'));
    await submitPrompt('一只猫');
    expect(screen.getByText('请先上传参考图')).toBeTruthy();
    expect(mockSubmitH3I2V).not.toHaveBeenCalled();
  });

  it('选中 longcat-t2v 提交：路由 submitLongCatT2V 携 schema 默认值', async () => {
    mockSubmitLongCatT2V.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-longcat-t2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-longcat-t2v'));
    await submitPrompt('延时摄影的城市');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitLongCatT2V).toHaveBeenCalledWith({
      positive: '延时摄影的城市',
      width: 832,
      height: 480,
      duration_sec: 7.5,
      steps: 10,
      fps: 16,
    });
  });

  it('longcat-continue 缺源视频 URL 报校验文案；填写后提交携 trim 后 URL', async () => {
    mockSubmitLongCatContinue.mockResolvedValueOnce({
      prompt_id: 'p1',
      client_id: 'c1',
      worker: 'w1',
      seed: 7,
    });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-longcat-continue')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-longcat-continue'));

    await submitPrompt('续写下一段');
    expect(screen.getByText('请填写源视频产物 URL(/api/images?...)')).toBeTruthy();
    expect(mockSubmitLongCatContinue).not.toHaveBeenCalled();

    // 参数抽屉填写源视频产物 URL（text 参数）
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.changeText(
      screen.getByTestId('param-sheet-field-video-input'),
      '  /api/images?path=seg1.mp4  ',
    );
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('续写下一段');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitLongCatContinue).toHaveBeenCalledWith({
      positive: '续写下一段',
      video: '/api/images?path=seg1.mp4',
      width: 832,
      height: 480,
      duration_sec: 7.5,
      steps: 10,
      fps: 16,
    });
  });

  it('选中 ace-music 提交：positive 映射 tags 路由 submitAceMusic 携默认值', async () => {
    mockSubmitAceMusic.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ace-music')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ace-music'));
    await submitPrompt('轻快的 lo-fi');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitAceMusic).toHaveBeenCalledWith({
      tags: '轻快的 lo-fi',
      seconds: 30,
      steps: 50,
      cfg: 5,
    });
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

// ── M10.3：loras 参数字段 UI 接入 ──

describe('GenerateScreen loras 字段（M10.3 UI）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue(M10_ENGINES);
  });

  it('h3-t2v 抽屉渲染 loras 字段：选择 LoRA + 步进强度后提交携 loras 数组', async () => {
    mockSubmitH3T2V.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-h3-t2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-h3-t2v'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));

    // loras 字段渲染（select/number 字段之外的第 6 类动态字段）
    expect(screen.getByTestId('param-sheet-field-loras')).toBeTruthy();
    // 选两个 LoRA，第二个步进一次强度（0.6 → 0.65）
    await fireEvent.press(screen.getByTestId('param-sheet-field-loras-opt-film.safetensors'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-loras-opt-motion.safetensors'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-loras-strength-motion.safetensors-plus'));
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('海浪拍打礁石');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitH3T2V).toHaveBeenCalledWith({
      positive: '海浪拍打礁石',
      width: 1344,
      height: 768,
      duration_sec: 5,
      steps: 20,
      loras: [
        { name: 'film.safetensors', strength: 0.6 },
        { name: 'motion.safetensors', strength: 0.65 },
      ],
    });
  });

  it('非 H3 引擎不渲染 loras 字段（schema 无该参数）', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    expect(screen.queryByTestId('param-sheet-field-loras')).toBeNull();
  });
});

// ── M11.2：R18 视频引擎请求构建（纯逻辑）──

describe('GenerateScreen R18 视频引擎请求构建（M11.2 纯逻辑）', () => {
  it('buildLtxNsfwT2VRequest：resolution 预设换算宽高 + duration 预设直传 duration_sec，双 switch 始终携带', () => {
    expect(logic.buildLtxNsfwT2VRequest(LTX_NSFW_T2V, {}, '夜色')).toEqual({
      positive: '夜色',
      width: 1280,
      height: 720,
      duration_sec: 6, // 6 秒档直传;8k+1 网格/裁切由后端统一策略层负责
      use_upscale: false,
      use_rife: false,
      fps: 16,
      steps: 20,
      cfg: 1,
    });
  });

  it('buildLtxNsfwT2VRequest：自定义预设/帧率直传，negative/seed 精确序列化', () => {
    const req = logic.buildLtxNsfwT2VRequest(
      LTX_NSFW_T2V,
      {
        resolution: '480x864',
        duration: '10',
        fps: 24,
        steps: 28,
        cfg: 2.5,
        seed: '42',
        negative: ' 低画质 ',
        use_upscale: true,
        use_rife: true,
      },
      '一段影像',
    );
    expect(req).toEqual({
      positive: '一段影像',
      negative: '低画质',
      width: 480,
      height: 864,
      duration_sec: 10,
      fps: 24,
      steps: 28,
      cfg: 2.5,
      seed: 42,
      use_upscale: true,
      use_rife: true,
    });
  });

  it('buildLtxNsfwT2VRequest：非法 resolution 回落默认预设；时长秒数直传(上限校验归后端)', () => {
    const req = logic.buildLtxNsfwT2VRequest(
      LTX_NSFW_T2V,
      { resolution: 'bogus', duration: '15', fps: 30 },
      '一段影像',
    );
    // 15s 直传;帧数换算/上限钳制由后端统一策略层负责(超上限 422 有文案)
    expect(req).toMatchObject({ width: 1280, height: 720, duration_sec: 15 });
  });

  it('buildLtxNsfwI2VRequest：无参考图返回 null；有参考图携 image/worker + t2v 全集', () => {
    expect(logic.buildLtxNsfwI2VRequest(LTX_NSFW_I2V, {}, '一只猫')).toBeNull();
    const req = logic.buildLtxNsfwI2VRequest(LTX_NSFW_I2V, { images: REF_A }, '一只猫');
    expect(req).toEqual({
      positive: '一只猫',
      image: 'a.png',
      worker: 'http://w1',
      width: 1280,
      height: 720,
      duration_sec: 6,
      use_upscale: false,
      use_rife: false,
      fps: 16,
      steps: 20,
      cfg: 1,
    });
  });

  it('buildLtxNsfwLipsyncRequest：缺参考图/驱动音频返回 null；齐全携互钉句柄 + id_lora 规则', () => {
    expect(logic.buildLtxNsfwLipsyncRequest(LTX_NSFW_LIPSYNC, {}, '对口型')).toBeNull();
    // 有图无音频 → null
    expect(logic.buildLtxNsfwLipsyncRequest(LTX_NSFW_LIPSYNC, { images: REF_A }, '对口型')).toBeNull();
    const req = logic.buildLtxNsfwLipsyncRequest(
      LTX_NSFW_LIPSYNC,
      { images: REF_A, audio: AUDIO_REF, id_lora: '  id.safetensors ' },
      '对口型',
    );
    expect(req).toEqual({
      positive: '对口型',
      image: 'a.png',
      audio: 'voice.wav',
      worker: 'http://w1',
      width: 1280,
      height: 720,
      duration_sec: 6,
      use_upscale: false,
      use_rife: false,
      fps: 16,
      steps: 20,
      cfg: 1,
      id_lora: 'id.safetensors',
      id_lora_strength: 0.8,
    });
    // id_lora 空白 → trim 后省略（留空不用）
    const blank = logic.buildLtxNsfwLipsyncRequest(
      LTX_NSFW_LIPSYNC,
      { images: REF_A, audio: AUDIO_REF, id_lora: '   ' },
      '对口型',
    );
    expect(blank).not.toHaveProperty('id_lora');
  });

  it('buildH3NsfwT2VRequest：resolution 预设换算 32 对齐宽高 + duration 预设直传 duration_sec，loras 叠加', () => {
    expect(logic.buildH3NsfwT2VRequest(H3_NSFW_T2V, {}, '海浪')).toEqual({
      positive: '海浪',
      width: 1280,
      height: 736,
      duration_sec: 6, // 6 秒档直传;17k+5 网格由后端统一策略层负责(含新增 4s/8s 档)
      steps: 20,
      loras: [],
    });
    const req = logic.buildH3NsfwT2VRequest(
      H3_NSFW_T2V,
      {
        resolution: '768x1344',
        duration: '15',
        steps: 28,
        seed: '7',
        loras: [{ name: 'film.safetensors', strength: 0.8 }],
      },
      '海浪',
    );
    expect(req).toEqual({
      positive: '海浪',
      width: 768,
      height: 1344,
      duration_sec: 15, // 15 秒档直传(上限档)
      steps: 28,
      seed: 7,
      loras: [{ name: 'film.safetensors', strength: 0.8 }],
    });
  });

  it('buildH3NsfwT2VRequest：非法 duration 档回落 6 秒(数值档直传,后端网格吸附)', () => {
    // 非数值 → 回落默认 6s
    expect(logic.buildH3NsfwT2VRequest(H3_NSFW_T2V, { duration: 'abc' }, '海浪')).toMatchObject({
      duration_sec: 6,
    });
    // 数值档(含新增 4s/8s)直传,不再前端查帧数表
    expect(logic.buildH3NsfwT2VRequest(H3_NSFW_T2V, { duration: '8' }, '海浪')).toMatchObject({
      duration_sec: 8,
    });
  });

  it('buildH3NsfwI2VRequest：无参考图返回 null；有参考图携 image/worker + t2v 全集', () => {
    expect(logic.buildH3NsfwI2VRequest(H3_NSFW_I2V, {}, '一只猫')).toBeNull();
    const req = logic.buildH3NsfwI2VRequest(H3_NSFW_I2V, { images: REF_A, duration: '10' }, '一只猫');
    expect(req).toEqual({
      positive: '一只猫',
      image: 'a.png',
      worker: 'http://w1',
      width: 1280,
      height: 736,
      duration_sec: 10,
      steps: 20,
      loras: [],
    });
  });

  it('buildEngineSubmit 路由：5 个 R18 引擎各归其位', () => {
    expect(logic.buildEngineSubmit(LTX_NSFW_T2V, {}, '夜色')).toMatchObject({
      ok: true,
      payload: { type: 'ltx-nsfw-t2v' },
    });
    expect(logic.buildEngineSubmit(LTX_NSFW_I2V, { images: REF_A }, '一只猫')).toMatchObject({
      ok: true,
      payload: { type: 'ltx-nsfw-i2v' },
    });
    expect(
      logic.buildEngineSubmit(LTX_NSFW_LIPSYNC, { images: REF_A, audio: AUDIO_REF }, '对口型'),
    ).toMatchObject({ ok: true, payload: { type: 'ltx-nsfw-lipsync' } });
    expect(logic.buildEngineSubmit(H3_NSFW_T2V, {}, '海浪')).toMatchObject({
      ok: true,
      payload: { type: 'h3-nsfw-t2v' },
    });
    expect(logic.buildEngineSubmit(H3_NSFW_I2V, { images: REF_A }, '一只猫')).toMatchObject({
      ok: true,
      payload: { type: 'h3-nsfw-i2v' },
    });
  });

  it('buildEngineSubmit 校验：lipsync 先参考图后驱动音频（文案对齐 Web）', () => {
    expect(logic.buildEngineSubmit(LTX_NSFW_LIPSYNC, {}, '对口型')).toEqual({
      ok: false,
      error: '请先上传参考图',
    });
    expect(logic.buildEngineSubmit(LTX_NSFW_LIPSYNC, { images: REF_A }, '对口型')).toEqual({
      ok: false,
      error: '请先上传驱动音频',
    });
    expect(logic.buildEngineSubmit(LTX_NSFW_I2V, {}, '一只猫')).toEqual({
      ok: false,
      error: '请先上传参考图',
    });
    expect(logic.buildEngineSubmit(H3_NSFW_I2V, {}, '一只猫')).toEqual({
      ok: false,
      error: '请先上传参考图',
    });
  });

  it('engineNeedsAudio：params 含 audio 型（lipsync）为 true，其余为 false', () => {
    expect(logic.engineNeedsAudio(LTX_NSFW_LIPSYNC)).toBe(true);
    expect(logic.engineNeedsAudio(LTX_NSFW_T2V)).toBe(false);
    expect(logic.engineNeedsAudio(WAN_ANIMATE)).toBe(false);
  });

  it('syncAudioWithRefImage：参考图换 worker/移除后清空钉在旧 worker 的驱动音频（对齐 syncVideo 语义）', () => {
    const values = { images: REF_A, audio: AUDIO_REF };
    // 参考图换成另一台 worker 的图 → 音频清空
    const moved = { ...REF_A, filename: 'c.png', worker: 'http://w2' };
    expect(
      logic.syncAudioWithRefImage(LTX_NSFW_LIPSYNC, { images: moved, audio: AUDIO_REF }, 'images'),
    ).toEqual({ images: moved, audio: null });
    // 同 worker 换图 → 音频保留
    expect(logic.syncAudioWithRefImage(LTX_NSFW_LIPSYNC, values, 'images')).toEqual(values);
    // 改其他键 → 原样
    expect(
      logic.syncAudioWithRefImage(LTX_NSFW_LIPSYNC, { ...values, negative: 'x' }, 'negative'),
    ).toEqual({ ...values, negative: 'x' });
    // 移除参考图（null）→ 音频也清空（无钉点可依附）
    expect(
      logic.syncAudioWithRefImage(LTX_NSFW_LIPSYNC, { images: null, audio: AUDIO_REF }, 'images'),
    ).toEqual({ images: null, audio: null });
    // 无 audio 参数引擎 → 原样
    expect(logic.syncAudioWithRefImage(LTX_NSFW_I2V, { images: REF_A }, 'images')).toEqual({
      images: REF_A,
    });
  });
});

// ── M14：LongCat-Avatar 数字人请求构建（纯逻辑，契约对齐 routes/avatar_studio.py AvatarTalkRequest）──

describe('GenerateScreen avatar-talk 数字人请求构建（M14 纯逻辑）', () => {
  it('normalizeEngineSchema：仅把 avatar-talk 的 text 型 audio 归一为 audio 型（default null），其余引擎原样', () => {
    const normalized = logic.normalizeEngineSchema(AVATAR_TALK);
    expect(normalized).not.toBe(AVATAR_TALK);
    const audio = normalized.params.find((p) => p.key === 'audio');
    expect(audio).toMatchObject({ type: 'audio', default: null });
    // 其余参数原样保留（引用相等，未复制）
    expect(normalized.params.find((p) => p.key === 'images')).toBe(
      AVATAR_TALK.params.find((p) => p.key === 'images'),
    );
    // 非 avatar-talk 引擎原样返回（同一引用）
    expect(logic.normalizeEngineSchema(LTX25_T2V)).toBe(LTX25_T2V);
    // 前向兼容：注册表若已改 audio 型则该参数不动（引用保持）
    const already = logic.normalizeEngineSchema(AVATAR_TALK_NORMALIZED);
    expect(already.params.find((p) => p.key === 'audio')).toBe(
      AVATAR_TALK_NORMALIZED.params.find((p) => p.key === 'audio'),
    );
    // 归一化后 engineNeedsAudio 不依赖特判也成立
    expect(logic.engineNeedsAudio(normalized)).toBe(true);
  });

  it('buildAvatarTalkRequest：缺人像首帧或缺驱动音频返回 null', () => {
    expect(logic.buildAvatarTalkRequest(AVATAR_TALK_NORMALIZED, {}, '开口说话')).toBeNull();
    expect(
      logic.buildAvatarTalkRequest(AVATAR_TALK_NORMALIZED, { images: REF_A }, '开口说话'),
    ).toBeNull();
    expect(
      logic.buildAvatarTalkRequest(AVATAR_TALK_NORMALIZED, { audio: AUDIO_REF }, '开口说话'),
    ).toBeNull();
  });

  it('buildAvatarTalkRequest：互钉句柄 + schema 默认值全量进请求体，空 negative/seed 省略', () => {
    expect(
      logic.buildAvatarTalkRequest(
        AVATAR_TALK_NORMALIZED,
        { images: REF_A, audio: AUDIO_REF },
        '开口介绍产品',
      ),
    ).toEqual({
      positive: '开口介绍产品',
      image: 'a.png',
      audio: 'voice.wav',
      worker: 'http://w1',
      width: 480,
      height: 832,
      duration_sec: 3.7,
      fps: 25,
      steps: 12,
    });
  });

  it('buildAvatarTalkRequest：自定义数值 + negative + seed 精确序列化；宽高非 16 对齐向下取整（对齐后端 _snap16）', () => {
    const req = logic.buildAvatarTalkRequest(
      AVATAR_TALK_NORMALIZED,
      {
        images: REF_A,
        audio: AUDIO_REF,
        width: 500,
        height: 845,
        duration: 7.4,
        fps: 30,
        steps: 8,
        negative: ' 低画质 ',
        seed: '42',
      },
      '一只猫',
    );
    expect(req).toEqual({
      positive: '一只猫',
      image: 'a.png',
      audio: 'voice.wav',
      worker: 'http://w1',
      negative: '低画质',
      width: 496,
      height: 832,
      duration_sec: 7.4,
      fps: 30,
      steps: 8,
      seed: 42,
    });
  });

  it('buildAvatarTalkRequest：编辑中 "" 回落 default 并 clamp 到 schema 边界', () => {
    const req = logic.buildAvatarTalkRequest(
      AVATAR_TALK_NORMALIZED,
      { images: REF_A, audio: AUDIO_REF, width: '', duration: 99999, fps: 1 },
      '一只猫',
    );
    expect(req).toMatchObject({ width: 480, duration_sec: 100, fps: 8 });
  });

  it('buildEngineSubmit 校验：avatar-talk 先人像首帧后驱动音频（文案对齐 lipsync 语义）', () => {
    expect(logic.buildEngineSubmit(AVATAR_TALK_NORMALIZED, {}, '开口说话')).toEqual({
      ok: false,
      error: '请先上传人像首帧',
    });
    expect(logic.buildEngineSubmit(AVATAR_TALK_NORMALIZED, { images: REF_A }, '开口说话')).toEqual({
      ok: false,
      error: '请先上传驱动音频',
    });
    expect(
      logic.buildEngineSubmit(AVATAR_TALK_NORMALIZED, { images: REF_A, audio: AUDIO_REF }, '开口说话'),
    ).toMatchObject({ ok: true, payload: { type: 'avatar-talk' } });
  });

  it('engineNeedsAudio：avatar-talk 注册表 text 型 audio 特判为 true', () => {
    expect(logic.engineNeedsAudio(AVATAR_TALK)).toBe(true);
    expect(logic.engineNeedsAudio(AVATAR_TALK_NORMALIZED)).toBe(true);
  });
});

// ── M11.2/M11.3：R18 提交链路 + 驱动音频字段 + R18 徽标 UI ──

const mockSubmitLtxNsfwT2V = submitLtxNsfwT2V as jest.MockedFunction<typeof submitLtxNsfwT2V>;
const mockSubmitLtxNsfwI2V = submitLtxNsfwI2V as jest.MockedFunction<typeof submitLtxNsfwI2V>;
const mockSubmitLtxNsfwLipsync = submitLtxNsfwLipsync as jest.MockedFunction<
  typeof submitLtxNsfwLipsync
>;
const mockUploadAudio = uploadAudio as jest.MockedFunction<typeof uploadAudio>;
const mockGetDocument = DocumentPicker.getDocumentAsync as jest.MockedFunction<
  typeof DocumentPicker.getDocumentAsync
>;

/** 构造音频 asset（expo-document-picker v57 DocumentPickerAsset 字段子集） */
function audioAsset(name: string) {
  return {
    uri: `file:///tmp/${name}`,
    name,
    mimeType: 'audio/wav',
    size: 1024,
    lastModified: 1720000000000,
  };
}

const M11_ENGINES = [
  TXT2IMG,
  LTX_NSFW_T2V,
  LTX_NSFW_I2V,
  LTX_NSFW_LIPSYNC,
  H3_NSFW_T2V,
  H3_NSFW_I2V,
  AVATAR_TALK,
];

describe('GenerateScreen R18 引擎提交链路（M11 UI）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue(M11_ENGINES);
  });

  it('5 个 R18 引擎芯片可选并渲染 R18 徽标；SFW 引擎（含 M14 avatar-talk）可选且无徽标', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx-nsfw-t2v')).toBeTruthy());
    for (const id of [
      'ltx-nsfw-t2v',
      'ltx-nsfw-i2v',
      'ltx-nsfw-lipsync',
      'h3-nsfw-t2v',
      'h3-nsfw-i2v',
    ]) {
      expect(screen.getByTestId(`engine-chip-${id}`).props.accessibilityState.disabled).toBe(false);
      // nsfw=true → R18 徽标（对齐 Web GenerateView Badge tone=warn）
      expect(screen.getByTestId(`engine-chip-${id}-r18`)).toBeTruthy();
    }
    expect(screen.queryByTestId('engine-chip-txt2img-r18')).toBeNull();
    // M14 接入：avatar-talk 可选；nsfw=false 不渲染 R18 徽标
    expect(screen.getByTestId('engine-chip-avatar-talk').props.accessibilityState.disabled).toBe(false);
    expect(screen.queryByTestId('engine-chip-avatar-talk-r18')).toBeNull();
  });

  it('选中 ltx-nsfw-t2v 提交：路由 submitLtxNsfwT2V 携预设换算（1280×720 / 6s 直传 / 双 switch false）', async () => {
    mockSubmitLtxNsfwT2V.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx-nsfw-t2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ltx-nsfw-t2v'));
    await submitPrompt('夜色下的城市');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitLtxNsfwT2V).toHaveBeenCalledWith({
      positive: '夜色下的城市',
      width: 1280,
      height: 720,
      duration_sec: 6,
      use_upscale: false,
      use_rife: false,
      fps: 16,
      steps: 20,
      cfg: 1,
    });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('ltx-nsfw-i2v 未上传参考图提交报「请先上传参考图」，不调提交 API', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx-nsfw-i2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ltx-nsfw-i2v'));
    await submitPrompt('一只猫');
    expect(screen.getByText('请先上传参考图')).toBeTruthy();
    expect(mockSubmitLtxNsfwI2V).not.toHaveBeenCalled();
  });

  it('ltx-nsfw-lipsync 有参考图无驱动音频提交报「请先上传驱动音频」（上传走 ltx_lipsync kind）', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('a.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx-nsfw-lipsync')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ltx-nsfw-lipsync'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));

    // 抽屉渲染驱动音频字段（audio 型第 7 类动态字段）
    expect(screen.getByTestId('param-sheet-field-audio-pick')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());
    expect(mockUploadImage).toHaveBeenCalledWith(
      { uri: 'file:///tmp/a.png', fileName: 'a.png', mimeType: 'image/png' },
      'ltx_lipsync',
    );
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('对口型');
    expect(screen.getByText('请先上传驱动音频')).toBeTruthy();
    expect(mockSubmitLtxNsfwLipsync).not.toHaveBeenCalled();
  });

  it('ltx-nsfw-lipsync 驱动音频上传钉参考图落点 worker，选音频用 audio/* 文档类型', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('a.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx-nsfw-lipsync')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ltx-nsfw-lipsync'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());

    mockGetDocument.mockResolvedValueOnce({ canceled: false, assets: [audioAsset('voice.wav')] } as never);
    mockUploadAudio.mockResolvedValueOnce({ filename: 'voice.wav', worker: 'http://w1' });
    await fireEvent.press(screen.getByTestId('param-sheet-field-audio-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-audio-preview')).toBeTruthy());

    // 文档选择器音频类型 + 上传钉参考图 worker（对齐 Web RefAudioUpload pinWorker）
    expect(mockGetDocument).toHaveBeenCalledWith({ type: 'audio/*' });
    expect(mockUploadAudio).toHaveBeenCalledWith(
      { uri: 'file:///tmp/voice.wav', fileName: 'voice.wav', mimeType: 'audio/wav' },
      'ltx_lipsync',
      'http://w1',
    );
  });

  it('ltx-nsfw-lipsync 完整链路：参考图 + 驱动音频 → submitLtxNsfwLipsync 携互钉句柄', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('a.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' });
    mockSubmitLtxNsfwLipsync.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx-nsfw-lipsync')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ltx-nsfw-lipsync'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());

    mockGetDocument.mockResolvedValueOnce({ canceled: false, assets: [audioAsset('voice.wav')] } as never);
    mockUploadAudio.mockResolvedValueOnce({ filename: 'voice.wav', worker: 'http://w1' });
    await fireEvent.press(screen.getByTestId('param-sheet-field-audio-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-audio-preview')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('对口型');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitLtxNsfwLipsync).toHaveBeenCalledWith({
      positive: '对口型',
      image: 'a.png',
      audio: 'voice.wav',
      worker: 'http://w1',
      width: 1280,
      height: 720,
      duration_sec: 6,
      use_upscale: false,
      use_rife: false,
      fps: 16,
      steps: 20,
      cfg: 1,
      id_lora_strength: 0.8,
    });
  });

  it('选中 h3-nsfw-t2v 提交：复用 submitH3T2V 链路携预设换算（1280×736 / 6s 直传 / loras 空数组）', async () => {
    mockSubmitH3T2V.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-h3-nsfw-t2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-h3-nsfw-t2v'));
    await submitPrompt('海浪');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitH3T2V).toHaveBeenCalledWith({
      positive: '海浪',
      width: 1280,
      height: 736,
      duration_sec: 6,
      steps: 20,
      loras: [],
    });
  });

  it('h3-nsfw-i2v 参考图上传走 h3_i2v kind，提交复用 submitH3I2V 携互钉句柄', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('a.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'a.png', worker: 'http://w1' });
    mockSubmitH3I2V.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-h3-nsfw-i2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-h3-nsfw-i2v'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());
    expect(mockUploadImage).toHaveBeenCalledWith(
      { uri: 'file:///tmp/a.png', fileName: 'a.png', mimeType: 'image/png' },
      'h3_i2v',
    );
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('一只猫');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitH3I2V).toHaveBeenCalledWith({
      positive: '一只猫',
      image: 'a.png',
      worker: 'http://w1',
      width: 1280,
      height: 736,
      duration_sec: 6,
      steps: 20,
      loras: [],
    });
  });
});

// ── M14：LongCat-Avatar 数字人提交链路 UI ──

const mockSubmitAvatarTalk = submitAvatarTalk as jest.MockedFunction<typeof submitAvatarTalk>;

const M14_ENGINES = [TXT2IMG, AVATAR_TALK];

describe('GenerateScreen avatar-talk 数字人提交链路（M14 UI）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue(M14_ENGINES);
  });

  it('选中 avatar-talk：抽屉渲染人像首帧与驱动音频字段（注册表 text 型 audio 归一化为 RefAudioField）', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-avatar-talk')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-avatar-talk'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    // normalizeEngineSchema 生效证明：注册表 audio 为 text 型，UI 渲染为音频上传字段而非文本输入
    expect(screen.getByTestId('param-sheet-field-audio-pick')).toBeTruthy();
    expect(screen.getByTestId('param-sheet-field-images-pick')).toBeTruthy();
  });

  it('avatar-talk 无人像首帧提交报「请先上传人像首帧」，不调提交 API', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-avatar-talk')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-avatar-talk'));
    await submitPrompt('开口说话');
    expect(screen.getByText('请先上传人像首帧')).toBeTruthy();
    expect(mockSubmitAvatarTalk).not.toHaveBeenCalled();
  });

  it('avatar-talk 有人像首帧无驱动音频提交报「请先上传驱动音频」（人像上传走 avatar kind）', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('face.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'face.png', worker: 'http://w1' });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-avatar-talk')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-avatar-talk'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());
    expect(mockUploadImage).toHaveBeenCalledWith(
      { uri: 'file:///tmp/face.png', fileName: 'face.png', mimeType: 'image/png' },
      'avatar',
    );
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('开口说话');
    expect(screen.getByText('请先上传驱动音频')).toBeTruthy();
    expect(mockSubmitAvatarTalk).not.toHaveBeenCalled();
  });

  it('avatar-talk 驱动音频上传钉人像落点 worker（kind=avatar），选音频用 audio/* 文档类型', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('face.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'face.png', worker: 'http://w1' });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-avatar-talk')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-avatar-talk'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());

    mockGetDocument.mockResolvedValueOnce({ canceled: false, assets: [audioAsset('voice.wav')] } as never);
    mockUploadAudio.mockResolvedValueOnce({ filename: 'voice.wav', worker: 'http://w1' });
    await fireEvent.press(screen.getByTestId('param-sheet-field-audio-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-audio-preview')).toBeTruthy());

    // 文档选择器音频类型 + 上传钉人像落点 worker（同 lipsync 互钉语义，后端同机转运 :8197）
    expect(mockGetDocument).toHaveBeenCalledWith({ type: 'audio/*' });
    expect(mockUploadAudio).toHaveBeenCalledWith(
      { uri: 'file:///tmp/voice.wav', fileName: 'voice.wav', mimeType: 'audio/wav' },
      'avatar',
      'http://w1',
    );
  });

  it('avatar-talk 完整链路：人像首帧 + 驱动音频 → submitAvatarTalk 携互钉句柄与 schema 默认值', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: false, assets: [imageAsset('face.png')] } as never);
    mockUploadImage.mockResolvedValueOnce({ filename: 'face.png', worker: 'http://w1' });
    mockSubmitAvatarTalk.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-avatar-talk')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-avatar-talk'));
    await fireEvent.press(screen.getByTestId('prompt-bar-params'));
    await fireEvent.press(screen.getByTestId('param-sheet-field-images-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-images-preview')).toBeTruthy());

    mockGetDocument.mockResolvedValueOnce({ canceled: false, assets: [audioAsset('voice.wav')] } as never);
    mockUploadAudio.mockResolvedValueOnce({ filename: 'voice.wav', worker: 'http://w1' });
    await fireEvent.press(screen.getByTestId('param-sheet-field-audio-pick'));
    await waitFor(() => expect(screen.getByTestId('param-sheet-field-audio-preview')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('param-sheet-done'));

    await submitPrompt('开口介绍产品');
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmitAvatarTalk).toHaveBeenCalledWith({
      positive: '开口介绍产品',
      image: 'face.png',
      audio: 'voice.wav',
      worker: 'http://w1',
      width: 480,
      height: 832,
      duration_sec: 3.7,
      fps: 25,
      steps: 12,
    });
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

// ── M17：反推提示词（选图/视频 → /api/reverse → 回填，契约已读 reverse.py）──

/** 构造反推用 asset（带 expo v57 asset.type 字段，组件据此区分图片/视频上限） */
function reverseAsset(name: string, type: 'image' | 'video', fileSize = 1024) {
  return {
    uri: `file:///tmp/${name}`,
    fileName: name,
    mimeType: type === 'video' ? 'video/mp4' : 'image/png',
    type,
    fileSize,
    width: 512,
    height: 512,
  };
}

describe('GenerateScreen 反推提示词（M17）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue([TXT2IMG, IMG2IMG, VIDEO]);
  });

  it('反推按钮在 PromptBar 渲染；选图用 images+videos 媒体类型，成功后回填 prompt 且 negative 写入表单', async () => {
    mockLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [reverseAsset('rev.png', 'image')],
    } as never);
    mockReverse.mockResolvedValueOnce({
      kind: 'image',
      prompt: 'a cat sitting on a sofa',
      negative: 'blurry, watermark',
    });
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('prompt-bar-reverse'));
    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ['images', 'videos'] }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('prompt-bar-input')).toHaveProp(
        'value',
        'a cat sitting on a sofa',
      ),
    );
    expect(mockReverse).toHaveBeenCalledWith({
      uri: 'file:///tmp/rev.png',
      fileName: 'rev.png',
      mimeType: 'image/png',
    });

    // 提交时 negative 随表单进请求体（回填语义对齐 Web GenerateView）
    await fireEvent.press(screen.getByTestId('prompt-bar-send'));
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        positive: 'a cat sitting on a sofa',
        negative: 'blurry, watermark',
      }),
    );
  });

  it('视频反推无 negative：只回填 prompt，提交请求体不带 negative', async () => {
    mockLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [reverseAsset('clip.mp4', 'video')],
    } as never);
    mockReverse.mockResolvedValueOnce({ kind: 'video', prompt: 'camera push in', negative: null });
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('prompt-bar-reverse'));
    await waitFor(() =>
      expect(screen.getByTestId('prompt-bar-input')).toHaveProp('value', 'camera push in'),
    );
    expect(mockReverse).toHaveBeenCalledWith({
      uri: 'file:///tmp/clip.mp4',
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
    });

    await fireEvent.press(screen.getByTestId('prompt-bar-send'));
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({ negative: expect.anything() }),
    );
  });

  it('反推失败展示人话错误横幅，prompt 不被覆盖', async () => {
    mockLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [reverseAsset('x.png', 'image')],
    } as never);
    mockReverse.mockRejectedValueOnce(new Error('服务暂时不可用，请稍后重试'));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('prompt-bar-input'), '原有提示词');

    await fireEvent.press(screen.getByTestId('prompt-bar-reverse'));
    await waitFor(() => expect(screen.getByTestId('submit-error-banner')).toBeTruthy());
    expect(screen.getByText('服务暂时不可用，请稍后重试')).toBeTruthy();
    expect(screen.getByTestId('prompt-bar-input')).toHaveProp('value', '原有提示词');
  });

  it('取消选图不调反推 API', async () => {
    mockLaunch.mockResolvedValueOnce({ canceled: true, assets: null } as never);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('prompt-bar-reverse'));
    await waitFor(() =>
      expect(mockLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ mediaTypes: ['images', 'videos'] }),
      ),
    );
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('图片超 20MB 本地拦截：不进网络，显示上限文案', async () => {
    mockLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [reverseAsset('big.png', 'image', 21 * 1024 * 1024)],
    } as never);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('prompt-bar-reverse'));
    await waitFor(() => expect(screen.getByText('图片超过 20MB 上限')).toBeTruthy());
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it('视频超 50MB 本地拦截：不进网络，显示上限文案', async () => {
    mockLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [reverseAsset('big.mp4', 'video', 51 * 1024 * 1024)],
    } as never);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('prompt-bar-reverse'));
    await waitFor(() => expect(screen.getByText('视频超过 50MB 上限')).toBeTruthy());
    expect(mockReverse).not.toHaveBeenCalled();
  });
});

// ── M18：优化提示词（口语输入 → /api/optimize → 扩写回填，契约已读 optimize.py）──

describe('GenerateScreen 优化提示词（M18）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGenerationDraft.setState({ draft: null });
    mockFetchEngines.mockResolvedValue([TXT2IMG, IMG2IMG, LTX25_T2V, VIDEO]);
  });

  it('优化按钮在 PromptBar 渲染；成功后覆盖 prompt 且 negative 写入表单（随提交进请求体）', async () => {
    mockOptimize.mockResolvedValueOnce({
      optimized: 'masterpiece, best quality, a cat sitting on a sofa, soft light',
      negative: 'blurry, watermark, bad anatomy',
    });
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('prompt-bar-input'), '一只猫坐在沙发上');

    await fireEvent.press(screen.getByTestId('prompt-bar-optimize'));
    await waitFor(() =>
      expect(screen.getByTestId('prompt-bar-input')).toHaveProp(
        'value',
        'masterpiece, best quality, a cat sitting on a sofa, soft light',
      ),
    );
    expect(mockOptimize).toHaveBeenCalledWith({ prompt: '一只猫坐在沙发上', kind: 'image' });

    // 提交时 negative 随表单进请求体（回填语义对齐 Web GenerateView）
    await fireEvent.press(screen.getByTestId('prompt-bar-send'));
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        positive: 'masterpiece, best quality, a cat sitting on a sofa, soft light',
        negative: 'blurry, watermark, bad anatomy',
      }),
    );
  });

  it('kind 跟随当前选中引擎：视频引擎传 video', async () => {
    mockOptimize.mockResolvedValueOnce({
      optimized: 'a cat walking, slow pan, cinematic lighting',
      negative: 'blurry, flickering, morphing',
    });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-ltx25-t2v')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('engine-chip-ltx25-t2v'));
    await fireEvent.changeText(screen.getByTestId('prompt-bar-input'), '猫走路');

    await fireEvent.press(screen.getByTestId('prompt-bar-optimize'));
    await waitFor(() =>
      expect(screen.getByTestId('prompt-bar-input')).toHaveProp(
        'value',
        'a cat walking, slow pan, cinematic lighting',
      ),
    );
    expect(mockOptimize).toHaveBeenCalledWith({ prompt: '猫走路', kind: 'video' });
  });

  it('negative 为 null：只覆盖 prompt，表单 negative 不被写入', async () => {
    mockOptimize.mockResolvedValueOnce({ optimized: 'polished prompt', negative: null });
    mockSubmit.mockResolvedValueOnce({ prompt_id: 'p1', client_id: 'c1', worker: 'w1', seed: 7 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('prompt-bar-input'), '随便画画');

    await fireEvent.press(screen.getByTestId('prompt-bar-optimize'));
    await waitFor(() =>
      expect(screen.getByTestId('prompt-bar-input')).toHaveProp('value', 'polished prompt'),
    );

    await fireEvent.press(screen.getByTestId('prompt-bar-send'));
    await waitFor(() => expect(screen.getByTestId('submit-success-banner')).toBeTruthy());
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.not.objectContaining({ negative: expect.anything() }),
    );
  });

  it('优化失败展示人话错误横幅，prompt 不被覆盖', async () => {
    mockOptimize.mockRejectedValueOnce(new Error('服务暂时不可用，请稍后重试'));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('prompt-bar-input'), '原有提示词');

    await fireEvent.press(screen.getByTestId('prompt-bar-optimize'));
    await waitFor(() => expect(screen.getByTestId('submit-error-banner')).toBeTruthy());
    expect(screen.getByText('服务暂时不可用，请稍后重试')).toBeTruthy();
    expect(screen.getByTestId('prompt-bar-input')).toHaveProp('value', '原有提示词');
  });

  it('空 prompt 按钮禁用：不调优化 API', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('engine-chip-txt2img')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('prompt-bar-optimize'));
    expect(mockOptimize).not.toHaveBeenCalled();
  });
});
