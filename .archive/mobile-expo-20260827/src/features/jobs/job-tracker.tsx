/**
 * 作业详情追踪（M5.6）：单点终态接管
 * - 从共享 ['jobs'] 查询缓存 select 最新状态，无需独立轮询
 * - queued/running：状态舞台 + 不确定进度指示
 * - done：产物预览 + 入口跳转完整 ArtifactDetail
 * - error：错误语义 + 提示回列表重试
 * - M29 会话内 SSE 增强：本次会话提交的作业（job-sse-registry 有凭据）挂
 *   streamJobEvents，确定性进度条（value/max 百分比）/质量提示/错误人话就地呈现；
 *   done/error → 失效 ['jobs'] 查询（列表与作品库同根）+ 触觉反馈 + 凭据清除；
 *   未登记/401/403/断流超限均静默回退既有 2s 轮询，行为不回退
 * - 生命周期：组件卸载 / App 退后台 → AbortSignal 断流（对齐 agent-run-detail 清理写法）
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { mediaUrl } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { streamJobEvents } from '@/lib/job-events';
import type { JobProgress, JobQualityWarning } from '@/lib/job-events';
import type { JobItem, JobStatus } from '@/types/api';

import { kindToFilter } from '../library/library-utils';
import { JOB_STATUS_META } from './job-card';
import { clearJobSseCreds, getJobSseCreds } from './job-sse-registry';

/** 非图像类的预览占位图标（与作品库卡片同一映射） */
const GROUP_ICON: Record<string, IconName> = {
  video: 'Film',
  audio: 'Music',
  '3d': 'Box',
};

export interface JobTrackerProps {
  jobId: string | null;
  onClose: () => void;
  /** done 态请求打开完整详情（作品级操作：复用/下载/删除） */
  onRequestDetail?: (job: JobItem) => void;
  testID?: string;
}

