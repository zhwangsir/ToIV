/**
 * 对话助手屏（M19.2）：POST /api/agent/chat SSE 流式对话
 * - 消息列表：inverted FlatList（聊天惯例，data[0]=最新渲染在底部），user 右 / assistant 左气泡
 * - 流式：text 事件累积进气泡；tool 事件展示调用过程；image 直显 / video·audio·model3d 类型卡
 *   （对齐小程序 MP5 防破图语义）；error 事件 / 请求异常 → 人话标红
 * - 发送即反馈 ≤200ms（输入清空 + 双气泡先入列）；streaming 中发送键变停止键（AbortController）
 * - 会话：顶部 History 抽屉列表 / Plus 新会话；载入回放 getAgentSession；删除走 SessionSheet
 * - 上下文：历史仅取 user/assistant 非 error 文本，连同本轮 ≤40 条（后端 ChatRequest 上限）
 * - 文档挂载（M20.2）：输入栏左侧 Paperclip ghost 钮开关 DocSheet（面板开或有挂载时 accent 高亮）；
 *   挂载文档在输入栏上方横排 chips（可移除）；发送时 id 数组以 document_ids 随 chat 上行，
 *   chips 清空并转移到该条 user 气泡下方留痕（后端不回放文档引用，仅本地轮次展示）
 * - 分叉（M24）：会话列表项「分叉副本」全量 fork / 回放消息气泡长按「从此分叉」截断 fork
 *   （forkAgentSession → 载入新会话，列表失效刷新；失败人话内联）；仅带服务端 id 的回放消息可分叉
 * - 媒体预览（M24）：图片/视频点开全屏 lightbox（多图翻页 / VideoView 播放 / 保存相册）
 * - 输入草稿（M24）：useAssistantDraft 按 sessionId 持久化（MMKV），切换/重进回填，发送成功清空
 * - 附图（M30）：输入条 ImagePlus ghost 钮 → 相册选 1 张即传（uploadImage img2img）→ 输入区上方
 *   chip（上传中 loading 无 X，规避取消竞态；ready 缩略图 + X）；发送 image={filename,worker} 随轮
 *   上行（可与 document_ids 同发），chip 清空转移到 user 气泡本地展示；上传中禁发送/禁再选，
 *   streaming 中图片钮禁用；ready 句柄随草稿按会话隔离持久化（恢复不重复上传，上传失败移除 chip
 *   + 内联人话——最小实现）；后端用户消息落库不含 attachment，会话回放历史气泡无图（契约现状）
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';

import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/hooks/use-app-theme';
import { agentChatStream, forkAgentSession, getAgentSession, mediaUrl, uploadImage } from '@/lib/api';
import type { AgentSessionSummary, DocItem } from '@/types/api';

import {
  applyReady,
  attachmentBusy,
  chipFor,
  imageForRequest,
  loadAttachment,
  pickedImageName,
  saveAttachment,
  startUpload,
  validatePickedImage,
} from './attachment-utils';
import type { ChatAttachment } from './attachment-utils';
import {
  AGENT_HISTORY_LIMIT,
  historyForApi,
  mapSessionMessages,
  nextLocalId,
  reduceAgentEvent,
} from './chat-utils';
import type { ChatItem, ChatMedia } from './chat-utils';
import { DocSheet } from './doc-sheet';
import { useAssistantDraft } from './draft-utils';
import { MediaPreview } from './media-preview';
import type { MediaPreviewTarget } from './media-preview';
import { SessionSheet } from './session-sheet';

/** 非图片产物的类型卡图标（对齐小程序 artifact 卡语义：不内嵌渲染防破图） */
const MEDIA_TYPE_META: Record<string, { icon: IconName; label: string }> = {
  video: { icon: 'Video', label: '视频产物' },
  audio: { icon: 'Music', label: '音频产物' },
  model3d: { icon: 'Box', label: '3D 产物' },
};

