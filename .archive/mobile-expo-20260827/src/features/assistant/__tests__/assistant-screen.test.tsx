import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';

import { AssistantScreen } from '../assistant-screen';
import {
  agentChatStream,
  ApiError,
  deleteAgentSession,
  deleteDoc,
  forkAgentSession,
  getAgentSession,
  listAgentSessions,
  listDocs,
  uploadDoc,
  uploadImage,
} from '@/lib/api';
import { loadAttachment } from '../attachment-utils';
import { loadDraft, saveDraft } from '../draft-utils';
import { downloadAndSaveToLibrary } from '@/lib/media';
import { storage } from '@/lib/mmkv';
import type { AgentEvent, AgentSessionMessage, AgentSessionSummary, DocItem } from '@/types/api';

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
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

// expo-image 原生组件在 jest 不可断言 props，替身透传
jest.mock('expo-image', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Image: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

// expo-document-picker 原生选择器替身（M20 文档上传：控制选中/取消/坏文件分支）
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

// expo-image-picker 原生选择器替身（M30 附图：控制选中/取消/坏文件分支）
const mockLaunchImageLibrary = jest.fn();
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibrary(...args),
}));

// expo-video 原生组件在 jest 需替身（v57：useVideoPlayer + VideoView，与产物详情套件同式）
jest.mock('expo-video', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    useVideoPlayer: jest.fn((source: unknown) => ({ loop: false, source })),
    VideoView: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

// 相册落盘原生通道替身（M24 预览保存：断言 URL 透传即可）
jest.mock('@/lib/media', () => ({
  downloadAndSaveToLibrary: jest.fn(),
}));

// expo-router 真身依赖原生导航栈，替身隔离跳转断言
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack }),
}));