export function JobTracker({ jobId, onClose, onRequestDetail, testID }: JobTrackerProps) {
  const { colors, spacing, typography, radius } = useAppTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const jobsQuery = useQuery<JobItem[]>({ queryKey: ['jobs'], enabled: false });
  const job = useMemo(
    () => jobsQuery.data?.find((j) => j.id === jobId) ?? null,
    [jobsQuery.data, jobId],
  );

  // ── M29 会话内 SSE 覆盖态（轮询缓存仍是事实源，SSE 仅增强呈现）──
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [warning, setWarning] = useState<JobQualityWarning | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  // 换追踪目标即清覆盖态（render 期间调整状态，对齐 agent-run-detail 保活模式）
  const [trackedId, setTrackedId] = useState(jobId);
  if (jobId !== trackedId) {
    setTrackedId(jobId);
    setProgress(null);
    setWarning(null);
    setStreamError(null);
  }

  const promptId = job?.prompt_id ?? null;
  const polledStatus = job?.status ?? null;
  useEffect(() => {
    if (!promptId || !polledStatus) return;
    const creds = getJobSseCreds(promptId);
    if (!creds) return; // 非本次会话提交：仅既有轮询
    if (polledStatus === 'done' || polledStatus === 'error') {
      clearJobSseCreds(promptId); // 轮询先到终态：登记清除，无需建流
      return;
    }
    const ctrl = new AbortController();
    let disposed = false;
    // 退后台即断流（省电/连接）；回前台由既有轮询兜底，重开追踪重建
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') ctrl.abort();
    });
    void streamJobEvents(
      { promptId, clientId: creds.clientId, worker: creds.worker },
      {
        onProgress: (p) => {
          if (!disposed) setProgress(p);
        },
        onQualityWarning: (w) => {
          if (!disposed) setWarning(w);
        },
        onDone: () => {
          clearJobSseCreds(promptId);
          if (disposed) return;
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          // 列表/作品库查询同根 ['jobs']，一次失效全覆盖 → 轮询立即回捞终态
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
        },
        onError: (message) => {
          clearJobSseCreds(promptId);
          if (disposed) return;
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          setStreamError(message);
          void queryClient.invalidateQueries({ queryKey: ['jobs'] });
        },
        onAuthError: () => clearJobSseCreds(promptId), // 凭据失效静默回退轮询
      },
      { signal: ctrl.signal },
    ).catch(() => {
      /* fallback/auth/aborted 均无需动作（轮询兜底） */
    });
    return () => {
      disposed = true;
      sub.remove();
      ctrl.abort();
    };
  }, [promptId, polledStatus, queryClient]);

  if (!jobId || !job) return null;

  // SSE 业务 error 优先于轮询状态呈现失败舞台（轮询数秒内追平）
  const effStatus: JobStatus = streamError ? 'error' : job.status;
  const meta = JOB_STATUS_META[effStatus];
  const toneColor =
    meta.tone === 'accent'
      ? colors.accent
      : meta.tone === 'success'
        ? colors.success
        : meta.tone === 'danger'
          ? colors.danger
          : colors.textSecondary;

  const isDone = effStatus === 'done';
  const isError = effStatus === 'error';
  // 裁切链窗口期:done 但 trim/extend 后台裁切中,results 是未裁原片 → 转「精确裁切中」态
  // (轮询保持活跃见 jobs-screen hasActiveJobs;post_status 清零后自动回落预览)
  const isPostProcessing = isDone && job.post_status === 'processing';
  const hasResults = isDone && !isPostProcessing && job.results.length > 0;
  // 图像类才有位图预览；视频/音频/3D 用类型图标占位（完整播放入 ArtifactDetail）
  const group = kindToFilter(job.kind);
  const showBitmap = hasResults && (group === 'image' || group === null);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} testID={testID}>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* 顶部栏 */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: insets.top + spacing[2],
            paddingHorizontal: spacing[4],
            paddingBottom: spacing[2],
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            hitSlop={8}
            testID={testID ? `${testID}-close` : undefined}
            style={{
              width: 48,
              height: 48,
              borderRadius: radius.full,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="X" size={24} color={colors.text} />
          </Pressable>

          <Text
            style={{
              color: colors.text,
              fontSize: typography.heading.fontSize,
              lineHeight: typography.heading.lineHeight,
              fontWeight: '600',
            }}
          >
            作业详情
          </Text>

          <View style={{ width: 48 }} />
        </View>

        {/* 状态舞台 */}
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: spacing[6],
          }}
        >
          {showBitmap ? (
            <View style={{ alignItems: 'center' }}>
              <Image
                source={{ uri: mediaUrl(job.results[0]) }}
                style={{ width: 280, height: 280, borderRadius: radius.lg }}
                contentFit="cover"
                transition={200}
                testID={testID ? `${testID}-preview` : undefined}
              />
            </View>
          ) : hasResults ? (
            <View style={{ alignItems: 'center' }}>
              <Icon
                name={GROUP_ICON[group ?? ''] ?? 'Image'}
                size={64}
                color={colors.textSecondary}
                testID={testID ? `${testID}-preview-icon` : undefined}
              />
              <Text
                style={{
                  marginTop: spacing[3],
                  color: colors.textSecondary,
                  fontSize: typography.body.fontSize,
                  lineHeight: typography.body.lineHeight,
                }}
              >
                已完成，点下方按钮查看与播放
              </Text>
            </View>
          ) : isPostProcessing ? (
            <View style={{ alignItems: 'center' }}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text
                testID={testID ? `${testID}-post-processing` : undefined}
                style={{
                  marginTop: spacing[4],
                  color: colors.accent,
                  fontSize: typography.title.fontSize,
                  lineHeight: typography.title.lineHeight,
                  fontWeight: '700',
                }}
              >
                精确裁切中…
              </Text>
              <Text
                style={{
                  marginTop: spacing[2],
                  color: colors.textSecondary,
                  fontSize: typography.body.fontSize,
                  lineHeight: typography.body.lineHeight,
                  textAlign: 'center',
                }}
              >
                时长后处理进行中，完成后自动替换为终产物
              </Text>
            </View>
          ) : (
            <View style={{ alignItems: 'center' }}>
              {effStatus === 'running' && progress ? (
                <>
                  {/* M29 确定性进度：SSE value/max 百分比 */}
                  <Text
                    testID={testID ? `${testID}-progress-pct` : undefined}
                    style={{
                      color: colors.accent,
                      fontSize: typography.display.fontSize,
                      lineHeight: typography.display.lineHeight,
                      fontWeight: '700',
                    }}
                  >
                    {progress.pct}%
                  </Text>
                  <View
                    testID={testID ? `${testID}-progress-bar` : undefined}
                    style={{
                      marginTop: spacing[3],
                      width: 220,
                      height: 6,
                      borderRadius: radius.full,
                      backgroundColor: colors.accentSoft,
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      style={{
                        width: `${progress.pct}%`,
                        height: 6,
                        borderRadius: radius.full,
                        backgroundColor: colors.accent,
                      }}
                    />
                  </View>
                </>
              ) : effStatus === 'running' ? (
                <ActivityIndicator size="large" color={colors.accent} />
              ) : (
                <Icon name={meta.icon} size={64} color={toneColor} />
              )}
              <Text
                style={{
                  marginTop: spacing[4],
                  color: toneColor,
                  fontSize: typography.title.fontSize,
                  lineHeight: typography.title.lineHeight,
                  fontWeight: '700',
                }}
              >
                {meta.label}
              </Text>
              {isError ? (
                <Text
                  style={{
                    marginTop: spacing[2],
                    color: colors.textSecondary,
                    fontSize: typography.body.fontSize,
                    lineHeight: typography.body.lineHeight,
                    textAlign: 'center',
                  }}
                >
                  {streamError ?? '生成过程中发生错误，可返回列表重试'}
                </Text>
              ) : null}
              {warning && !isDone && !isError ? (
                <Text
                  testID={testID ? `${testID}-quality-warning` : undefined}
                  style={{
                    marginTop: spacing[3],
                    color: colors.warning,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                    textAlign: 'center',
                  }}
                >
                  质量提示：{warning.issues[0] ?? '产物质量可能未达预期'}
                </Text>
              ) : null}
            </View>
          )}
        </View>

        {/* 底部：参数 + 操作 */}
        <View
          style={{
            paddingHorizontal: spacing[4],
            paddingBottom: insets.bottom + spacing[4],
          }}
        >
          <Text
            style={{
              color: colors.text,
              fontSize: typography.mono.fontSize,
              lineHeight: typography.mono.lineHeight,
            }}
            numberOfLines={3}
          >
            {job.prompt}
          </Text>
          <Text
            style={{
              marginTop: spacing[1],
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            seed {job.seed} · {formatRelativeTime(job.created_at)}
          </Text>

          {isDone && !isPostProcessing && onRequestDetail ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onRequestDetail(job)}
              testID={testID ? `${testID}-detail` : undefined}
              style={({ pressed }) => ({
                marginTop: spacing[4],
                height: 48,
                borderRadius: radius.md,
                backgroundColor: colors.accent,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text
                style={{
                  color: colors.bg,
                  fontSize: typography.body.fontSize,
                  lineHeight: typography.body.lineHeight,
                  fontWeight: '600',
                }}
              >
                查看详情
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
