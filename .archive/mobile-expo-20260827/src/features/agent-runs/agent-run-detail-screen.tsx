/**
 * Agent 团队运行详情屏（M21.3 一期：只读监控 + 取消；M22 二期：确认门裁决 + 卡片干预；
 * M23 三期：计划编辑 POST /plan + 成片结果 GET /result）
 * - 首屏 GET 拉详情（计划 DAG + 全任务卡片）；SSE 事件流实时更新任务状态与事件 ticker
 * - 任务卡片：kind 中文名 + title + 状态徽章 + attempt 计数 + 产物缩略（video/image/audio 优先）
 * - 事件 ticker：SSE 事件倒序实时流（ack/plan/task_status/blocked/confirm_required/error），
 *   终态断流；底部固定条展示连接态 + 最新事件摘要
 * - 取消：非终态时顶部显示「取消运行」危险按钮；confirm_dialog 二次确认；取消成功后
 *   刷新详情并断流
 * - 确认门（M22）：awaiting_confirm → 计划门横幅；awaiting_assembly → 合成门横幅；
 *   SSE confirm_required 就地驱动门状态（不重连流）；点开底部抽屉裁决 approve/reject
 *   （reject 可带方向性批注 feedback），成功后刷新详情
 * - 计划编辑（M23）：计划门抽屉升级为可编辑面板（对齐 Web PlanPanel：改标题/主文案、
 *   删任务、加任务）；确认时 buildPlanOps 汇总草稿，有改动先 POST /plan 再 resume(modify)，
 *   无改动直 resume(approve)；任一步失败抽屉保持打开、编辑痕迹保留可重试
 * - 成片结果（M23）：done 后 GET /result 拉 final_url，成片卡内嵌 VideoView 播放 +
 *   「保存到相册」（downloadAndSaveToLibrary）；final_url 空串/409 竞态静默不渲染
 * - 卡片干预（M22）：非进行中（running/queued）卡片出「改文案/重生成/通过」操作行；
 *   改文案/重生成走底部抽屉编辑，通过直接提交；成功后用返回的卡片局部替换（不重拉详情）
 * - 卡片干预（M33 四期）：「替换上传」（本地文件直传 multipart，合成卡不出；图/视走
 *   ImagePicker，音频走 DocumentPicker）与「反推提示词」（图像/视频 done 卡，成功后
 *   开改文案抽屉审阅反推 prompt）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  EMPTY_PLAN_DRAFT,
  RUN_TERMINAL,
  buildPlanOps,
  extractTaskMedia,
  primaryInputText,
  runStatusMeta,
  taskDurationSec,
  taskKindLabel,
  taskStatusMeta,
} from '@/lib/agent-run';
import type { PlanDraft } from '@/lib/agent-run';
import {
  agentTaskAction,
  cancelAgentRun,
  getAgentRun,
  getAgentRunResult,
  mediaUrl,
  resumeAgentRun,
  updateAgentRunPlan,
  uploadAgentTaskAsset,
  watchAgentRunEvents,
} from '@/lib/api';
import type { LocalImageInput } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { downloadAndSaveToLibrary } from '@/lib/media';
import type {
  AgentPlanEditOp,
  AgentRunEvent,
  AgentRunResult,
  AgentRunTask,
  AgentTaskActionBody,
} from '@/types/api';

import { StatusBadge } from './status-badge';

/** 事件 ticker 条目 */
export interface TickerItem {
  id: number;
  ts: number;
  text: string;
  tone: 'info' | 'start' | 'done' | 'blocked' | 'decision' | 'error';
}

/** 合并 task_status 事件进本地 task 列表（仅更新载荷里出现的字段） */
function mergeTaskStatus(
  tasks: AgentRunTask[] | undefined,
  data: Extract<AgentRunEvent, { type: 'task_status' }>,
): AgentRunTask[] | undefined {
  if (!tasks || !data.task_id) return tasks;
  return tasks.map((t) => {
    if (t.id !== data.task_id) return t;
    const next: AgentRunTask = { ...t };
    if (data.status) next.status = data.status;
    if (typeof data.attempt === 'number') next.attempt = data.attempt;
    if (data.output) next.output = data.output;
    if (data.gpu_hint) next.gpu_hint = data.gpu_hint;
    return next;
  });
}

/** 事件文本与 tone 派发 */
function makeTickerItem(seqId: number, event: AgentRunEvent): TickerItem | null {
  switch (event.type) {
    case 'ack':
      return { id: seqId, ts: Date.now(), text: event.message || '已接单', tone: 'start' };
    case 'plan':
      return { id: seqId, ts: Date.now(), text: `计划已生成，共 ${event.tasks.length} 步`, tone: 'info' };
    case 'task_status': {
      const meta = taskStatusMeta(event.status);
      const title = event.title || event.task_id || '';
      const spin = meta.spin ? '……' : '';
      return {
        id: seqId,
        ts: Date.now(),
        text: `${title ? `${title} ` : ''}${meta.label}${spin}`,
        tone:
          event.status === 'running'
            ? 'start'
            : event.status === 'done' || event.status === 'approved'
              ? 'done'
              : event.status === 'error' || event.status === 'rejected'
                ? 'error'
                : 'info',
      };
    }
    case 'blocked':
      return {
        id: seqId,
        ts: Date.now(),
        text: `${event.title} 遇到阻塞：${event.error}`,
        tone: 'blocked',
      };
    case 'confirm_required':
      return {
        id: seqId,
        ts: Date.now(),
        text: event.message || '需要确认',
        tone: 'decision',
      };
    case 'error':
      return { id: seqId, ts: Date.now(), text: event.message || '运行出错', tone: 'error' };
    default:
      return null;
  }
}

// ── M22 二期：确认门与卡片干预纯函数（语义逐条对齐 MP22 detail.vue / Web TaskCardList）──

/** 当前待裁决确认门（'' = 无；由详情状态或 SSE confirm_required 就地驱动） */
function gateOfStatus(status: string | undefined): 'plan' | 'assembly' | '' {
  if (status === 'awaiting_confirm') return 'plan';
  if (status === 'awaiting_assembly') return 'assembly';
  return '';
}

/** 进行中卡片不可干预（对齐 Web inflight = running/queued） */
function taskInflight(task: AgentRunTask): boolean {
  return task.status === 'running' || task.status === 'queued';
}

/** 卡片操作行可见性：run 取消/终态后不再干预；assemble 卡走合成确认门不出操作行 */
function taskActionable(runStatus: string, task: AgentRunTask): boolean {
  if (runStatus === 'canceled' || runStatus === 'done' || runStatus === 'error') return false;
  return task.kind !== 'assemble';
}