jest.mock('@/lib/api', () => ({
  agentChatStream: jest.fn(),
  getAgentSession: jest.fn(),
  listAgentSessions: jest.fn(),
  deleteAgentSession: jest.fn(),
  forkAgentSession: jest.fn(),
  listDocs: jest.fn(),
  uploadDoc: jest.fn(),
  deleteDoc: jest.fn(),
  uploadImage: jest.fn(),
  mediaUrl: (p: string) => `https://api.test${p}?token=t`,
  // 替身保持真身形状（status + message），断言 toBeInstanceOf/人话透传用
  ApiError: class MockApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

const mockChat = agentChatStream as jest.MockedFunction<typeof agentChatStream>;
const mockGetSession = getAgentSession as jest.MockedFunction<typeof getAgentSession>;
const mockListSessions = listAgentSessions as jest.MockedFunction<typeof listAgentSessions>;
const mockDeleteSession = deleteAgentSession as jest.MockedFunction<typeof deleteAgentSession>;
const mockForkSession = forkAgentSession as jest.MockedFunction<typeof forkAgentSession>;
const mockListDocs = listDocs as jest.MockedFunction<typeof listDocs>;
const mockUploadDoc = uploadDoc as jest.MockedFunction<typeof uploadDoc>;
const mockDeleteDoc = deleteDoc as jest.MockedFunction<typeof deleteDoc>;
const mockUploadImage = uploadImage as jest.MockedFunction<typeof uploadImage>;
const mockDownload = downloadAndSaveToLibrary as jest.MockedFunction<
  typeof downloadAndSaveToLibrary
>;
const mockGetDocument = DocumentPicker.getDocumentAsync as jest.Mock;

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
        <AssistantScreen />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return render(tree as ReactElement);
}

/** 同步回放一组事件后正常完结的 agentChatStream 替身 */
function chatEmitting(events: AgentEvent[], sessionId = 'sess-1') {
  mockChat.mockImplementationOnce(async (_params, onEvent) => {
    for (const ev of events) onEvent(ev);
    return { sessionId };
  });
}

describe('AssistantScreen（M19.3 对话助手屏）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListSessions.mockResolvedValue([]);
  });

  it('渲染头部（返回/标题/新会话/历史）+ 空态引导；返回回退', async () => {
    await renderScreen();
    expect(screen.getByText('对话助手')).toBeTruthy();
    expect(screen.getByTestId('empty-assistant')).toBeTruthy();
    expect(screen.getByText('和 ToIV 聊聊')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('assistant-back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('空输入发送键禁用，不发起请求', async () => {
    await renderScreen();
    const send = screen.getByTestId('assistant-send');
    expect(send.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(send);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('发送：user/assistant 双气泡入列，text 事件累积，done 后 sessionId 供续聊', async () => {
    chatEmitting([
      { type: 'text', content: '好的，' },
      { type: 'text', content: '为你生成了一张猫图' },
    ]);
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '画一只猫');
    await fireEvent.press(screen.getByTestId('assistant-send'));

    await waitFor(() => expect(screen.getByText('画一只猫')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('好的，\n为你生成了一张猫图')).toBeTruthy());

    // 请求形状：messages 仅本轮 user；新会话不带 sessionId
    expect(mockChat).toHaveBeenCalledTimes(1);
    const [params] = mockChat.mock.calls[0];
    expect(params.messages).toEqual([{ role: 'user', content: '画一只猫' }]);
    expect(params.sessionId).toBeUndefined();

    // 输入已清空（发送即反馈）
    expect(screen.getByTestId('assistant-input').props.value).toBe('');

    // 续聊：第二轮携带首轮 sessionId + 全量历史（正序）
    chatEmitting([{ type: 'text', content: '又一张' }], 'sess-1');
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '再来一张');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));
    const [params2] = mockChat.mock.calls[1];
    expect(params2.sessionId).toBe('sess-1');
    expect(params2.messages).toEqual([
      { role: 'user', content: '画一只猫' },
      { role: 'assistant', content: '好的，\n为你生成了一张猫图' },
      { role: 'user', content: '再来一张' },
    ]);
  });

  it('流式中发送键变停止键，点停止中止本轮（不产生错误气泡）', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockChat.mockImplementationOnce(async (_params, onEvent, signal) => {
      capturedSignal = signal;
      onEvent({ type: 'text', content: '前半段' });
      // 挂起模拟长流，直到被 abort
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { sessionId: 'sess-9' };
    });
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '长任务');
    await fireEvent.press(screen.getByTestId('assistant-send'));

    await waitFor(() => expect(screen.getByLabelText('停止生成')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('assistant-send')); // 停止
    await waitFor(() => expect(capturedSignal?.aborted).toBe(true));
    // 中止后恢复发送态；已有文本保留
    await waitFor(() => expect(screen.getByLabelText('发送')).toBeTruthy());
    expect(screen.getByText('前半段')).toBeTruthy();
  });

  it('tool 事件展示调用过程；image 直显 / video 类型卡', async () => {
    chatEmitting([
      { type: 'tool', name: 'generate_image', args: { prompt: 'cat' } },
      { type: 'image', urls: ['/media/a.png'] },
      { type: 'video', urls: ['/media/b.mp4'] },
      { type: 'text', content: '都做好了' },
    ]);
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '生成猫图和视频');
    await fireEvent.press(screen.getByTestId('assistant-send'));

    await waitFor(() => expect(screen.getByText('都做好了')).toBeTruthy());
    expect(screen.getByText('视频产物 ×1')).toBeTruthy();
  });

  it('error 事件 → 人话标红进气泡', async () => {
    chatEmitting([{ type: 'error', content: 'LLM 层全部不可用' }]);
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'x');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(screen.getByText('LLM 层全部不可用')).toBeTruthy());
  });

  it('请求层 ApiError → 人话进气泡；error 消息不进下轮上下文', async () => {
    mockChat.mockRejectedValueOnce(new ApiError(429, '请求过于频繁，请稍后再试'));
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '第一轮');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(screen.getByText('请求过于频繁，请稍后再试')).toBeTruthy());

    chatEmitting([{ type: 'text', content: 'ok' }]);
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '第二轮');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));
    const [params2] = mockChat.mock.calls[1];
    // error 气泡剔除：上下文只有两条 user
    expect(params2.messages).toEqual([
      { role: 'user', content: '第一轮' },
      { role: 'user', content: '第二轮' },
    ]);
  });

  it('新会话按钮：清空消息与会话上下文', async () => {
    chatEmitting([{ type: 'text', content: '旧会话内容' }]);
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'hi');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(screen.getByText('旧会话内容')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('assistant-new'));
    expect(screen.queryByText('旧会话内容')).toBeNull();
    expect(screen.getByTestId('empty-assistant')).toBeTruthy();

    // 下一轮回到新会话语义（不带 sessionId）
    chatEmitting([{ type: 'text', content: 'new' }], 'sess-new');
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'hello');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));
    expect(mockChat.mock.calls[1][0].sessionId).toBeUndefined();
  });

  it('历史抽屉：打开才拉列表；点会话回放消息（user/assistant/产物）', async () => {
    await renderScreen();
    expect(mockListSessions).not.toHaveBeenCalled();

    mockListSessions.mockResolvedValueOnce([
      {
        id: 's1',
        title: '画猫记录',
        nsfw: false,
        created_at: '2026-08-14T10:00:00',
        updated_at: '2026-08-14T11:00:00',
        message_count: 3,
      },
    ]);
    mockGetSession.mockResolvedValueOnce({
      id: 's1',
      title: '画猫记录',
      nsfw: false,
      created_at: '2026-08-14T10:00:00',
      updated_at: '2026-08-14T11:00:00',
      message_count: 3,
      messages: [
        { id: 1, role: 'user', content: '画一只猫', tool_calls: null, media: [], created_at: '2026-08-14T10:00:00' },
        { id: 2, role: 'assistant', content: '好的', tool_calls: null, media: [], created_at: '2026-08-14T10:01:00' },
        { id: 3, role: 'tool', content: 'raw', tool_calls: null, media: [{ type: 'image', urls: ['/m/c.png'] }], created_at: '2026-08-14T10:02:00' },
      ],
    });

    await fireEvent.press(screen.getByTestId('assistant-history'));
    await waitFor(() => expect(screen.getByText('画猫记录')).toBeTruthy());
    expect(screen.getByText(/3 条消息/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('session-item-s1'));
    await waitFor(() => expect(screen.getByText('画一只猫')).toBeTruthy());
    expect(screen.getByText('好的')).toBeTruthy();
    // 回放后进入续聊语义
    chatEmitting([{ type: 'text', content: '继续' }], 's1');
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '继续聊');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    const [params] = mockChat.mock.calls[0];
    expect(params.sessionId).toBe('s1');
    expect(params.messages[0]).toEqual({ role: 'user', content: '画一只猫' });
  });

  it('删除会话：二次确认后调 API；删当前会话清空主屏', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockDeleteSession.mockResolvedValueOnce(undefined);
    mockListSessions.mockResolvedValue([
      {
        id: 's1',
        title: '待删会话',
        nsfw: false,
        created_at: '2026-08-14T10:00:00',
        updated_at: '2026-08-14T11:00:00',
        message_count: 1,
      },
    ]);
    mockGetSession.mockResolvedValueOnce({
      id: 's1',
      title: '待删会话',
      nsfw: false,
      created_at: '2026-08-14T10:00:00',
      updated_at: '2026-08-14T11:00:00',
      message_count: 1,
      messages: [
        { id: 1, role: 'user', content: '唯一消息', tool_calls: null, media: [], created_at: '2026-08-14T10:00:00' },
      ],
    });

    await renderScreen();
    await fireEvent.press(screen.getByTestId('assistant-history'));
    await waitFor(() => expect(screen.getByText('待删会话')).toBeTruthy());
    // 先载入为当前会话
    await fireEvent.press(screen.getByTestId('session-item-s1'));
    await waitFor(() => expect(screen.getByText('唯一消息')).toBeTruthy());

    // 再开抽屉删除
    await fireEvent.press(screen.getByTestId('assistant-history'));
    await waitFor(() => expect(screen.getByTestId('session-delete-s1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('session-delete-s1'));
    expect(alertSpy).toHaveBeenCalledWith(
      '删除会话',
      expect.stringContaining('待删会话'),
      expect.any(Array),
    );
    // 触发确认按钮回调（useMutation 会以 (id, mutationCtx) 调 mutationFn，取首参断言）
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    const confirm = buttons.find((b) => b.text === '删除');
    confirm?.onPress?.();
    await waitFor(() => expect(mockDeleteSession.mock.calls[0]?.[0]).toBe('s1'));
    // 删除的是当前会话 → 主屏清空回空态
    await waitFor(() => expect(screen.getByTestId('empty-assistant')).toBeTruthy());
    alertSpy.mockRestore();
  });

  it('会话载入失败：留在当前上下文并给人话气泡', async () => {
    mockListSessions.mockResolvedValueOnce([
      {
        id: 'ghost',
        title: '幽灵会话',
        nsfw: false,
        created_at: '2026-08-14T10:00:00',
        updated_at: '2026-08-14T11:00:00',
        message_count: 2,
      },
    ]);
    mockGetSession.mockRejectedValueOnce(new ApiError(404, '资源不存在或已被清理'));
    await renderScreen();
    await fireEvent.press(screen.getByTestId('assistant-history'));
    await waitFor(() => expect(screen.getByText('幽灵会话')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('session-item-ghost'));
    await waitFor(() => expect(screen.getByText('资源不存在或已被清理')).toBeTruthy());
  });
});

describe('AssistantScreen 文档挂载（M20.2/M20.3）', () => {
  const DOC_A: DocItem = {
    id: 'd1',
    filename: '需求文档.pdf',
    kind: 'pdf',
    size: 1024,
    chunk_count: 3,
    status: 'ready',
    created_at: '2026-08-14T10:00:00',
  };
  const DOC_B: DocItem = {
    id: 'd2',
    filename: '随手笔记.md',
    kind: 'md',
    size: 512,
    chunk_count: 1,
    status: 'no_embed',
    created_at: '2026-08-14T09:00:00',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockListSessions.mockResolvedValue([]);
    mockListDocs.mockResolvedValue([]);
  });

  /** 打开文档面板并等查询发出（数据落盘由各用例 waitFor 目标内容保证） */
  async function openDocSheet() {
    await fireEvent.press(screen.getByTestId('assistant-docs'));
    await waitFor(() => expect(mockListDocs).toHaveBeenCalledTimes(1));
  }

  it('文档 ghost 钮渲染；未激活态 selected=false；打开面板才拉列表（空态引导）', async () => {
    await renderScreen();
    const docsBtn = screen.getByTestId('assistant-docs');
    expect(docsBtn.props.accessibilityState?.selected).toBe(false);
    expect(mockListDocs).not.toHaveBeenCalled();

    await openDocSheet();
    await waitFor(() => expect(screen.getByTestId('doc-sheet-empty')).toBeTruthy());
    expect(screen.getByText('还没有文档')).toBeTruthy();
    // 面板开 → 文档钮激活态
    expect(screen.getByTestId('assistant-docs').props.accessibilityState?.selected).toBe(true);

    // 关闭面板
    await fireEvent.press(screen.getByTestId('doc-sheet-close'));
    await waitFor(() => expect(screen.queryByTestId('doc-sheet-empty')).toBeNull());
  });

  it('面板列表：文件名 + formatDocSize + docStatusLabel 状态文案', async () => {
    mockListDocs.mockResolvedValue([DOC_A, DOC_B]);
    await renderScreen();
    await openDocSheet();
    await waitFor(() => expect(screen.getByText('需求文档.pdf')).toBeTruthy());
    expect(screen.getByText('1.0KB · 已索引')).toBeTruthy();
    expect(screen.getByText('随手笔记.md')).toBeTruthy();
    expect(screen.getByText('512B · 未索引(向量服务不可用)')).toBeTruthy();
  });

  it('勾选挂载出 chips（可 X 移除）；有挂载时文档钮保持激活态', async () => {
    mockListDocs.mockResolvedValue([DOC_A]);
    await renderScreen();
    await openDocSheet();
    await waitFor(() => expect(screen.getByTestId('doc-attach-d1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('doc-attach-d1'));
    // 勾选态 + 输入区 chips
    expect(screen.getByTestId('doc-attach-d1-check')).toBeTruthy();
    expect(screen.getByTestId('assistant-doc-chips')).toBeTruthy();
    expect(screen.getByTestId('assistant-doc-chip-d1')).toBeTruthy();

    // 再点一次取消挂载
    await fireEvent.press(screen.getByTestId('doc-attach-d1'));
    expect(screen.queryByTestId('assistant-doc-chips')).toBeNull();
    expect(screen.queryByTestId('doc-attach-d1-check')).toBeNull();

    // 重新挂载后走 chips X 移除路径
    await fireEvent.press(screen.getByTestId('doc-attach-d1'));
    expect(screen.getByTestId('assistant-doc-chip-d1')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('assistant-doc-chip-remove-d1'));
    expect(screen.queryByTestId('assistant-doc-chips')).toBeNull();
  });

  it('发送：document_ids 随轮上行；chips 清空并转移到 user 气泡下方留痕', async () => {
    chatEmitting([{ type: 'text', content: '已读文档，结论是…' }]);
    mockListDocs.mockResolvedValue([DOC_A, DOC_B]);
    await renderScreen();
    await openDocSheet();
    await waitFor(() => expect(screen.getByTestId('doc-attach-d1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('doc-attach-d1'));
    await fireEvent.press(screen.getByTestId('doc-attach-d2'));
    await fireEvent.press(screen.getByTestId('doc-sheet-close'));

    await fireEvent.changeText(screen.getByTestId('assistant-input'), '总结这两份文档');
    await fireEvent.press(screen.getByTestId('assistant-send'));

    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    const [params] = mockChat.mock.calls[0];
    expect(params.documentIds).toEqual(['d1', 'd2']);

    await waitFor(() => expect(screen.getByText('已读文档，结论是…')).toBeTruthy());
    // 输入区 chips 清空；文件名转移到 user 气泡下方留痕（文本仍在屏上）
    expect(screen.queryByTestId('assistant-doc-chips')).toBeNull();
    expect(screen.getByText('需求文档.pdf')).toBeTruthy();
    expect(screen.getByText('随手笔记.md')).toBeTruthy();
    // 文档钮回到未激活态（面板关 + 无挂载）
    expect(screen.getByTestId('assistant-docs').props.accessibilityState?.selected).toBe(false);
  });

  it('无挂载发送：documentIds 为空数组（api 层省略字段语义由 api.test 断言）', async () => {
    chatEmitting([{ type: 'text', content: 'ok' }]);
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '普通消息');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    expect(mockChat.mock.calls[0][0].documentIds).toEqual([]);
  });

  it('上传成功：picker 选中 → uploadDoc 三段式入参 → 列表失效重拉', async () => {
    mockGetDocument.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/新上传.txt',
          name: '新上传.txt',
          size: 2048,
          mimeType: 'text/plain',
        },
      ],
    });
    mockUploadDoc.mockResolvedValueOnce({
      id: 'd3',
      filename: '新上传.txt',
      kind: 'txt',
      size: 2048,
      chunk_count: 2,
      status: 'partial',
      created_at: '2026-08-14T12:00:00',
    });
    await renderScreen();
    await openDocSheet();

    await fireEvent.press(screen.getByTestId('doc-sheet-upload'));
    await waitFor(() =>
      expect(mockUploadDoc).toHaveBeenCalledWith({
        uri: 'file:///tmp/新上传.txt',
        fileName: '新上传.txt',
        mimeType: 'text/plain',
      }),
    );
    // invalidate → 列表重拉
    await waitFor(() => expect(mockListDocs).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('doc-sheet-upload-error')).toBeNull();
  });

  it('上传失败（422 解析失败）→ 面板内人话标红', async () => {
    mockGetDocument.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/e.txt', name: 'e.txt', size: 10, mimeType: 'text/plain' }],
    });
    mockUploadDoc.mockRejectedValueOnce(new ApiError(422, '文档解析失败，请检查文件内容'));
    await renderScreen();
    await openDocSheet();
    await fireEvent.press(screen.getByTestId('doc-sheet-upload'));
    await waitFor(() => expect(screen.getByText('文档解析失败，请检查文件内容')).toBeTruthy());
  });

  it('客户端先验：扩展名不在白名单提前拦截（不发请求）', async () => {
    mockGetDocument.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/x.exe', name: 'x.exe', size: 100, mimeType: 'application/octet-stream' }],
    });
    await renderScreen();
    await openDocSheet();
    await fireEvent.press(screen.getByTestId('doc-sheet-upload'));
    await waitFor(() => expect(screen.getByText('仅支持 pdf / docx / txt / md 文件')).toBeTruthy());
    expect(mockUploadDoc).not.toHaveBeenCalled();
  });

  it('客户端先验：>50MB 提前拦截（不发请求）', async () => {
    mockGetDocument.mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: 'file:///tmp/big.pdf', name: 'big.pdf', size: 51 * 1024 * 1024, mimeType: 'application/pdf' },
      ],
    });
    await renderScreen();
    await openDocSheet();
    await fireEvent.press(screen.getByTestId('doc-sheet-upload'));
    await waitFor(() => expect(screen.getByText('文件超过 50MB 上限')).toBeTruthy());
    expect(mockUploadDoc).not.toHaveBeenCalled();
  });

  it('picker 取消：静默返回（无报错、不发请求）', async () => {
    mockGetDocument.mockResolvedValueOnce({ canceled: true, assets: [] });
    await renderScreen();
    await openDocSheet();
    await fireEvent.press(screen.getByTestId('doc-sheet-upload'));
    await waitFor(() => expect(mockGetDocument).toHaveBeenCalledTimes(1));
    expect(mockUploadDoc).not.toHaveBeenCalled();
    expect(screen.queryByTestId('doc-sheet-upload-error')).toBeNull();
  });

  it('删除：二次确认后调 API；删除挂载中文档同时卸载 chips', async () => {
    mockListDocs.mockResolvedValue([DOC_A]);
    mockDeleteDoc.mockResolvedValueOnce(undefined);
    await renderScreen();
    await openDocSheet();
    await waitFor(() => expect(screen.getByTestId('doc-attach-d1')).toBeTruthy());
    // 先挂载（chips 出现）
    await fireEvent.press(screen.getByTestId('doc-attach-d1'));
    expect(screen.getByTestId('assistant-doc-chip-d1')).toBeTruthy();

    // 点删除 → 二次确认对话框
    await fireEvent.press(screen.getByTestId('doc-delete-d1'));
    expect(screen.getByText('删除文档')).toBeTruthy();
    expect(screen.getByText(/「需求文档\.pdf」删除后不可恢复。/)).toBeTruthy();
    expect(mockDeleteDoc).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('doc-sheet-delete-dialog-confirm'));
    // useMutation 以 (id, mutationCtx) 调 mutationFn，取首参断言
    await waitFor(() => expect(mockDeleteDoc.mock.calls[0]?.[0]).toBe('d1'));
    // 删除成功：chips 卸载 + 列表失效重拉
    await waitFor(() => expect(screen.queryByTestId('assistant-doc-chips')).toBeNull());
    await waitFor(() => expect(mockListDocs).toHaveBeenCalledTimes(2));
  });

  it('删除失败（404）→ 对话框内人话，不卸载', async () => {
    mockListDocs.mockResolvedValue([DOC_A]);
    mockDeleteDoc.mockRejectedValueOnce(new ApiError(404, '资源不存在或已被清理'));
    await renderScreen();
    await openDocSheet();
    await waitFor(() => expect(screen.getByTestId('doc-delete-d1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('doc-delete-d1'));
    await fireEvent.press(screen.getByTestId('doc-sheet-delete-dialog-confirm'));
    await waitFor(() => expect(screen.getByText('资源不存在或已被清理')).toBeTruthy());
    // 列表项仍在（未失效重拉出新状态之外的卸载）
    expect(screen.getByTestId('doc-delete-d1')).toBeTruthy();
  });
});

describe('AssistantScreen M24（分叉 / 媒体预览 / 输入草稿）', () => {
  const summary = (id: string, title: string, messageCount = 2): AgentSessionSummary => ({
    id,
    title,
    nsfw: false,
    created_at: '2026-08-15T10:00:00',
    updated_at: '2026-08-15T11:00:00',
    message_count: messageCount,
  });
  const row = (
    id: number,
    role: AgentSessionMessage['role'],
    content: string,
    media: AgentSessionMessage['media'] = [],
  ): AgentSessionMessage => ({
    id,
    role,
    content,
    tool_calls: null,
    media,
    created_at: '2026-08-15T10:00:00',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockListSessions.mockResolvedValue([]);
    storage.clearAll();
  });

  /** 打开历史抽屉并点选会话（载入回放） */
  async function openSheetAndPick(sessionId: string) {
    await fireEvent.press(screen.getByTestId('assistant-history'));
    await waitFor(() => expect(screen.getByTestId(`session-item-${sessionId}`)).toBeTruthy());
    await fireEvent.press(screen.getByTestId(`session-item-${sessionId}`));
  }

  it('会话列表「分叉副本」：全量 fork（无 at_message_id）→ 列表失效重拉 → 载入新会话回放', async () => {
    mockListSessions.mockResolvedValue([summary('s1', '画猫记录')]);
    mockForkSession.mockResolvedValueOnce(summary('s2', '画猫记录'));
    mockGetSession.mockResolvedValueOnce({
      ...summary('s2', '画猫记录', 1),
      messages: [row(9, 'user', '分叉出来的副本')],
    });
    await renderScreen();
    await fireEvent.press(screen.getByTestId('assistant-history'));
    await waitFor(() => expect(screen.getByTestId('session-fork-s1')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('session-fork-s1'));
    // 全量 fork：不带 at_message_id
    await waitFor(() => expect(mockForkSession).toHaveBeenCalledWith('s1', undefined));
    // 跳新会话：拉 s2 详情回放 + 会话列表失效重拉
    await waitFor(() => expect(screen.getByText('分叉出来的副本')).toBeTruthy());
    expect(mockGetSession).toHaveBeenCalledWith('s2');
    await waitFor(() => expect(mockListSessions.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('回放消息长按「从此分叉」：at_message_id 契约上行，成功载入新会话', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockListSessions.mockResolvedValue([summary('s1', '画猫记录')]);
    mockGetSession.mockResolvedValueOnce({
      ...summary('s1', '画猫记录'),
      messages: [row(1, 'user', '画一只猫'), row(2, 'assistant', '好的，给你')],
    });
    mockForkSession.mockResolvedValueOnce(summary('s3', '画猫记录'));
    mockGetSession.mockResolvedValueOnce({
      ...summary('s3', '画猫记录', 1),
      messages: [row(10, 'user', '截断分叉副本')],
    });
    await renderScreen();
    await openSheetAndPick('s1');
    await waitFor(() => expect(screen.getByText('好的，给你')).toBeTruthy());

    await fireEvent(screen.getByTestId('msg-srv-2'), 'longPress');
    expect(alertSpy).toHaveBeenCalledWith('从此分叉', expect.any(String), expect.any(Array));
    expect(mockForkSession).not.toHaveBeenCalled();
    // 触发菜单「分叉」回调
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === '分叉')?.onPress?.();
    // 截断 fork：at_message_id = 该回放消息的服务端 id
    await waitFor(() => expect(mockForkSession).toHaveBeenCalledWith('s1', 2));
    await waitFor(() => expect(screen.getByText('截断分叉副本')).toBeTruthy());
    alertSpy.mockRestore();
  });

  it('消息级分叉失败（404 消息不存在）→ 人话内联 error 气泡，原会话上下文保留', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockListSessions.mockResolvedValue([summary('s1', '画猫记录')]);
    mockGetSession.mockResolvedValueOnce({
      ...summary('s1', '画猫记录'),
      messages: [row(1, 'user', '画一只猫'), row(2, 'assistant', '好的')],
    });
    mockForkSession.mockRejectedValueOnce(new ApiError(404, '消息不存在'));
    await renderScreen();
    await openSheetAndPick('s1');
    await waitFor(() => expect(screen.getByText('画一只猫')).toBeTruthy());

    await fireEvent(screen.getByTestId('msg-srv-2'), 'longPress');
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === '分叉')?.onPress?.();
    await waitFor(() => expect(screen.getByText('消息不存在')).toBeTruthy());
    // 原上下文保留（未跳走）
    expect(screen.getByText('画一只猫')).toBeTruthy();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    alertSpy.mockRestore();
  });

  it('本轮新消息（无服务端 id）长按不出分叉菜单（本地气泡未注入分叉入口）', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    chatEmitting([{ type: 'text', content: '好的' }]);
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '嗨');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(screen.getByText('好的')).toBeTruthy());

    const bubbles = screen.queryAllByTestId(/^msg-local-/);
    expect(bubbles.length).toBeGreaterThan(0);
    for (const b of bubbles) await fireEvent(b, 'longPress');
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('媒体预览：图片点开全屏（页码定位）→ 保存相册 → 关闭；视频卡点开播放；音频卡无预览形态', async () => {
    mockListSessions.mockResolvedValue([summary('s1', '产物会话', 4)]);
    mockGetSession.mockResolvedValueOnce({
      ...summary('s1', '产物会话', 4),
      messages: [
        row(1, 'user', '产物会话'),
        row(2, 'tool', 'raw', [{ type: 'image', urls: ['/m/a.png', '/m/b.png'] }]),
        row(3, 'tool', 'raw', [{ type: 'video', urls: ['/m/v.mp4'] }]),
        row(4, 'tool', 'raw', [{ type: 'audio', urls: ['/m/a.mp3'] }]),
      ],
    });
    await renderScreen();
    await openSheetAndPick('s1');
    await waitFor(() => expect(screen.getByText('产物会话')).toBeTruthy());

    // 图片组第 2 张点开：全屏 lightbox，页码定位 2/2
    await fireEvent.press(screen.getByTestId('msg-srv-2-media-0-image-1'));
    await waitFor(() => expect(screen.getByText('2 / 2')).toBeTruthy());

    // 保存到相册：当前页 URL 透传下载封装（拼 token 完整 URL）
    mockDownload.mockResolvedValueOnce(undefined);
    await fireEvent.press(screen.getByTestId('media-preview-save'));
    await waitFor(() =>
      expect(mockDownload).toHaveBeenCalledWith('https://api.test/m/b.png?token=t'),
    );
    await waitFor(() => expect(screen.getByText('已保存到相册')).toBeTruthy());

    // 关闭预览
    await fireEvent.press(screen.getByTestId('media-preview-close'));
    await waitFor(() => expect(screen.queryByTestId('media-preview-save')).toBeNull());

    // 视频卡点开：VideoView 页渲染
    await fireEvent.press(screen.getByTestId('msg-srv-3-media-0'));
    await waitFor(() => expect(screen.getByTestId('media-preview-video-0')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('media-preview-close'));
    await waitFor(() => expect(screen.queryByTestId('media-preview-save')).toBeNull());

    // 音频卡保持纯展示卡（无预览入口）
    expect(screen.getByText('音频产物 ×1')).toBeTruthy();
    expect(screen.queryByTestId('media-preview-save')).toBeNull();
  });

  it('输入草稿：重进回填，输入 300ms 防抖落盘', async () => {
    saveDraft(undefined, '上次的草稿');
    await renderScreen();
    expect(screen.getByTestId('assistant-input').props.value).toBe('上次的草稿');

    await fireEvent.changeText(screen.getByTestId('assistant-input'), '新草稿内容');
    // 防抖窗口内未落盘
    expect(loadDraft(undefined)).toBe('上次的草稿');
    await waitFor(() => expect(loadDraft(undefined)).toBe('新草稿内容'));
  });

  it('输入草稿：按 sessionId 隔离；切换会话补写未落盘内容；回切回填', async () => {
    mockListSessions.mockResolvedValue([summary('s1', '画猫记录', 1)]);
    mockGetSession.mockResolvedValueOnce({
      ...summary('s1', '画猫记录', 1),
      messages: [row(1, 'user', '历史消息')],
    });
    await renderScreen();
    // 新会话输入后未等防抖，直接载入历史会话
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'A草稿');
    await openSheetAndPick('s1');
    await waitFor(() => expect(screen.getByText('历史消息')).toBeTruthy());
    // 切换瞬间补写落盘；s1 无草稿回填空串
    expect(loadDraft(undefined)).toBe('A草稿');
    expect(screen.getByTestId('assistant-input').props.value).toBe('');

    // s1 会话内输入只写 s1 键，新会话键不受影响
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'B草稿');
    await waitFor(() => expect(loadDraft('s1')).toBe('B草稿'));
    expect(loadDraft(undefined)).toBe('A草稿');

    // 回新会话：回填 A草稿
    await fireEvent.press(screen.getByTestId('assistant-new'));
    expect(screen.getByTestId('assistant-input').props.value).toBe('A草稿');
  });

  it('输入草稿：发送成功清空草稿键与输入框（新旧会话键均清）', async () => {
    saveDraft(undefined, '待发送草稿');
    chatEmitting([{ type: 'text', content: '收到' }], 'sess-9');
    await renderScreen();
    expect(screen.getByTestId('assistant-input').props.value).toBe('待发送草稿');

    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(screen.getByText('收到')).toBeTruthy());
    expect(loadDraft(undefined)).toBe('');
    expect(loadDraft('sess-9')).toBe('');
    expect(screen.getByTestId('assistant-input').props.value).toBe('');
  });
});

