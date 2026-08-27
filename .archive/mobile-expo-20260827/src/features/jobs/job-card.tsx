import { Image } from 'expo-image';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { mediaUrl } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import type { JobItem, JobStatus } from '@/types/api';

/**
 * 作业卡片（指南 4.2 JobCard）
 * 缩略占位 → 进度指示 → 完成渐显；失败态含「重试」动作
 * 布局：左 72×72 缩略 + 右（prompt 摘要 + 状态徽章/时间），视觉对称、内容至上
 */

export interface JobStatusMeta {
  label: string;
  icon: IconName;
  /** 语义角色：映射 tokens 颜色 */
  tone: 'accent' | 'success' | 'danger' | 'muted';
}

export const JOB_STATUS_META: Record<JobStatus, JobStatusMeta> = {
  queued: { label: '排队中', icon: 'Clock', tone: 'muted' },
  running: { label: '生成中', icon: 'LoaderCircle', tone: 'accent' },
  done: { label: '已完成', icon: 'CircleCheck', tone: 'success' },
  error: { label: '失败', icon: 'CircleAlert', tone: 'danger' },
};

export { formatRelativeTime };

export interface JobCardProps {
  job: JobItem;
  /** 失败态重试（同 prompt 重提交）；不传则不渲染动作区 */
  onRetry?: (job: JobItem) => void;
  /** 点按卡片 → 打开作业详情（单点终态追踪） */
  onPress?: (job: JobItem) => void;
  retrying?: boolean;
  testID?: string;
}

export function JobCard({ job, onRetry, onPress, retrying = false, testID }: JobCardProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const meta = JOB_STATUS_META[job.status];
  const thumb = job.status === 'done' && job.results.length > 0 ? mediaUrl(job.results[0]) : null;

  const toneColor =
    meta.tone === 'accent'
      ? colors.accent
      : meta.tone === 'success'
        ? colors.success
        : meta.tone === 'danger'
          ? colors.danger
          : colors.textSecondary;

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress ? () => onPress(job) : undefined}
      disabled={!onPress}
      testID={testID}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing[3],
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {/* 缩略：done 渐显产物；其余态占位 + 状态图标 */}
      <View
        testID={testID ? `${testID}-thumb` : undefined}
        style={{
          width: 72,
          height: 72,
          borderRadius: radius.md,
          backgroundColor: colors.bg,
          borderWidth: 1,
          borderColor: colors.border,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {thumb ? (
          <Image
            source={{ uri: thumb }}
            style={{ width: 72, height: 72 }}
            contentFit="cover"
            transition={200}
            recyclingKey={job.id}
            testID={testID ? `${testID}-image` : undefined}
          />
        ) : (
          <Icon name={meta.icon} size={24} color={toneColor} />
        )}
      </View>

      <View style={{ flex: 1, marginLeft: spacing[3] }}>
        <Text
          numberOfLines={2}
          style={{
            color: colors.text,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
          }}
        >
          {job.prompt}
        </Text>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: spacing[2],
          }}
        >
          {/* 状态徽章（读屏可读的文本语义） */}
          <View
            testID={testID ? `${testID}-status` : undefined}
            accessibilityLabel={`状态：${meta.label}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: spacing[2],
              minHeight: 24,
              borderRadius: radius.full,
              backgroundColor: meta.tone === 'muted' ? colors.bg : colors.accentSoft,
            }}
          >
            {job.status === 'running' ? (
              <ActivityIndicator size={12} color={colors.accent} />
            ) : (
              <Icon name={meta.icon} size={12} color={toneColor} />
            )}
            <Text
              style={{
                marginLeft: spacing[1],
                color: toneColor,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
                fontWeight: '500',
              }}
            >
              {meta.label}
            </Text>
          </View>

          <Text
            style={{
              marginLeft: spacing[2],
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {formatRelativeTime(job.created_at)}
          </Text>

          {job.status === 'done' && job.results.length > 1 ? (
            <Text
              testID={testID ? `${testID}-count` : undefined}
              style={{
                marginLeft: spacing[2],
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              ×{job.results.length}
            </Text>
          ) : null}
        </View>
      </View>

      {/* 失败态：重试（指南 4.2 失败含恢复动作） */}
      {job.status === 'error' && onRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重试"
          accessibilityState={{ busy: retrying }}
          disabled={retrying}
          onPress={() => onRetry(job)}
          hitSlop={8}
          testID={testID ? `${testID}-retry` : undefined}
          style={{
            marginLeft: spacing[2],
            minWidth: 48,
            minHeight: 48,
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.bg,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: retrying ? 0.5 : 1,
          }}
        >
          <Icon name="RotateCcw" size={20} color={colors.accent} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}