function MediaBlock({
  media,
  testID,
  onPreview,
}: {
  media: ChatMedia;
  testID?: string;
  /** 图片/视频点开全屏预览（M24），index 为组内第几个 url；audio/model3d 不支持预览 */
  onPreview?: (index: number) => void;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  if (media.type === 'image') {
    return (
      <View
        testID={testID}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], marginTop: spacing[2] }}
      >
        {media.urls.map((u, i) => (
          <Pressable
            key={u}
            accessibilityRole="button"
            accessibilityLabel={`预览图片 ${i + 1}`}
            onPress={() => onPreview?.(i)}
            testID={testID ? `${testID}-image-${i}` : undefined}
          >
            <Image
              source={{ uri: mediaUrl(u) }}
              style={{ width: 148, height: 148, borderRadius: radius.md, backgroundColor: colors.bg }}
              contentFit="cover"
              transition={200}
              recyclingKey={u}
            />
          </Pressable>
        ))}
      </View>
    );
  }
  const meta = MEDIA_TYPE_META[media.type] ?? { icon: 'Film' as IconName, label: '媒体产物' };
  const cardStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing[2],
    marginTop: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignSelf: 'flex-start' as const,
  };
  const cardBody = (
    <>
      <Icon name={meta.icon} size={18} color={colors.accent} />
      <Text
        style={{
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
        }}
      >
        {meta.label} ×{media.urls.length}
      </Text>
    </>
  );
  // 视频卡可点开全屏播放（M24）；audio/model3d 无可预览形态保持纯展示卡
  if (media.type === 'video' && onPreview) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${meta.label}，点开预览`}
        onPress={() => onPreview(0)}
        testID={testID}
        style={cardStyle}
      >
        {cardBody}
      </Pressable>
    );
  }
  return (
    <View testID={testID} style={cardStyle}>
      {cardBody}
    </View>
  );
}

function MessageBubble({
  item,
  testID,
  onPreview,
  onFork,
}: {
  item: ChatItem;
  testID?: string;
  /** 媒体产物点开预览（M24）：image/video 组 + 组内 index */
  onPreview?: (media: ChatMedia, index: number) => void;
  /** 长按「从此分叉」（M24）：仅回放消息（带 srvId）由父级注入 */
  onFork?: () => void;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const isUser = item.role === 'user';
  return (
    <Pressable
      testID={testID}
      onLongPress={onFork}
      disabled={!onFork}
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        marginBottom: spacing[3],
      }}
    >
      <View
        style={{
          borderRadius: radius.lg,
          borderWidth: isUser ? 0 : 1,
          borderColor: colors.border,
          backgroundColor: isUser ? colors.accent : colors.surface,
          paddingHorizontal: spacing[3],
          paddingVertical: spacing[2],
        }}
      >
        {/* M30 本轮附图：发送后输入区 chip 转移到 user 气泡本地展示（本地 uri，回放无图为契约现状） */}
        {item.image ? (
          <Image
            source={{ uri: item.image.previewUri }}
            testID={testID ? `${testID}-attachment` : undefined}
            accessibilityLabel={`附图：${item.image.name}`}
            style={{
              width: 148,
              height: 148,
              borderRadius: radius.md,
              backgroundColor: colors.bg,
              marginBottom: item.text ? spacing[2] : 0,
            }}
            contentFit="cover"
            transition={200}
            recyclingKey={item.image.previewUri}
          />
        ) : null}
        {item.text ? (
          <Text
            testID={testID ? `${testID}-text` : undefined}
            style={{
              color: item.error ? colors.danger : isUser ? colors.bg : colors.text,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {item.text}
          </Text>
        ) : null}
        {/* 流式等待首段文本：转圈占位（工具调用进行中亦然） */}
        {item.streaming && !item.text ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingVertical: spacing[1] }}>
            <ActivityIndicator color={colors.accent} testID={testID ? `${testID}-pending` : undefined} />
            {item.tools.length > 0 ? (
              <Text
                style={{
                  color: colors.textSecondary,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                正在调用 {item.tools[item.tools.length - 1]}…
              </Text>
            ) : null}
          </View>
        ) : null}
        {item.media.map((m, idx) => (
          <MediaBlock
            key={`${m.type}-${idx}`}
            media={m}
            testID={testID ? `${testID}-media-${idx}` : undefined}
            onPreview={onPreview ? (i) => onPreview(m, i) : undefined}
          />
        ))}
      </View>
      {/* M20：本轮挂载文档 chips 在气泡下方留痕（输入区 chips 发送后转移至此） */}
      {item.docs && item.docs.length > 0 ? (
        <View
          testID={testID ? `${testID}-docs` : undefined}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: spacing[1],
            marginTop: spacing[1],
            justifyContent: isUser ? 'flex-end' : 'flex-start',
          }}
        >
          {item.docs.map((d) => (
            <View
              key={d.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing[1],
                maxWidth: '100%',
                paddingHorizontal: spacing[2],
                paddingVertical: spacing[1],
                borderRadius: radius.full,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.bg,
              }}
            >
              <Icon name="File" size={12} color={colors.textSecondary} />
              <Text
                numberOfLines={1}
                style={{
                  flexShrink: 1,
                  color: colors.textSecondary,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                {d.filename}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

export function AssistantScreen() {
  const { colors, radius, spacing, typography, elevation } = useAppTheme();
  const router = useRouter();

  const [items, setItems] = useState<ChatItem[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  // M24 输入草稿：按 sessionId 持久化（MMKV），切换/重进回填，发送成功清空
  const { value: input, setValue: setInput, clear: clearDraft } = useAssistantDraft(sessionId);
  // M24 媒体预览目标（null=关闭；image/video 全屏 lightbox）
  const [previewTarget, setPreviewTarget] = useState<MediaPreviewTarget | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  // M20 文档挂载：面板开关 + 已挂载文档（chips 数据源，发送时清空转移到 user 气泡）
  const [docSheetOpen, setDocSheetOpen] = useState(false);
  const [attachedDocs, setAttachedDocs] = useState<DocItem[]>([]);
  // M30 附图：chip 数据源（uploading/ready；每次变更即时落盘 assistant_draft:{sid}:image）
  const [attachment, setAttachment] = useState<ChatAttachment | null>(() => loadAttachment(sessionId));
  const [imageError, setImageError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 上传在途切换会话竞态守卫：pick 时捕获 sid，完成只落该会话键、不污染当前屏
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // M30 附图随草稿按会话隔离：切换会话回填目标会话已存句柄（当前会话每次变更已即时落盘）
  const [attLoadedSid, setAttLoadedSid] = useState(sessionId);
  if (sessionId !== attLoadedSid) {
    setAttLoadedSid(sessionId);
    setAttachment(loadAttachment(sessionId));
    setImageError(null);
  }

  /** 附图变更统一入口：即时落盘（无防抖，切换/重进不丢）+ 仍是当前会话才刷 UI */
  const applyAttachment = (sid: string | undefined, next: ChatAttachment | null): void => {
    saveAttachment(sid, next);
    if (sessionIdRef.current === sid) setAttachment(next);
  };

  const patchItem = (id: string, patch: (it: ChatItem) => ChatItem): void =>
    setItems((prev) => prev.map((it) => (it.id === id ? patch(it) : it)));

  const stopStreaming = (): void => {
    abortRef.current?.abort();
  };

  /** 挂载/卸载切换（面板列表项点按） */
  const toggleAttach = (doc: DocItem): void =>
    setAttachedDocs((prev) =>
      prev.some((d) => d.id === doc.id) ? prev.filter((d) => d.id !== doc.id) : [...prev, doc],
    );

  /** chips 行 X 移除 / 面板删除挂载中文档后卸载 */
  const detachDoc = (docId: string): void =>
    setAttachedDocs((prev) => prev.filter((d) => d.id !== docId));

  /**
   * M30 选图即传（链路对齐 ref-image-field「选中即传」；后端单 image 契约仅 1 张，已有 chip 再选 = 替换）
   * 系统相册选图（Expo v57 launchImageLibraryAsync）→ 客户端先验（与 upload.py 白名单同源）
   * → uploadImage(img2img) 拿 {filename,worker} 句柄；取消/先验失败保留旧 chip；
   * 上传失败移除 chip + 内联人话（最小实现）
   */
  const pickImage = async (): Promise<void> => {
    if (streaming || attachmentBusy(attachment)) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setImageError(null);

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
      });
    } catch {
      setImageError('无法打开相册，请重试');
      return;
    }
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    const invalid = validatePickedImage(asset);
    if (invalid) {
      setImageError(invalid);
      return;
    }

    const sid = sessionId;
    const uploading = startUpload(asset.uri, pickedImageName(asset));
    applyAttachment(sid, uploading);
    try {
      const r = await uploadImage(
        { uri: asset.uri, fileName: asset.fileName, mimeType: asset.mimeType },
        'img2img',
      );
      applyAttachment(sid, applyReady(uploading, r));
    } catch (e) {
      applyAttachment(sid, null);
      if (sessionIdRef.current === sid) {
        setImageError(e instanceof Error ? e.message : '上传失败，请重试');
      }
    }
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || streaming || attachmentBusy(attachment)) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setInput('');
    // 发送时快照挂载文档：chips 清空转移到本条 user 气泡下方留痕（对齐 Web 语义）
    const roundDocs = attachedDocs;
    setAttachedDocs([]);
    // M30 附图快照：chip 清空（草稿键一并清除）转移到本条 user 气泡本地展示
    const roundImage = attachment;
    applyAttachment(sessionId, null);
    setImageError(null);
    // 历史基于发送前 items（时间正序、剔除 error/空文本），连同本轮 ≤40 条（后端硬上限）
    const messages = [...historyForApi(items), { role: 'user' as const, content: text }].slice(
      -AGENT_HISTORY_LIMIT,
    );
    const assistantId = nextLocalId();
    const userItem: ChatItem = {
      id: nextLocalId(),
      role: 'user',
      text,
      media: [],
      docs: roundDocs.map((d) => ({ id: d.id, filename: d.filename })),
      image: roundImage ? { previewUri: roundImage.previewUri, name: roundImage.name } : undefined,
      tools: [],
    };
    const assistantItem: ChatItem = {
      id: assistantId,
      role: 'assistant',
      text: '',
      media: [],
      tools: [],
      streaming: true,
    };
    // inverted 列表：data[0] 渲染在底部 → assistant 在 user 之上（视觉旧→新）
    setItems((prev) => [assistantItem, userItem, ...prev]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await agentChatStream(
        {
          messages,
          sessionId,
          documentIds: roundDocs.map((d) => d.id),
          image: imageForRequest(roundImage),
        },
        (ev) => patchItem(assistantId, (it) => reduceAgentEvent(it, ev)),
        controller.signal,
      );
      if (res.sessionId) setSessionId(res.sessionId);
      // 发送成功：草稿键即时清除（输入框在发送时已清空，防抖落盘也一并撤销）
      clearDraft();
    } catch (e) {
      if (!controller.signal.aborted) {
        patchItem(assistantId, (it) => ({
          ...it,
          error: true,
          text: e instanceof Error ? e.message : '网络异常，请重试',
        }));
      }
    } finally {
      patchItem(assistantId, (it) => ({ ...it, streaming: false }));
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const startNewSession = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    stopStreaming();
    setItems([]);
    setSessionId(undefined);
  };

  const loadSession = async (session: AgentSessionSummary): Promise<void> => {
    stopStreaming();
    setSheetOpen(false);
    setLoadingSession(true);
    try {
      const detail = await getAgentSession(session.id);
      setItems(mapSessionMessages(detail.messages));
      setSessionId(detail.id);
    } catch (e) {
      // 回放失败：留在当前上下文，人话以一条系统级 error 气泡呈现
      setItems((prev) => [
        {
          id: nextLocalId(),
          role: 'assistant',
          text: e instanceof Error ? e.message : '会话载入失败，请重试',
          media: [],
          tools: [],
          error: true,
        },
        ...prev,
      ]);
    } finally {
      setLoadingSession(false);
    }
  };

  const queryClient = useQueryClient();
  // M24 分叉：成功载入新会话并失效会话列表；失败人话内联 error 气泡（与载入失败同语义）
  const forkMutation = useMutation({
    mutationFn: ({ sid, atMessageId }: { sid: string; atMessageId?: number }) =>
      forkAgentSession(sid, atMessageId),
    onSuccess: (newSession) => {
      void queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] });
      void loadSession(newSession);
    },
    onError: (e) => {
      setItems((prev) => [
        {
          id: nextLocalId(),
          role: 'assistant' as const,
          text: e instanceof Error ? e.message : '分叉失败，请重试',
          media: [],
          tools: [],
          error: true,
        },
        ...prev,
      ]);
    },
  });

  /** 回放消息气泡长按「从此分叉」截断 fork（仅带 srvId 的回放消息由父级注入 onFork） */
  const confirmForkFromMessage = (item: ChatItem): void => {
    if (!sessionId || item.srvId === undefined) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert('从此分叉', '以这条消息为分界，复制出一个新会话？', [
      { text: '取消', style: 'cancel' },
      {
        text: '分叉',
        onPress: () => forkMutation.mutate({ sid: sessionId, atMessageId: item.srvId }),
      },
    ]);
  };

  /** 媒体产物点开全屏预览（image/video；audio/model3d 类型卡无可预览形态） */
  const openPreview = (media: ChatMedia, index: number): void => {
    if (media.type !== 'image' && media.type !== 'video') return;
    setPreviewTarget({ type: media.type, urls: media.urls, index });
  };

  // M30 附图 chip 展示模型（uploading/ready；null 无 chip）
  const imageChip = chipFor(attachment);
  const imageBusy = attachmentBusy(attachment);

  return (
    <Screen edges={['top', 'left', 'right']} testID="screen-assistant">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, paddingHorizontal: spacing[4] }}>
          {/* 头部：返回 + 标题 + 新会话 + 历史会话 */}
          <View
            style={{
              marginTop: spacing[2],
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回"
              onPress={() => router.back()}
              hitSlop={8}
              testID="assistant-back"
              style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="ChevronLeft" size={24} color={colors.text} />
            </Pressable>
            <Text
              style={{
                color: colors.text,
                fontSize: typography.heading.fontSize,
                lineHeight: typography.heading.lineHeight,
                fontWeight: '700',
              }}
            >
              对话助手
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="新会话"
                onPress={startNewSession}
                hitSlop={8}
                testID="assistant-new"
                style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="Plus" size={24} color={colors.accent} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="历史会话"
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSheetOpen(true);
                }}
                hitSlop={8}
                testID="assistant-history"
                style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="History" size={22} color={colors.text} />
              </Pressable>
            </View>
          </View>

          {/* 消息列表（inverted：底部为最新，开场空态倒置展示） */}
          {items.length === 0 ? (
            <View style={{ flex: 1, justifyContent: 'center' }}>
              {loadingSession ? (
                <ActivityIndicator color={colors.accent} testID="assistant-session-loading" />
              ) : (
                <EmptyState
                  icon="MessageCircle"
                  title="和 ToIV 聊聊"
                  description="一句话描述想要的画面、视频或音乐，助手会自动调用工具完成"
                  testID="empty-assistant"
                />
              )}
            </View>
          ) : (
            <FlatList
              data={items}
              inverted
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <MessageBubble
                  item={item}
                  testID={`msg-${item.id}`}
                  onPreview={openPreview}
                  onFork={
                    item.srvId !== undefined ? () => confirmForkFromMessage(item) : undefined
                  }
                />
              )}
              style={{ flex: 1, marginTop: spacing[2] }}
              contentContainerStyle={{ paddingVertical: spacing[2] }}
              testID="assistant-list"
            />
          )}

          {/* M20 挂载文档 chips 行（输入栏上方横排，X 可移除；发送后清空转移到 user 气泡） */}
          {attachedDocs.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, marginTop: spacing[2] }}
              contentContainerStyle={{ gap: spacing[2], alignItems: 'center' }}
              testID="assistant-doc-chips"
            >
              {attachedDocs.map((d) => (
                <View
                  key={d.id}
                  testID={`assistant-doc-chip-${d.id}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing[1],
                    maxWidth: 220,
                    paddingLeft: spacing[2],
                    paddingRight: spacing[1],
                    paddingVertical: spacing[1],
                    borderRadius: radius.full,
                    borderWidth: 1,
                    borderColor: colors.accent,
                    backgroundColor: colors.accentSoft,
                  }}
                >
                  <Icon name="File" size={14} color={colors.accent} />
                  <Text
                    numberOfLines={1}
                    style={{
                      flexShrink: 1,
                      color: colors.text,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {d.filename}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`移除文档：${d.filename}`}
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      detachDoc(d.id);
                    }}
                    hitSlop={8}
                    testID={`assistant-doc-chip-remove-${d.id}`}
                    style={{ minWidth: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="X" size={14} color={colors.textSecondary} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {/* M30 附图 chip（输入栏上方；上传中 loading 无 X 规避取消竞态，ready 缩略图 + X 移除） */}
          {imageChip ? (
            <View
              testID="assistant-image-chip"
              style={{
                marginTop: spacing[2],
                alignSelf: 'flex-start',
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing[2],
                maxWidth: 260,
                paddingLeft: spacing[1],
                paddingRight: imageChip.uploading ? spacing[3] : spacing[1],
                paddingVertical: spacing[1],
                borderRadius: radius.full,
                borderWidth: 1,
                borderColor: colors.accent,
                backgroundColor: colors.accentSoft,
              }}
            >
              <Image
                source={{ uri: imageChip.previewUri }}
                testID="assistant-image-chip-thumb"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: radius.full,
                  backgroundColor: colors.bg,
                }}
                contentFit="cover"
              />
              <Text
                numberOfLines={1}
                style={{
                  flexShrink: 1,
                  color: colors.text,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                {imageChip.label}
              </Text>
              {imageChip.uploading ? (
                <ActivityIndicator
                  color={colors.accent}
                  size="small"
                  testID="assistant-image-chip-loading"
                />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="移除图片"
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    applyAttachment(sessionId, null);
                  }}
                  hitSlop={8}
                  testID="assistant-image-chip-remove"
                  style={{ minWidth: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="X" size={14} color={colors.textSecondary} />
                </Pressable>
              )}
            </View>
          ) : null}

          {/* M30 附图内联人话（先验拦截/上传失败；chip 已移除，重选即重试） */}
          {imageError ? (
            <Text
              testID="assistant-image-error"
              style={{
                marginTop: spacing[1],
                color: colors.danger,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {imageError}
            </Text>
          ) : null}

          {/* 输入条（贴底悬浮，对齐 PromptBar 语言；streaming 中发送键变停止键） */}
          <View
            testID="assistant-composer"
            style={{
              marginBottom: spacing[2],
              marginTop: spacing[2],
              flexDirection: 'row',
              alignItems: 'flex-end',
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              paddingHorizontal: spacing[1],
              paddingVertical: spacing[1],
              ...elevation.float,
            }}
          >
            {/* M20 文档 ghost 钮：开关文档面板；面板开或有挂载时 accent 高亮（对齐 Web 激活态） */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="文档"
              accessibilityState={{ selected: docSheetOpen || attachedDocs.length > 0 }}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setDocSheetOpen(true);
              }}
              hitSlop={8}
              testID="assistant-docs"
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Icon
                name="Paperclip"
                size={20}
                color={docSheetOpen || attachedDocs.length > 0 ? colors.accent : colors.textSecondary}
              />
            </Pressable>
            {/* M30 图片 ghost 钮：选 1 张即传；有 chip 高亮；上传中/流式 busy 禁用（对齐输入框语义） */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="图片"
              accessibilityState={{ disabled: streaming || imageBusy, selected: imageChip != null }}
              disabled={streaming || imageBusy}
              onPress={() => void pickImage()}
              hitSlop={8}
              testID="assistant-image"
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: streaming || imageBusy ? 0.4 : pressed ? 0.85 : 1,
              })}
            >
              <Icon
                name="ImagePlus"
                size={20}
                color={imageChip ? colors.accent : colors.textSecondary}
              />
            </Pressable>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="说点什么…"
              placeholderTextColor={colors.textSecondary}
              multiline
              editable={!streaming}
              testID="assistant-input"
              style={{
                flex: 1,
                marginHorizontal: spacing[3],
                color: colors.text,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
                minHeight: typography.body.lineHeight,
                maxHeight: typography.body.lineHeight * 6,
                paddingVertical: spacing[2],
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={streaming ? '停止生成' : '发送'}
              accessibilityState={{
                disabled: !streaming && (input.trim().length === 0 || imageBusy),
                busy: streaming,
              }}
              disabled={!streaming && (input.trim().length === 0 || imageBusy)}
              onPress={streaming ? stopStreaming : () => void send()}
              testID="assistant-send"
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.accent,
                opacity:
                  !streaming && (input.trim().length === 0 || imageBusy)
                    ? 0.4
                    : pressed
                      ? 0.85
                      : 1,
              })}
            >
              {streaming ? (
                <Icon name="Square" size={16} color={colors.bg} testID="assistant-stop-icon" />
              ) : (
                <Icon name="ArrowUp" size={20} color={colors.bg} />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <SessionSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        activeSessionId={sessionId}
        onPick={(s) => void loadSession(s)}
        onFork={(s) => forkMutation.mutate({ sid: s.id })}
        onDeletedActive={startNewSession}
      />

      <DocSheet
        visible={docSheetOpen}
        onClose={() => setDocSheetOpen(false)}
        attachedIds={attachedDocs.map((d) => d.id)}
        onToggleAttach={toggleAttach}
        onDeleted={detachDoc}
      />

      <MediaPreview target={previewTarget} onClose={() => setPreviewTarget(null)} />
    </Screen>
  );
}