describe('AssistantScreen 附图（M30）', () => {
  const ASSET = {
    uri: 'file:///tmp/cat.png',
    fileName: 'cat.png',
    mimeType: 'image/png',
    fileSize: 1024,
  };
  const HANDLE = { filename: 'up-cat.png', worker: 'http://w1' };
  const summary = (id: string, title: string, messageCount = 1): AgentSessionSummary => ({
    id,
    title,
    nsfw: false,
    created_at: '2026-08-15T10:00:00',
    updated_at: '2026-08-15T11:00:00',
    message_count: messageCount,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // M27 踩坑复防：新 describe 自带相关 mock mockReset（清实现残留）
    mockLaunchImageLibrary.mockReset();
    mockUploadImage.mockReset();
    mockListSessions.mockResolvedValue([]);
    storage.clearAll();
  });

  /** 选图并上传成功（chip 就绪，含移除钮） */
  async function pickAndUpload() {
    mockLaunchImageLibrary.mockResolvedValueOnce({ canceled: false, assets: [ASSET] });
    mockUploadImage.mockResolvedValueOnce(HANDLE);
    await fireEvent.press(screen.getByTestId('assistant-image'));
    await waitFor(() => expect(screen.getByTestId('assistant-image-chip-remove')).toBeTruthy());
  }

  it('图片 ghost 钮渲染；选图即传（uploadImage img2img 三段式入参）→ chip 缩略图+文件名', async () => {
    await renderScreen();
    expect(screen.getByTestId('assistant-image').props.accessibilityState?.disabled).toBe(false);

    await pickAndUpload();
    expect(mockLaunchImageLibrary).toHaveBeenCalledWith({ mediaTypes: ['images'], quality: 1 });
    expect(mockUploadImage).toHaveBeenCalledWith(
      { uri: ASSET.uri, fileName: ASSET.fileName, mimeType: ASSET.mimeType },
      'img2img',
    );
    expect(screen.getByTestId('assistant-image-chip')).toBeTruthy();
    expect(screen.getByTestId('assistant-image-chip-thumb')).toBeTruthy();
    expect(screen.getByText('cat.png')).toBeTruthy();
    // 有附图时图片钮保持激活态
    expect(screen.getByTestId('assistant-image').props.accessibilityState?.selected).toBe(true);
  });

  it('上传中：chip 转 loading 无移除钮；发送键与图片钮禁用；上传完成恢复', async () => {
    let resolveUpload!: (v: { filename: string; worker: string }) => void;
    mockUploadImage.mockImplementationOnce(
      () => new Promise((r) => { resolveUpload = r; }),
    );
    mockLaunchImageLibrary.mockResolvedValueOnce({ canceled: false, assets: [ASSET] });
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '改成夜景');
    await fireEvent.press(screen.getByTestId('assistant-image'));
    await waitFor(() => expect(screen.getByTestId('assistant-image-chip-loading')).toBeTruthy());
    // 上传中 chip 无 X（规避取消竞态）
    expect(screen.queryByTestId('assistant-image-chip-remove')).toBeNull();
    // 有文本但上传中 → 发送禁用且 send() 守卫兜底
    expect(screen.getByTestId('assistant-send').props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('assistant-send'));
    expect(mockChat).not.toHaveBeenCalled();
    // 图片钮自身禁用（防并发选图）
    expect(screen.getByTestId('assistant-image').props.accessibilityState?.disabled).toBe(true);

    await act(async () => resolveUpload(HANDLE));
    await waitFor(() => expect(screen.getByTestId('assistant-image-chip-remove')).toBeTruthy());
    expect(screen.getByTestId('assistant-send').props.accessibilityState?.disabled).toBe(false);
  });

  it('发送：image 随轮上行（可与 document_ids 同发）；chip 清空并转移到 user 气泡本地展示', async () => {
    chatEmitting([{ type: 'text', content: '收到附图' }]);
    mockListDocs.mockResolvedValue([
      {
        id: 'd1',
        filename: '需求文档.pdf',
        kind: 'pdf',
        size: 1024,
        chunk_count: 3,
        status: 'ready',
        created_at: '2026-08-14T10:00:00',
      },
    ]);
    await renderScreen();
    await pickAndUpload();
    // 挂载一份文档（与附图同发）
    await fireEvent.press(screen.getByTestId('assistant-docs'));
    await waitFor(() => expect(screen.getByTestId('doc-attach-d1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('doc-attach-d1'));
    await fireEvent.press(screen.getByTestId('doc-sheet-close'));

    await fireEvent.changeText(screen.getByTestId('assistant-input'), '把这张图改成夜景');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    const [params] = mockChat.mock.calls[0];
    expect(params.image).toEqual(HANDLE);
    expect(params.documentIds).toEqual(['d1']);

    // chip 清空 + 附图草稿键即时清除
    expect(screen.queryByTestId('assistant-image-chip')).toBeNull();
    expect(loadAttachment(undefined)).toBeNull();
    // 本会话内该 user 气泡显示该图（本地 uri 缩略图）
    await waitFor(() => expect(screen.getByText('把这张图改成夜景')).toBeTruthy());
    expect(screen.queryAllByTestId(/^msg-local-.*-attachment$/).length).toBe(1);
    await waitFor(() => expect(screen.getByText('收到附图')).toBeTruthy());
  });

  it('无附图发送：image 字段为 undefined', async () => {
    chatEmitting([{ type: 'text', content: 'ok' }]);
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '纯文本');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    expect(mockChat.mock.calls[0][0].image).toBeUndefined();
  });

  it('移除 chip：X 后 chip 消失、草稿键清除，发送体不带 image', async () => {
    chatEmitting([{ type: 'text', content: 'ok' }]);
    await renderScreen();
    await pickAndUpload();
    await fireEvent.press(screen.getByTestId('assistant-image-chip-remove'));
    expect(screen.queryByTestId('assistant-image-chip')).toBeNull();
    expect(loadAttachment(undefined)).toBeNull();

    await fireEvent.changeText(screen.getByTestId('assistant-input'), '不带图了');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    expect(mockChat.mock.calls[0][0].image).toBeUndefined();
  });

  it('替换：已有 chip 再选 = 替换（重新上传，发送用新句柄）', async () => {
    chatEmitting([{ type: 'text', content: 'ok' }]);
    await renderScreen();
    await pickAndUpload();
    mockLaunchImageLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/dog.jpg', fileName: 'dog.jpg', mimeType: 'image/jpeg' }],
    });
    mockUploadImage.mockResolvedValueOnce({ filename: 'up-dog.jpg', worker: 'http://w2' });
    await fireEvent.press(screen.getByTestId('assistant-image'));
    await waitFor(() => expect(screen.getByText('dog.jpg')).toBeTruthy());
    expect(mockUploadImage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('cat.png')).toBeNull();

    await fireEvent.changeText(screen.getByTestId('assistant-input'), '换这张');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));
    expect(mockChat.mock.calls[0][0].image).toEqual({ filename: 'up-dog.jpg', worker: 'http://w2' });
  });

  it('上传失败：chip 移除 + 内联人话标红（最小实现，非错误态重试）', async () => {
    mockLaunchImageLibrary.mockResolvedValueOnce({ canceled: false, assets: [ASSET] });
    mockUploadImage.mockRejectedValueOnce(new ApiError(415, '文件内容与扩展名不符'));
    await renderScreen();
    await fireEvent.press(screen.getByTestId('assistant-image'));
    await waitFor(() => expect(screen.getByText('文件内容与扩展名不符')).toBeTruthy());
    expect(screen.queryByTestId('assistant-image-chip')).toBeNull();
    expect(loadAttachment(undefined)).toBeNull();
  });

  it('picker 取消静默返回；客户端先验（gif）拦截不上传', async () => {
    mockLaunchImageLibrary.mockResolvedValueOnce({ canceled: true, assets: [] });
    await renderScreen();
    await fireEvent.press(screen.getByTestId('assistant-image'));
    await waitFor(() => expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1));
    expect(mockUploadImage).not.toHaveBeenCalled();
    expect(screen.queryByTestId('assistant-image-chip')).toBeNull();

    mockLaunchImageLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/a.gif', fileName: 'a.gif', mimeType: 'image/gif' }],
    });
    await fireEvent.press(screen.getByTestId('assistant-image'));
    await waitFor(() => expect(screen.getByText('仅支持 jpg / png / webp 图片')).toBeTruthy());
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  it('流式 busy 期间图片钮禁用（对齐输入框语义），停止后恢复', async () => {
    mockChat.mockImplementationOnce(async (_params, _onEvent, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { sessionId: 'sess-b' };
    });
    await renderScreen();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), '长任务');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await waitFor(() => expect(screen.getByLabelText('停止生成')).toBeTruthy());

    expect(screen.getByTestId('assistant-image').props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId('assistant-image'));
    expect(mockLaunchImageLibrary).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('assistant-send')); // 停止
    await waitFor(() => expect(screen.getByLabelText('发送')).toBeTruthy());
    expect(screen.getByTestId('assistant-image').props.accessibilityState?.disabled).toBe(false);
  });

  it('附图句柄随草稿按会话隔离持久化：载入历史会话 chip 清空，回新会话恢复（不重复上传）', async () => {
    mockListSessions.mockResolvedValue([summary('s1', '画猫记录')]);
    mockGetSession.mockResolvedValueOnce({
      ...summary('s1', '画猫记录'),
      messages: [
        { id: 1, role: 'user', content: '历史消息', tool_calls: null, media: [], created_at: '2026-08-15T10:00:00' },
      ],
    });
    await renderScreen();
    await pickAndUpload();
    // ready 句柄已落盘到新会话键
    expect(loadAttachment(undefined)).toMatchObject({
      filename: HANDLE.filename,
      worker: HANDLE.worker,
      previewUri: ASSET.uri,
    });

    // 载入历史会话：chip 清空（s1 无附图草稿）
    await fireEvent.press(screen.getByTestId('assistant-history'));
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('session-item-s1'));
    await waitFor(() => expect(screen.getByText('历史消息')).toBeTruthy());
    expect(screen.queryByTestId('assistant-image-chip')).toBeNull();

    // 回新会话：chip 恢复（句柄来自存储，不重复上传）
    await fireEvent.press(screen.getByTestId('assistant-new'));
    await waitFor(() => expect(screen.getByTestId('assistant-image-chip')).toBeTruthy());
    expect(screen.getByText('cat.png')).toBeTruthy();
    expect(mockUploadImage).toHaveBeenCalledTimes(1);
  });
});