/** 重生成入口：后端仅 done/error 可重生（其余 409 人话透传），assemble 卡 400 走合成门 */
function taskRegenerable(task: AgentRunTask): boolean {
  return task.status === 'done' || task.status === 'error';
}

/** M33 反推提示词入口：仅图像/视频卡且有产出（done；未产出后端 409 兜底但不出入口） */
function taskRepromptable(task: AgentRunTask): boolean {
  return (task.kind === 'image' || task.kind === 'video') && task.status === 'done';
}

/** M33 替换上传入口：合成卡不出（走合成确认门）；图像/视频/音频卡可替换 */
function taskUploadable(task: AgentRunTask): boolean {
  return task.kind !== 'assemble';
}

/** 接口错误人话提取（apiFetch 已透传后端 detail，这里只兜底未知形态） */
function humanizeError(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : fallback;
}

// ── 子组件 ──

/** 底部动作抽屉（确认门/改文案/重生成共用；busy 时禁止关闭防误触/重复提交） */
function ActionSheet({
  visible,
  title,
  onClose,
  busy = false,
  footer,
  children,
  testID,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  busy?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={busy ? undefined : onClose}
      statusBarTranslucent
    >
      <View
        style={{
          flex: 1,
          justifyContent: 'flex-end',
          backgroundColor: 'rgba(0,0,0,0.4)',
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭抽屉"
          onPress={busy ? undefined : onClose}
          style={{ flex: 1 }}
          testID={testID ? `${testID}-backdrop` : undefined}
        />
        <View
          testID={testID}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.border,
            padding: spacing[5],
            maxHeight: '82%',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text
              style={{
                color: colors.text,
                fontSize: typography.heading.fontSize,
                lineHeight: typography.heading.lineHeight,
                fontWeight: '600',
              }}
            >
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              onPress={busy ? undefined : onClose}
              hitSlop={8}
              testID={testID ? `${testID}-close` : undefined}
              style={{
                minWidth: 40,
                minHeight: 40,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="X" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView style={{ flexGrow: 0, marginTop: spacing[3] }}>{children}</ScrollView>
          {footer ? (
            <View style={{ flexDirection: 'row', gap: spacing[3], marginTop: spacing[4] }}>
              {footer}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/** 抽屉多行输入（打回批注/改文案/引导词共用；textarea 语义 minHeight 88） */
function SheetTextArea({
  value,
  onChangeText,
  placeholder,
  testID,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  testID?: string;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textSecondary}
      multiline
      maxLength={4000}
      testID={testID}
      style={{
        marginTop: spacing[3],
        minHeight: 88,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bg,
        color: colors.text,
        padding: spacing[3],
        fontSize: typography.body.fontSize,
        lineHeight: typography.body.lineHeight,
        textAlignVertical: 'top',
      }}
    />
  );
}

/** 抽屉/操作内联错误（提交失败人话透出，不关抽屉） */
function SheetError({ message, testID }: { message: string | null; testID?: string }) {
  const { colors, spacing, typography } = useAppTheme();
  if (!message) return null;
  return (
    <Text
      testID={testID}
      style={{
        marginTop: spacing[3],
        color: colors.danger,
        fontSize: typography.caption.fontSize,
        lineHeight: typography.caption.lineHeight,
      }}
    >
      {message}
    </Text>
  );
}

/** 抽屉单行输入（M23 计划编辑标题行；与 SheetTextArea 同 token 风格，flex:1 占满行余量） */
function SheetInput({
  value,
  onChangeText,
  placeholder,
  testID,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  testID?: string;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textSecondary}
      maxLength={200}
      testID={testID}
      style={{
        flex: 1,
        height: 40,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bg,
        color: colors.text,
        paddingHorizontal: spacing[3],
        fontSize: typography.body.fontSize,
        lineHeight: typography.body.lineHeight,
      }}
    />
  );
}

/**
 * 计划门可编辑面板（M23；语义逐条对齐 Web PlanPanel）：
 * 改标题/主文案、删任务（本地痕迹，行内移除）、加任务（临时行 new-N）；
 * 确认时由父级 buildPlanOps 汇总 → 有改动先 POST /plan 再 resume(modify)，无改动直 resume(approve)
 */
function PlanGateEditor({
  tasks,
  draft,
  onPatchEdit,
  onRemove,
  onPatchAdded,
  onDropAdded,
  onAdd,
  testID,
}: {
  tasks: AgentRunTask[];
  draft: PlanDraft;
  onPatchEdit: (id: string, patch: { title?: string; inputText?: string; inputKey?: string }) => void;
  onRemove: (id: string) => void;
  onPatchAdded: (id: string, patch: { title?: string; inputText?: string }) => void;
  onDropAdded: (id: string) => void;
  onAdd: () => void;
  testID?: string;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const visibleTasks = tasks.filter((t) => !draft.removed.includes(t.id));
  const orderOf = (id: string): number => tasks.findIndex((t) => t.id === id) + 1;

  const editOf = (t: AgentRunTask): { title: string; inputText: string; inputKey: string } => {
    const e = draft.edits[t.id];
    const primary = primaryInputText(t.input);
    return {
      title: e?.title ?? t.title,
      inputText: e?.inputText ?? primary.value,
      inputKey: e?.inputKey ?? primary.key,
    };
  };

  const captionStyle = {
    color: colors.textSecondary,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
  };

  const renderDelete = (label: string, onPress: () => void, tid: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      testID={tid}
      style={({ pressed }) => [
        {
          minWidth: 40,
          minHeight: 40,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.md,
        },
        pressed ? { opacity: 0.7 } : null,
      ]}
    >
      <Icon name="Trash2" size={16} color={colors.danger} />
    </Pressable>
  );

  return (
    <View testID={testID} style={{ marginTop: spacing[3], gap: spacing[3] }}>
      {visibleTasks.map((t) => {
        const e = editOf(t);
        return (
          <View
            key={t.id}
            testID={`gate-plan-row-${t.id}`}
            style={{ flexDirection: 'row', gap: spacing[2] }}
          >
            <Text style={[{ width: 20, marginTop: 10 }, captionStyle]}>{orderOf(t.id)}</Text>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                <Text style={captionStyle}>{taskKindLabel(t.kind)}</Text>
                <SheetInput
                  value={e.title}
                  placeholder="任务标题"
                  onChangeText={(text) => onPatchEdit(t.id, { title: text })}
                  testID={`gate-plan-title-${t.id}`}
                />
                {renderDelete(
                  `删除任务 ${e.title || t.id}`,
                  () => onRemove(t.id),
                  `gate-plan-remove-${t.id}`,
                )}
              </View>
              {t.depends_on.length > 0 ? (
                <Text style={[captionStyle, { marginTop: spacing[1] }]}>
                  依赖{' '}
                  {t.depends_on
                    .map((d) => {
                      const n = orderOf(d);
                      return n > 0 ? `第 ${n} 步` : d;
                    })
                    .join('、')}
                </Text>
              ) : null}
              <SheetTextArea
                value={e.inputText}
                onChangeText={(text) => onPatchEdit(t.id, { inputText: text, inputKey: e.inputKey })}
                placeholder="该任务的提示词/文案"
                testID={`gate-plan-input-${t.id}`}
              />
            </View>
          </View>
        );
      })}
      {draft.added.map((a) => (
        <View
          key={a.id}
          testID={`gate-plan-row-${a.id}`}
          style={{ flexDirection: 'row', gap: spacing[2] }}
        >
          <Text style={[{ width: 20, marginTop: 10 }, captionStyle]}>+</Text>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
              <Text style={captionStyle}>新任务</Text>
              <SheetInput
                value={a.title}
                placeholder="任务标题"
                onChangeText={(text) => onPatchAdded(a.id, { title: text })}
                testID={`gate-plan-new-title-${a.id}`}
              />
              {renderDelete('移除新增任务', () => onDropAdded(a.id), `gate-plan-new-drop-${a.id}`)}
            </View>
            <SheetTextArea
              value={a.inputText}
              onChangeText={(text) => onPatchAdded(a.id, { inputText: text })}
              placeholder="该任务的提示词/文案"
              testID={`gate-plan-new-input-${a.id}`}
            />
          </View>
        </View>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="加任务"
        onPress={onAdd}
        testID="gate-plan-add-btn"
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing[1],
            minHeight: 40,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
          },
          pressed ? { opacity: 0.7 } : null,
        ]}
      >
        <Icon name="Plus" size={14} color={colors.accent} />
        <Text
          style={{
            color: colors.accent,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
            fontWeight: '600',
          }}
        >
          加任务
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * 成片结果卡（M23；仅 done 且 final_url 非空时由父级渲染）：
 * VideoView 原生控制条播放成片（expo-video v57：useVideoPlayer + VideoView，与产物详情视频舞台同式）；
 * 「保存到相册」走 downloadAndSaveToLibrary（expo-file-system 下载 cache → expo-media-library 入册）
 */
function ResultCard({ result, testID }: { result: AgentRunResult; testID?: string }) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const url = mediaUrl(result.final_url);
  const player = useVideoPlayer(url);

  const save = async (): Promise<void> => {
    if (saveState === 'saving') return;
    setSaveState('saving');
    setSaveError(null);
    try {
      await downloadAndSaveToLibrary(url);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSaveState('saved');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSaveState('idle');
      setSaveError(err instanceof Error ? err.message : '保存失败，请稍后重试');
    }
  };

  return (
    <View
      testID={testID}
      style={{
        marginHorizontal: spacing[4],
        marginTop: spacing[3],
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing[3],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
        <Icon name="Film" size={18} color={colors.success} />
        <Text
          style={{
            flex: 1,
            color: colors.text,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
            fontWeight: '600',
          }}
        >
          成片已就绪
        </Text>
        {result.duration_sec > 0 ? (
          <Text
            testID={testID ? `${testID}-duration` : undefined}
            style={{
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            ≈ {result.duration_sec}s
          </Text>
        ) : null}
      </View>
      <View
        style={{
          marginTop: spacing[3],
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: colors.bg,
        }}
      >
        <VideoView
          player={player}
          style={{ width: '100%', height: 200 }}
          contentFit="contain"
          nativeControls
          testID={testID ? `${testID}-video` : undefined}
        />
      </View>
      <Text
        testID={testID ? `${testID}-tasks-count` : undefined}
        style={{
          marginTop: spacing[2],
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
        }}
      >
        产物任务 {result.tasks.length} 个
      </Text>
      <View style={{ marginTop: spacing[3] }}>
        <Button
          title={saveState === 'saved' ? '已保存到相册' : '保存到相册'}
          onPress={() => void save()}
          size="sub"
          loading={saveState === 'saving'}
          disabled={saveState === 'saved'}
          testID={testID ? `${testID}-save-btn` : undefined}
        />
      </View>
      <SheetError message={saveError} testID={testID ? `${testID}-save-error` : undefined} />
    </View>
  );
}


function TaskCard({
  task,
  testID,
  runStatus,
  actionBusy,
  onEdit,
  onRegen,
  onApprove,
  onUpload,
  onReprompt,
}: {
  task: AgentRunTask;
  testID?: string;
  /** 当前 run 有效状态（含 SSE 就地驱动）；终态/取消后操作行整体隐藏 */
  runStatus: string;
  /** 进行中的卡片操作 key（`${taskId}:${action}`），非空时全行禁用防重复提交 */
  actionBusy: string;
  onEdit: (task: AgentRunTask) => void;
  onRegen: (task: AgentRunTask) => void;
  onApprove: (task: AgentRunTask) => void;
  /** M33：替换上传（本地文件直传 multipart） */
  onUpload: (task: AgentRunTask) => void;
  /** M33：反推提示词（写回 input 后开改文案抽屉审阅） */
  onReprompt: (task: AgentRunTask) => void;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const meta = taskStatusMeta(task.status);
  const media = extractTaskMedia(task.output);
  const inflight = taskInflight(task);
  const disabled = inflight || !!actionBusy;

  const actionBtnStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing[1],
    minHeight: 40,
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  };

  return (
    <View
      testID={testID}
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing[3],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            color: colors.text,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
            fontWeight: '600',
          }}
        >
          {task.title}
        </Text>
        <StatusBadge
          label={meta.label}
          tone={meta.tone}
          spin={meta.spin}
          testID={testID ? `${testID}-status` : undefined}
        />
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing[1],
          marginTop: spacing[2],
        }}
      >
        <Text
          testID={testID ? `${testID}-kind` : undefined}
          style={{
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {taskKindLabel(task.kind)}
        </Text>
        {task.attempt > 1 ? (
          <Text
            testID={testID ? `${testID}-attempt` : undefined}
            style={{
              color: colors.warning,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            第 {task.attempt} 次
          </Text>
        ) : null}
      </View>

      {/* 产物（video/image/audio 优先，文本兜底；一期只读，不渲染播放控件） */}
      {media.kind !== 'none' && media.kind !== 'text' ? (
        <View
          testID={testID ? `${testID}-media` : undefined}
          style={{
            marginTop: spacing[2],
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[2],
          }}
        >
          <Icon
            name={media.kind === 'video' ? 'Film' : media.kind === 'audio' ? 'Music' : 'Image'}
            size={16}
            color={colors.accent}
          />
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: colors.accent,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {media.src}
          </Text>
        </View>
      ) : media.kind === 'text' && media.text ? (
        <Text
          testID={testID ? `${testID}-text` : undefined}
          style={{
            marginTop: spacing[2],
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {media.text}
        </Text>
      ) : null}

      {/* 卡片干预（M22）：改文案 / 重生成（done/error）/ 通过；进行中或终态不可干预 */}
      {taskActionable(runStatus, task) ? (
        <View
          testID={testID ? `${testID}-actions` : undefined}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: spacing[2],
            marginTop: spacing[3],
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`改文案：${task.title}`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => onEdit(task)}
            testID={testID ? `${testID}-edit-btn` : undefined}
            style={({ pressed }) => [
              actionBtnStyle,
              { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
            ]}
          >
            <Icon name="Pencil" size={14} color={colors.textSecondary} />
            <Text
              style={{
                color: colors.text,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              改文案
            </Text>
          </Pressable>
          {taskRegenerable(task) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`重生成：${task.title}`}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onRegen(task)}
              testID={testID ? `${testID}-regen-btn` : undefined}
              style={({ pressed }) => [
                actionBtnStyle,
                { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
              ]}
            >
              <Icon name="RefreshCw" size={14} color={colors.textSecondary} />
              <Text
                style={{
                  color: colors.text,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                重生成
              </Text>
            </Pressable>
          ) : null}
          {task.status !== 'approved' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`通过：${task.title}`}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onApprove(task)}
              testID={testID ? `${testID}-approve-btn` : undefined}
              style={({ pressed }) => [
                actionBtnStyle,
                { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
              ]}
            >
              <Icon name="Check" size={14} color={colors.success} />
              <Text
                style={{
                  color: colors.success,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                通过
              </Text>
            </Pressable>
          ) : null}
          {/* M33 四期：替换上传（合成卡不出）/ 反推提示词（图像/视频 done 卡） */}
          {taskUploadable(task) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`替换上传：${task.title}`}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onUpload(task)}
              testID={testID ? `${testID}-upload-btn` : undefined}
              style={({ pressed }) => [
                actionBtnStyle,
                { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
              ]}
            >
              <Icon name="Upload" size={14} color={colors.textSecondary} />
              <Text
                style={{
                  color: colors.text,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                替换
              </Text>
            </Pressable>
          ) : null}
          {taskRepromptable(task) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`反推提示词：${task.title}`}
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onReprompt(task)}
              testID={testID ? `${testID}-reprompt-btn` : undefined}
              style={({ pressed }) => [
                actionBtnStyle,
                { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
              ]}
            >
              <Icon name="Wand2" size={14} color={colors.textSecondary} />
              <Text
                style={{
                  color: colors.text,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                反推
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function TickerBar({
  items,
  connecting,
  testID,
}: {
  items: TickerItem[];
  connecting: boolean;
  testID?: string;
}) {
  const { colors, spacing, typography } = useAppTheme();
  const latest = items[0];

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing[2],
        paddingHorizontal: spacing[3],
        paddingVertical: spacing[2],
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface,
        minHeight: 48,
      }}
    >
      {connecting ? (
        <ActivityIndicator size={14} color={colors.accent} testID={testID ? `${testID}-spinner` : undefined} />
      ) : (
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.textSecondary,
          }}
        />
      )}
      <Text
        numberOfLines={1}
        testID={testID ? `${testID}-latest` : undefined}
        style={{
          flex: 1,
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
        }}
      >
        {latest ? latest.text : '等待事件……'}
      </Text>
      {items.length > 0 ? (
        <Text
          testID={testID ? `${testID}-count` : undefined}
          style={{
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize - 2,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {items.length} 条
        </Text>
      ) : null}
    </View>
  );
}

export function AgentRunDetailScreen() {
  const { colors, radius, spacing, typography } = useAppTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: runId } = useLocalSearchParams<{ id: string }>();

  const [tasks, setTasks] = useState<AgentRunTask[] | undefined>(undefined);
  const [ticker, setTicker] = useState<TickerItem[]>([]);
  const [sseConnecting, setSseConnecting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // ── M22 二期状态 ──
  // SSE confirm_required/error 就地驱动的运行状态覆盖（不动 query 缓存引用，避免 SSE 因 status 依赖重连重放）
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [gateRejecting, setGateRejecting] = useState(false);
  const [gateFeedback, setGateFeedback] = useState('');
  const [editTask, setEditTask] = useState<AgentRunTask | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [regenTask, setRegenTask] = useState<AgentRunTask | null>(null);
  const [regenGuidance, setRegenGuidance] = useState('');
  // 操作失败人话（抽屉开着时内联进抽屉，否则落到横幅）；`${taskId}:${action}` 忙键防重复提交
  const [actionError, setActionError] = useState<string | null>(null);
  const [taskBusyKey, setTaskBusyKey] = useState('');
  // ticker 条目自增序号（同毫秒事件不撞 key；对齐 Web 端 seq 盒子语义）
  const tickerSeq = useRef(0);
  // ── M23 三期状态 ──
  // 计划编辑草稿（本地痕迹；开门即重置、确认成功后清空——对齐 Web PlanPanel PlanDraft）
  const [planDraft, setPlanDraft] = useState<PlanDraft>(EMPTY_PLAN_DRAFT);
  // 新增任务临时 id 自增（落库时后端可替换；对齐 Web addSeq）
  const planAddSeq = useRef(1);

  const detailQuery = useQuery({
    queryKey: ['agent-runs', 'detail', runId],
    queryFn: () => getAgentRun(runId),
    enabled: !!runId,
  });

  const detail = detailQuery.data;

  // 有效状态 = SSE 就地覆盖 ?? 详情快照；详情 refetch 换引用即清覆盖（回到服务端事实源）
  const [statusSource, setStatusSource] = useState(detail);
  if (detail !== statusSource) {
    setStatusSource(detail);
    setLiveStatus(null);
  }
  const effStatus = liveStatus ?? detail?.status;
  const terminal = !!effStatus && RUN_TERMINAL.has(effStatus);
  const gateKind = gateOfStatus(effStatus);

  // M23：done 后拉成片结果（后端仅 done 可取否则 409；done 为终态不再翻转，竞态 409 静默不展示）
  const resultQuery = useQuery({
    queryKey: ['agent-runs', 'result', runId],
    queryFn: () => getAgentRunResult(runId),
    enabled: !!runId && effStatus === 'done',
    retry: false,
  });

  // 初始 task 同步（GET 返回即写本地态，SSE 增量合并）
  // render 期间调整状态（React 推荐模式，替代 setState-in-effect；对齐 artifact-detail 保活模式）：
  // refetch 后 plan 引用变更即全量覆盖；SSE 合并只改本地 tasks，不动引用源
  const [planSource, setPlanSource] = useState(detail?.plan);
  if (detail?.plan && detail.plan !== planSource) {
    setPlanSource(detail.plan);
    setTasks(detail.plan);
  }

  // SSE 事件订阅（终态不订阅；对齐 Web 端：open 即连，终态关流）
  // after=0 全量重放：事件表为唯一事实源，重放历史帧快速补齐 ticker（后端按 id 升序推送）
  // 注意：必须等首屏 detail 回来再决策（status 未知前不订阅，否则终态 run 会误开流）
  const runStatus = detail?.status;
  useEffect(() => {
    if (!runId || !runStatus || RUN_TERMINAL.has(runStatus)) return;
    let disposed = false;
    const ctrl = new AbortController();

    void (async () => {
      try {
        setSseConnecting(true);
        await watchAgentRunEvents(
          runId,
          0,
          (event) => {
            if (disposed) return;
            if (event.type === 'task_status') {
              setTasks((prev) => mergeTaskStatus(prev, event));
            }
            // M22：confirm_required 就地开门（计划门/合成门）；run 级 error 就地终态
            // （只覆盖 liveStatus，不动 query 缓存引用，本 effect 不会因 status 翻转重连重放）
            if (event.type === 'confirm_required') {
              setLiveStatus(
                event.gate === 'assembly' ? 'awaiting_assembly' : 'awaiting_confirm',
              );
            }
            if (event.type === 'error') {
              setLiveStatus('error');
            }
            const item = makeTickerItem(++tickerSeq.current, event);
            if (item) {
              setTicker((prev) => [item, ...prev].slice(0, 100));
            }
          },
          ctrl.signal,
        );
      } catch {
        /* 中止或终态关流静默忽略 */
      } finally {
        if (!disposed) setSseConnecting(false);
      }
    })();

    return () => {
      disposed = true;
      ctrl.abort();
    };
  }, [runId, runStatus]);

  const cancelMutation = useMutation({
    mutationFn: () => cancelAgentRun(runId),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setConfirmCancel(false);
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
      void detailQuery.refetch();
    },
    onError: (e: unknown) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setCancelError(
        e instanceof Error ? e.message : typeof e === 'string' ? e : '取消失败，请稍后重试',
      );
    },
  });

  const onCancel = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setCancelError(null);
    setConfirmCancel(true);
  }, []);

  // ── M22 二期：确认门裁决 ──

  const resumeMutation = useMutation({
    mutationFn: (vars: { gate: 'plan' | 'assembly'; action: 'approve' | 'reject' | 'modify' }) =>
      resumeAgentRun(runId, {
        gate: vars.gate,
        action: vars.action,
        // reject 可带方向性批注（计划门记入 run.error 供重规划参考）；approve/modify 不带
        ...(vars.action === 'reject' && gateFeedback.trim()
          ? { feedback: gateFeedback.trim() }
          : {}),
      }),
    onSuccess: (res) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setGateOpen(false);
      setGateRejecting(false);
      setGateFeedback('');
      setActionError(null);
      // M23：确认成功后清计划编辑草稿（改动已落库/裁决已记录，痕迹不跨轮次残留）
      setPlanDraft(EMPTY_PLAN_DRAFT);
      planAddSeq.current = 1;
      // 就地应用响应状态（计划门 approve → running 启动图执行；reject → planning 重规划），随后 refetch 对齐服务端
      setLiveStatus(res.status || null);
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
      void detailQuery.refetch();
    },
    onError: (e: unknown) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // 409 等后端人话由 apiFetch 透传；抽屉保持打开可重试
      setActionError(humanizeError(e, '提交裁决失败，请稍后重试'));
    },
  });

  const openGate = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setGateRejecting(false);
    setGateFeedback('');
    setActionError(null);
    // M23：开门即重置编辑草稿（关闭未确认的痕迹不带到下一轮）
    setPlanDraft(EMPTY_PLAN_DRAFT);
    planAddSeq.current = 1;
    setGateOpen(true);
  }, []);

  // ── M23 三期：计划编辑（POST /plan；确认门先落改动再 resume 收尾）──

  const planMutation = useMutation({
    mutationFn: (ops: AgentPlanEditOp[]) => updateAgentRunPlan(runId, ops),
    onError: (e: unknown) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // 409「仅待确认状态可编辑计划」等人话透传；抽屉保持打开、编辑痕迹保留可重试
      setActionError(humanizeError(e, '保存计划改动失败，请稍后重试'));
    },
  });

  const submitGate = useCallback(
    (action: 'approve' | 'reject') => {
      if (!gateKind || resumeMutation.isPending || planMutation.isPending) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      resumeMutation.mutate({ gate: gateKind, action });
    },
    [gateKind, resumeMutation, planMutation],
  );

  const patchPlanEdit = useCallback(
    (id: string, patch: { title?: string; inputText?: string; inputKey?: string }) => {
      setPlanDraft((d) => ({ ...d, edits: { ...d.edits, [id]: { ...d.edits[id], ...patch } } }));
    },
    [],
  );

  const removePlanTask = useCallback((id: string) => {
    setPlanDraft((d) => ({ ...d, removed: [...d.removed, id] }));
  }, []);

  const addPlanTask = useCallback(() => {
    // id 必须在 setState 外捕获：updater 延后在渲染期执行，届时 current 已自增（对齐 Web addSeq 事件期取值语义）
    const id = `new-${planAddSeq.current}`;
    planAddSeq.current += 1;
    setPlanDraft((d) => ({
      ...d,
      added: [...d.added, { id, title: '', inputText: '' }],
    }));
  }, []);

  const patchPlanAdded = useCallback((id: string, patch: { title?: string; inputText?: string }) => {
    setPlanDraft((d) => ({
      ...d,
      added: d.added.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  }, []);

  const dropPlanAdded = useCallback((id: string) => {
    setPlanDraft((d) => ({ ...d, added: d.added.filter((a) => a.id !== id) }));
  }, []);

  /**
   * 计划门确认（M23；对齐 Web PlanPanel.confirm）：
   * buildPlanOps 汇总草稿 → 有改动先 POST /plan（409 人话透传），再 resume（改动→modify /
   * 无改动→approve）；任一步失败抽屉保持打开、痕迹保留可重试（onError 已透出 actionError）
   */
  const submitPlanConfirm = useCallback(async () => {
    if (resumeMutation.isPending || planMutation.isPending) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const ops = buildPlanOps(tasks ?? detail?.plan ?? [], planDraft);
    try {
      if (ops.length > 0) await planMutation.mutateAsync(ops);
      await resumeMutation.mutateAsync({
        gate: 'plan',
        action: ops.length > 0 ? 'modify' : 'approve',
      });
    } catch {
      /* 错误已由 mutation onError 透出到抽屉错误条，编辑痕迹保留 */
    }
  }, [tasks, detail, planDraft, planMutation, resumeMutation]);

  // ── M22 二期：卡片级干预（edit 改文案 / regenerate 引导词重生 / approve 通过）──

  const taskMutation = useMutation({
    mutationFn: (vars: { taskId: string; body: AgentTaskActionBody }) =>
      agentTaskAction(runId, vars.taskId, vars.body),
    onMutate: (vars) => {
      setTaskBusyKey(`${vars.taskId}:${vars.body.action}`);
      setActionError(null);
    },
    onSuccess: (updated, vars) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // 成功后用返回的卡片（attempt 已 +1）局部替换，不重拉详情（对齐 MP22 applyTaskUpdate）
      setTasks((prev) =>
        (prev ?? detail?.plan ?? []).map((t) => (t.id === updated.id ? updated : t)),
      );
      if (vars.body.action === 'edit') setEditTask(null);
      if (vars.body.action === 'regenerate') {
        setRegenTask(null);
        setRegenGuidance('');
      }
      if (vars.body.action === 'reprompt') {
        // 反推 prompt 写回 input：开改文案抽屉供审阅微调（用返回的最新卡片，不用旧闭包 task）
        setEditDraft(primaryInputText(updated.input).value);
        setEditTask(updated);
      }
    },
    onError: (e: unknown) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setActionError(humanizeError(e, '操作失败，请稍后重试'));
    },
    onSettled: () => setTaskBusyKey(''),
  });

  const openTaskEdit = useCallback(
    (task: AgentRunTask) => {
      if (taskInflight(task) || taskBusyKey) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setEditDraft(primaryInputText(task.input).value);
      setActionError(null);
      setEditTask(task);
    },
    [taskBusyKey],
  );

  const openTaskRegen = useCallback(
    (task: AgentRunTask) => {
      if (taskInflight(task) || taskBusyKey) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setRegenGuidance('');
      setActionError(null);
      setRegenTask(task);
    },
    [taskBusyKey],
  );

  const submitTaskEdit = useCallback(() => {
    const task = editTask;
    if (!task || taskMutation.isPending) return;
    // 前端契约 payload={input:{...}}：全量 input 覆写主文案 key（后端再做一次 merge 容错）
    const primary = primaryInputText(task.input);
    taskMutation.mutate({
      taskId: task.id,
      body: { action: 'edit', payload: { input: { ...task.input, [primary.key]: editDraft } } },
    });
  }, [editTask, editDraft, taskMutation]);

  const submitTaskRegen = useCallback(() => {
    const task = regenTask;
    if (!task || taskMutation.isPending) return;
    const guidance = regenGuidance.trim();
    taskMutation.mutate({
      taskId: task.id,
      body: { action: 'regenerate', ...(guidance ? { payload: { guidance } } : {}) },
    });
  }, [regenTask, regenGuidance, taskMutation]);

  const submitTaskApprove = useCallback(
    (task: AgentRunTask) => {
      if (taskInflight(task) || taskMutation.isPending) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      taskMutation.mutate({ taskId: task.id, body: { action: 'approve' } });
    },
    [taskMutation],
  );

  // ── M33 四期：替换上传（本地文件直传）/ 反推提示词（写回 input 后开抽屉审阅） ──

  const submitTaskReprompt = useCallback(
    (task: AgentRunTask) => {
      if (taskInflight(task) || taskMutation.isPending) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      // onSuccess 里用返回的最新卡片开改文案抽屉（reprompt 分支）
      taskMutation.mutate({ taskId: task.id, body: { action: 'reprompt' } });
    },
    [taskMutation],
  );

  const uploadMutation = useMutation({
    mutationFn: (vars: { taskId: string; file: LocalImageInput }) =>
      uploadAgentTaskAsset(runId, vars.taskId, vars.file),
    onMutate: (vars) => {
      setTaskBusyKey(`${vars.taskId}:upload`);
      setActionError(null);
    },
    onSuccess: (updated) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // 局部替换（对齐 taskMutation；产物 url 已换为上传落盘产物）
      setTasks((prev) =>
        (prev ?? detail?.plan ?? []).map((t) => (t.id === updated.id ? updated : t)),
      );
    },
    onError: (e: unknown) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setActionError(humanizeError(e, '替换上传失败，请稍后重试'));
    },
    onSettled: () => setTaskBusyKey(''),
  });

  /** 替换上传选媒体：image/video 走相册（ImagePicker）；audio 走文件选择器（DocumentPicker） */
  const openTaskUpload = useCallback(
    async (task: AgentRunTask) => {
      if (taskInflight(task) || taskBusyKey) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      let file: LocalImageInput | null = null;
      if (task.kind === 'audio') {
        let result: DocumentPicker.DocumentPickerResult;
        try {
          result = await DocumentPicker.getDocumentAsync({ type: 'audio/*' });
        } catch {
          setActionError('无法打开文件选择器，请重试');
          return;
        }
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset) return;
        file = { uri: asset.uri, fileName: asset.name, mimeType: asset.mimeType };
      } else {
        let result: ImagePicker.ImagePickerResult;
        try {
          result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: task.kind === 'video' ? ['videos'] : ['images'],
            allowsMultipleSelection: false,
            quality: 1,
          });
        } catch {
          setActionError('无法打开相册，请重试');
          return;
        }
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset) return;
        file = {
          uri: asset.uri,
          fileName: asset.fileName ?? undefined,
          mimeType: asset.mimeType,
        };
      }
      if (!uploadMutation.isPending) {
        uploadMutation.mutate({ taskId: task.id, file });
      }
    },
    [taskBusyKey, uploadMutation],
  );

  const runMeta = runStatusMeta(effStatus ?? '');

  if (!runId) {
    return (
      <Screen testID="screen-agent-run-detail">
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState
            icon="Info"
            title="参数缺失"
            description="无法解析运行 ID，请从列表页进入"
            testID="agent-run-missing-id"
          />
        </View>
      </Screen>
    );
  }

  const shownTasks = tasks ?? detail?.plan ?? [];
  // 合成门时间线合计时长（input.duration_sec 求和，非法值归 0；对齐 MP22 gateTotalSec）
  const gateTotalSec = shownTasks.reduce((sum, t) => sum + taskDurationSec(t), 0);
  // M23：计划门可见任务数（草稿删行隐藏 + 新增临时行）；全删空时禁确认（对齐 Web PlanPanel）
  const planVisibleCount =
    shownTasks.filter((t) => !planDraft.removed.includes(t.id)).length + planDraft.added.length;

  return (
    <Screen testID="screen-agent-run-detail" edges={['top', 'left', 'right']}>
      <View style={{ flex: 1 }}>
        {/* 头部 */}
        <View
          style={{
            paddingHorizontal: spacing[4],
            paddingTop: spacing[2],
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
            testID="agent-run-detail-back"
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="ChevronLeft" size={24} color={colors.text} />
          </Pressable>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              textAlign: 'center',
              color: colors.text,
              fontSize: typography.heading.fontSize,
              lineHeight: typography.heading.lineHeight,
              fontWeight: '700',
            }}
          >
            {detail?.goal ?? '运行详情'}
          </Text>
          <View style={{ minWidth: 48 }} />
        </View>

        {detailQuery.isPending ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.accent} testID="agent-run-detail-loading" />
          </View>
        ) : (
          <>
            {/* 元信息区 */}
            <View
              style={{
                marginHorizontal: spacing[4],
                marginTop: spacing[3],
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing[2],
                flexWrap: 'wrap',
              }}
            >
              <StatusBadge
                label={runMeta.label}
                tone={runMeta.tone}
                spin={effStatus === 'planning' || effStatus === 'running'}
                testID="agent-run-detail-status"
              />
              {detail?.level ? (
                <Text
                  testID="agent-run-detail-level"
                  style={{
                    color: colors.textSecondary,
                    fontSize: typography.caption.fontSize - 2,
                    lineHeight: typography.caption.lineHeight,
                    fontWeight: '700',
                  }}
                >
                  {detail.level}
                </Text>
              ) : null}
              {detail?.created_at ? (
                <Text
                  testID="agent-run-detail-time"
                  style={{
                    color: colors.textSecondary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                  }}
                >
                  {formatRelativeTime(detail.created_at)}
                </Text>
              ) : null}
            </View>

            {/* 确认门横幅（M22）：awaiting_confirm → 计划门；awaiting_assembly → 合成门 */}
            {gateKind ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="打开确认门裁决"
                onPress={openGate}
                testID="agent-run-gate-banner"
                style={({ pressed }) => [
                  {
                    marginHorizontal: spacing[4],
                    marginTop: spacing[3],
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing[3],
                    backgroundColor: colors.surface,
                    borderWidth: 1,
                    borderColor: colors.accent,
                    borderRadius: radius.lg,
                    padding: spacing[3],
                  },
                  pressed ? { opacity: 0.85 } : null,
                ]}
              >
                <Icon
                  name={gateKind === 'plan' ? 'Layers' : 'Film'}
                  size={20}
                  color={colors.accent}
                />
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      color: colors.text,
                      fontSize: typography.body.fontSize,
                      lineHeight: typography.body.lineHeight,
                      fontWeight: '600',
                    }}
                  >
                    {gateKind === 'plan' ? '计划待确认' : '合成前确认'}
                  </Text>
                  <Text
                    style={{
                      marginTop: spacing[1],
                      color: colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    {gateKind === 'plan'
                      ? '检查任务计划，确认后开始执行'
                      : '全部任务已就绪，确认合成成片'}
                  </Text>
                </View>
                <View
                  style={{
                    backgroundColor: colors.accent,
                    borderRadius: radius.md,
                    paddingHorizontal: spacing[3],
                    paddingVertical: spacing[2],
                  }}
                >
                  <Text
                    style={{
                      color: colors.bg,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                      fontWeight: '600',
                    }}
                  >
                    去裁决
                  </Text>
                </View>
              </Pressable>
            ) : null}

            {/* 成片结果卡（M23）：done 且拿到 final_url 才渲染；拉取中/409 竞态静默不展示 */}
            {effStatus === 'done' && resultQuery.data?.final_url ? (
              <ResultCard result={resultQuery.data} testID="agent-run-result-card" />
            ) : null}

            {/* 卡片直操作失败横幅（M22；抽屉类错误内联在各自抽屉里） */}
            {actionError && !gateOpen && !editTask && !regenTask ? (
              <View
                style={{
                  marginHorizontal: spacing[4],
                  marginTop: spacing[3],
                  borderWidth: 1,
                  borderColor: colors.danger,
                  borderRadius: radius.md,
                  padding: spacing[3],
                }}
              >
                <Text
                  testID="agent-run-action-error"
                  style={{
                    color: colors.danger,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                  }}
                >
                  {actionError}
                </Text>
              </View>
            ) : null}

            {/* 取消按钮（非终态） */}
            {!terminal ? (
              <View style={{ marginHorizontal: spacing[4], marginTop: spacing[3] }}>
                <Button
                  title="取消运行"
                  onPress={onCancel}
                  variant="danger"
                  testID="agent-run-cancel-btn"
                  loading={cancelMutation.isPending}
                />
              </View>
            ) : null}

            {/* 任务列表 */}
            <FlatList
              data={shownTasks}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <TaskCard
                  task={item}
                  testID={`task-card-${item.id}`}
                  runStatus={effStatus ?? ''}
                  actionBusy={taskBusyKey}
                  onEdit={openTaskEdit}
                  onRegen={openTaskRegen}
                  onApprove={submitTaskApprove}
                  onUpload={openTaskUpload}
                  onReprompt={submitTaskReprompt}
                />
              )}
              contentContainerStyle={{
                gap: spacing[3],
                paddingHorizontal: spacing[4],
                paddingTop: spacing[4],
                paddingBottom: spacing[4],
              }}
              showsVerticalScrollIndicator={false}
              refreshControl={
                <RefreshControl
                  refreshing={detailQuery.isRefetching}
                  onRefresh={() => void detailQuery.refetch()}
                  tintColor={colors.accent}
                />
              }
              ListEmptyComponent={
                <View style={{ alignItems: 'center', marginTop: spacing[10] }}>
                  <Text
                    testID="agent-run-no-tasks"
                    style={{
                      color: colors.textSecondary,
                      fontSize: typography.body.fontSize,
                      lineHeight: typography.body.lineHeight,
                    }}
                  >
                    暂无任务卡片
                  </Text>
                </View>
              }
              testID="agent-run-task-list"
            />
          </>
        )}
      </View>

      {/* 底部 ticker 栏 */}
      <TickerBar
        items={ticker}
        connecting={sseConnecting}
        testID="agent-run-ticker"
      />

      {/* 取消确认 */}
      <ConfirmDialog
        visible={confirmCancel}
        title="取消运行"
        description="取消后不可恢复，确定要终止当前 Agent 团队运行吗？"
        confirmText="确认取消"
        cancelText="保留运行"
        danger
        loading={cancelMutation.isPending}
        onConfirm={() => cancelMutation.mutate()}
        onCancel={() => setConfirmCancel(false)}
        errorMessage={cancelError}
        testID="agent-run-cancel-dialog"
      />

      {/* 确认门裁决抽屉（M22；计划门/合成门共用，reject 展开批注输入；
          M23：计划门内容升级为可编辑面板，确认先 POST /plan 再 resume） */}
      <ActionSheet
        visible={gateOpen && !!gateKind}
        title={gateKind === 'plan' ? '计划确认' : '合成前确认'}
        onClose={() => setGateOpen(false)}
        busy={resumeMutation.isPending || planMutation.isPending}
        testID="agent-run-gate-sheet"
        footer={
          !gateRejecting ? (
            <>
              <Button
                title={gateKind === 'plan' ? '打回重规划' : '返回修改'}
                onPress={() => {
                  setGateRejecting(true);
                  setActionError(null);
                }}
                variant="secondary"
                size="sub"
                disabled={resumeMutation.isPending || planMutation.isPending}
                testID="gate-reject-toggle-btn"
                style={{ flex: 1 }}
              />
              <Button
                title={gateKind === 'plan' ? '确认执行' : '确认合成'}
                onPress={() =>
                  gateKind === 'plan' ? void submitPlanConfirm() : submitGate('approve')
                }
                size="sub"
                loading={resumeMutation.isPending || planMutation.isPending}
                disabled={gateKind === 'plan' && planVisibleCount === 0}
                testID="gate-approve-btn"
                style={{ flex: 1 }}
              />
            </>
          ) : (
            <>
              <Button
                title="返回"
                onPress={() => setGateRejecting(false)}
                variant="secondary"
                size="sub"
                disabled={resumeMutation.isPending || planMutation.isPending}
                testID="gate-reject-back-btn"
                style={{ flex: 1 }}
              />
              <Button
                title="确认打回"
                onPress={() => submitGate('reject')}
                variant="danger"
                size="sub"
                loading={resumeMutation.isPending || planMutation.isPending}
                testID="gate-reject-confirm-btn"
                style={{ flex: 1 }}
              />
            </>
          )
        }
      >
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {gateKind === 'plan'
            ? '可改标题/文案、删任务、加任务；确认后按计划执行：'
            : '全部任务已就绪，合成前请过一遍时间线：'}
        </Text>
        {gateKind === 'plan' ? (
          /* 计划门可编辑面板（M23）：改标题/主文案、删任务、加任务（本地草稿，确认时汇总提交） */
          <PlanGateEditor
            tasks={shownTasks}
            draft={planDraft}
            onPatchEdit={patchPlanEdit}
            onRemove={removePlanTask}
            onPatchAdded={patchPlanAdded}
            onDropAdded={dropPlanAdded}
            onAdd={addPlanTask}
            testID="gate-plan-editor"
          />
        ) : (
          <>
            {/* 时间线：序号 + 标题 + 状态徽章 + 时长（合成门） */}
            <View style={{ marginTop: spacing[3], gap: spacing[2] }}>
              {shownTasks.map((t, i) => {
                const m = taskStatusMeta(t.status);
                const dur = taskDurationSec(t);
                return (
                  <View
                    key={t.id}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}
                  >
                    <Text
                      style={{
                        width: 20,
                        color: colors.textSecondary,
                        fontSize: typography.caption.fontSize,
                        lineHeight: typography.caption.lineHeight,
                      }}
                    >
                      {i + 1}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        color: colors.text,
                        fontSize: typography.caption.fontSize,
                        lineHeight: typography.caption.lineHeight,
                      }}
                    >
                      {t.title || `任务 ${i + 1}`}
                    </Text>
                    <StatusBadge
                      label={m.label}
                      tone={m.tone}
                      spin={m.spin}
                      testID={`gate-task-${t.id}-status`}
                    />
                    {gateKind === 'assembly' ? (
                      <Text
                        style={{
                          minWidth: 36,
                          textAlign: 'right',
                          color: colors.textSecondary,
                          fontSize: typography.caption.fontSize,
                          lineHeight: typography.caption.lineHeight,
                        }}
                      >
                        {dur > 0 ? `${dur}s` : '—'}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
            {gateKind === 'assembly' ? (
              <Text
                testID="gate-total-duration"
                style={{
                  marginTop: spacing[3],
                  color: colors.text,
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                  fontWeight: '600',
                }}
              >
                合计时长 ≈ {gateTotalSec > 0 ? `${gateTotalSec}s` : '未知'}
              </Text>
            ) : null}
          </>
        )}
        {gateRejecting ? (
          <SheetTextArea
            value={gateFeedback}
            onChangeText={setGateFeedback}
            placeholder="打回原因（方向性批注，可选），例如「第 3 镜节奏太慢」"
            testID="gate-feedback-input"
          />
        ) : null}
        <SheetError message={actionError} testID="gate-sheet-error" />
      </ActionSheet>

      {/* 改文案抽屉（M22；主文案 key 由 primaryInputText 判定：prompt/text/script/description/content） */}
      <ActionSheet
        visible={!!editTask}
        title="改文案"
        onClose={() => setEditTask(null)}
        busy={taskMutation.isPending}
        testID="task-edit-sheet"
        footer={
          <>
            <Button
              title="取消"
              onPress={() => setEditTask(null)}
              variant="secondary"
              size="sub"
              disabled={taskMutation.isPending}
              testID="task-edit-cancel-btn"
              style={{ flex: 1 }}
            />
            <Button
              title="保存"
              onPress={submitTaskEdit}
              size="sub"
              loading={taskMutation.isPending}
              testID="task-edit-save-btn"
              style={{ flex: 1 }}
            />
          </>
        }
      >
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {editTask?.title || '修改该任务的提示词/文案'}
        </Text>
        <SheetTextArea
          value={editDraft}
          onChangeText={setEditDraft}
          placeholder="修改该任务的提示词/文案"
          testID="task-edit-input"
        />
        <SheetError message={actionError} testID="task-edit-error" />
      </ActionSheet>

      {/* 重生成抽屉（M22；引导词可选，拼进主文案尾部） */}
      <ActionSheet
        visible={!!regenTask}
        title="重生成"
        onClose={() => setRegenTask(null)}
        busy={taskMutation.isPending}
        testID="task-regen-sheet"
        footer={
          <>
            <Button
              title="取消"
              onPress={() => setRegenTask(null)}
              variant="secondary"
              size="sub"
              disabled={taskMutation.isPending}
              testID="task-regen-cancel-btn"
              style={{ flex: 1 }}
            />
            <Button
              title="带引导词重生成"
              onPress={submitTaskRegen}
              size="sub"
              loading={taskMutation.isPending}
              testID="task-regen-save-btn"
              style={{ flex: 1 }}
            />
          </>
        }
      >
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {regenTask?.title || '带引导词重生成'}
        </Text>
        <SheetTextArea
          value={regenGuidance}
          onChangeText={setRegenGuidance}
          placeholder="引导词（可选）：告诉 AI 这次往哪个方向改，例如「角色发色保持一致」"
          testID="task-regen-input"
        />
        <SheetError message={actionError} testID="task-regen-error" />
      </ActionSheet>
    </Screen>
  );
}
