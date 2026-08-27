/**
 * Agent 团队运行列表屏（M21.2，一期：只读监控）
 * - 状态过滤 chips（横滑）：全部 + RUN_STATUS_META 七态；后端 ?status= 精确匹配，
 *   进 queryKey 各桶独立缓存（对齐 assets 屏 kind 过滤模式）
 * - run 卡片：goal 摘要 + 状态徽章 + level 徽标 + 任务进度（done/total，error 数标红）+ 相对时间
 * - 列表即服务端状态：TanStack Query 托管；有非终态 run 时 3s 轮询，全终态自停（对齐 jobs 屏）
 * - 空态区分「暂无任务」与「该状态暂无任务」；点卡进 /agent-runs/[id] 详情
 */
import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/hooks/use-app-theme';
import { RUN_TERMINAL, runStatusMeta } from '@/lib/agent-run';
import { listAgentRuns } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import type { AgentRunSummary } from '@/types/api';

import { StatusBadge } from './status-badge';

/** 过滤 chips：'' = 全部；其余与后端 status 精确值一一对应（文案较徽章略简，横滑不挤） */
const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'planning', label: '规划中' },
  { key: 'awaiting_confirm', label: '待确认' },
  { key: 'running', label: '执行中' },
  { key: 'awaiting_assembly', label: '待合成' },
  { key: 'done', label: '已完成' },
  { key: 'error', label: '出错' },
  { key: 'canceled', label: '已取消' },
];

/** 活跃 run 判定：驱动轮询开关（独立导出便于测试） */
export function hasActiveRuns(runs: AgentRunSummary[] | undefined): boolean {
  return !!runs?.some((r) => !RUN_TERMINAL.has(r.status));
}

export const ACTIVE_RUNS_POLL_INTERVAL_MS = 3000;

function RunCard({
  run,
  onPress,
  testID,
}: {
  run: AgentRunSummary;
  onPress: (run: AgentRunSummary) => void;
  testID?: string;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const meta = runStatusMeta(run.status);
  const { total, done, error } = run.task_counts;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`运行：${run.goal}`}
      onPress={() => onPress(run)}
      testID={testID}
      style={({ pressed }) => ({
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing[3],
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text
        numberOfLines={2}
        style={{
          color: colors.text,
          fontSize: typography.body.fontSize,
          lineHeight: typography.body.lineHeight,
        }}
      >
        {run.goal}
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing[2],
          marginTop: spacing[2],
        }}
      >
        <StatusBadge
          label={meta.label}
          tone={meta.tone}
          spin={run.status === 'planning' || run.status === 'running'}
          testID={testID ? `${testID}-status` : undefined}
        />
        {/* level 徽标（L0/L1/L2 原样透传） */}
        <Text
          testID={testID ? `${testID}-level` : undefined}
          style={{
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize - 2,
            lineHeight: typography.caption.lineHeight,
            fontWeight: '700',
          }}
        >
          {run.level}
        </Text>
        <Text
          style={{
            flex: 1,
            textAlign: 'right',
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {formatRelativeTime(run.created_at)}
        </Text>
      </View>

      {/* 任务进度：done/total；有失败任务时红字透出 */}
      <Text
        testID={testID ? `${testID}-counts` : undefined}
        style={{
          marginTop: spacing[2],
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
        }}
      >
        任务 {done}/{total}
        {error > 0 ? (
          <Text style={{ color: colors.danger }}>　{error} 项失败</Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

export function AgentRunsScreen() {
  const { colors, radius, spacing, typography } = useAppTheme();
  const router = useRouter();
  const [filter, setFilter] = useState('');

  const runsQuery = useQuery({
    // status 进 key：后端精确匹配过滤，各桶独立缓存
    queryKey: ['agent-runs', 'list', filter],
    queryFn: () => listAgentRuns(filter),
    // 监控语义：有非终态 run 才轮询，全终态自动停
    refetchInterval: (query) =>
      hasActiveRuns(query.state.data) ? ACTIVE_RUNS_POLL_INTERVAL_MS : false,
  });
  const runs = runsQuery.data ?? [];
  const showEmpty = !runsQuery.isPending && runs.length === 0;

  const openRun = (run: AgentRunSummary) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/agent-runs/[id]', params: { id: run.id } });
  };

  return (
    <Screen testID="screen-agent-runs">
      <View style={{ flex: 1, paddingHorizontal: spacing[4] }}>
        {/* 头部：返回 + 标题（右占位保视觉对称） */}
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
            testID="agent-runs-back"
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
            Agent 团队
          </Text>
          <View style={{ minWidth: 48 }} />
        </View>

        {/* 状态过滤 chips（横滑，后端精确匹配单值） */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginTop: spacing[2], marginBottom: spacing[3] }}
          contentContainerStyle={{ gap: spacing[2] }}
          testID="agent-run-filters"
        >
          {STATUS_FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <Pressable
                key={f.key || 'all'}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={f.label}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setFilter(f.key);
                }}
                testID={`agent-run-filter-${f.key || 'all'}`}
                style={{
                  minHeight: 36,
                  paddingHorizontal: spacing[3],
                  borderRadius: radius.full,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accentSoft : colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    color: active ? colors.accent : colors.textSecondary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                    fontWeight: active ? '600' : '400',
                  }}
                >
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {runsQuery.isPending ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.accent} testID="agent-runs-loading" />
          </View>
        ) : showEmpty ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              icon="Bot"
              title={filter === '' ? '暂无 Agent 团队任务' : '该状态暂无任务'}
              description="在 Web 端发起一句话目标后，执行进度会实时出现在这里"
              testID="empty-agent-runs"
            />
          </View>
        ) : (
          <FlatList
            data={runs}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <RunCard run={item} onPress={openRun} testID={`run-card-${item.id}`} />
            )}
            contentContainerStyle={{ gap: spacing[3], paddingBottom: spacing[4] }}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={runsQuery.isRefetching}
                onRefresh={() => void runsQuery.refetch()}
                tintColor={colors.accent}
              />
            }
            testID="agent-runs-list"
          />
        )}
      </View>
    </Screen>
  );
}
