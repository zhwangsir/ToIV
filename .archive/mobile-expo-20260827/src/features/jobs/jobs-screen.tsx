import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';

import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { ArtifactDetail } from '@/features/library/artifact-detail';
import { useAppTheme } from '@/hooks/use-app-theme';
import { listJobs, submitTxt2Img } from '@/lib/api';
import type { JobItem } from '@/types/api';

import { JobCard } from './job-card';
import { registerJobSseCreds } from './job-sse-registry';
import { JobTracker } from './job-tracker';

/**
 * 作业屏（M4）：卡片流 + 轮询进度回填
 * - 列表即服务端状态：TanStack Query 托管，有活跃作业（queued/running）时 2s 轮询，终态即停
 * - 失败卡片可同 prompt 重试（重提交 txt2img）；下拉强制刷新
 * - 后端 Job 无进度百分比字段，running 态用不确定指示（指南允许的进度表达）
 */

/** 活跃作业判定：驱动轮询开关（独立导出便于测试）
 *  裁切链进行中(done 但 post_status=processing)同样视为活跃:
 *  停轮询会导致「精确裁切中」永远等不到终产物回写 */
export function hasActiveJobs(jobs: JobItem[] | undefined): boolean {
  return !!jobs?.some(
    (j) => j.status === 'queued' || j.status === 'running' || j.post_status === 'processing',
  );
}

export const ACTIVE_POLL_INTERVAL_MS = 2000;

export function JobsScreen() {
  const { colors, spacing, typography } = useAppTheme();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  /** 单点追踪中的作业 id（非 done 态打开） */
  const [trackingId, setTrackingId] = useState<string | null>(null);
  /** 产物详情中的作业（done 态直接打开，或追踪终态接管） */
  const [detailJob, setDetailJob] = useState<JobItem | null>(null);

  const jobsQuery = useQuery({
    queryKey: ['jobs'],
    queryFn: () => listJobs({ limit: 50 }),
    // 轮询进度回填：有排队/运行中作业才轮询，全部终态后自动停止
    refetchInterval: (query) => (hasActiveJobs(query.state.data) ? ACTIVE_POLL_INTERVAL_MS : false),
  });

  const retryMutation = useMutation({
    mutationFn: (prompt: string) => submitTxt2Img({ positive: prompt }),
    onSuccess: (res) => {
      // M29：重试重提交同样登记会话内 SSE 凭据（新作业可被追踪屏 SSE 增强）
      registerJobSseCreds(res);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    },
    onSettled: () => setRetryingId(null),
  });

  const retry = (job: JobItem) => {
    if (retryMutation.isPending) return;
    setRetryingId(job.id);
    retryMutation.mutate(job.prompt);
  };

  const jobs = jobsQuery.data ?? [];
  const showEmpty = !jobsQuery.isPending && jobs.length === 0;

  /** 点按卡片：done 直接看详情；其余进追踪（终态后接管到详情） */
  const openJob = (job: JobItem) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (job.status === 'done') {
      setDetailJob(job);
    } else {
      setTrackingId(job.id);
    }
  };

  return (
    <Screen testID="screen-jobs">
      <View style={{ flex: 1, paddingHorizontal: spacing[4] }}>
        <View
          style={{
            marginTop: spacing[4],
            marginBottom: spacing[3],
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text
            style={{
              color: colors.text,
              fontSize: typography.title.fontSize,
              lineHeight: typography.title.lineHeight,
              fontWeight: '700',
              letterSpacing: typography.title.letterSpacing,
            }}
          >
            作业
          </Text>
          {/* Agent 团队监控入口（M21，栈页，不占 tab 位） */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Agent 团队"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/agent-runs');
            }}
            hitSlop={8}
            testID="open-agent-runs"
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="Bot" size={24} color={colors.text} />
          </Pressable>
        </View>

        {showEmpty ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              icon="ListVideo"
              title="暂无进行中的作业"
              description="提交一次生成后，进度会实时出现在这里"
              testID="empty-jobs"
            />
          </View>
        ) : (
          <FlatList
            data={jobs}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <JobCard
                job={item}
                onRetry={retry}
                onPress={openJob}
                retrying={retryingId === item.id}
                testID={`job-card-${item.id}`}
              />
            )}
            contentContainerStyle={{ gap: spacing[3], paddingBottom: spacing[4] }}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={jobsQuery.isRefetching}
                onRefresh={() => void jobsQuery.refetch()}
                tintColor={colors.accent}
              />
            }
            testID="jobs-list"
          />
        )}
      </View>

      {/* 单点终态追踪（非 done 态）；done 后「查看详情」接管到产物详情 */}
      <JobTracker
        jobId={trackingId}
        onClose={() => setTrackingId(null)}
        onRequestDetail={(job) => {
          setTrackingId(null);
          setDetailJob(job);
        }}
        testID="job-tracker"
      />

      {/* 产物详情（复用作品库组件） */}
      <ArtifactDetail
        job={detailJob}
        onClose={() => setDetailJob(null)}
        onDeleted={() => setDetailJob(null)}
        onSelectVersion={setDetailJob}
        testID="job-artifact-detail"
      />
    </Screen>
  );
}
