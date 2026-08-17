/**
 * 状态徽章（M21，列表/详情两屏共用）
 * - tone 五值词表来自 lib/agent-run（对齐 Web agentRunMeta）→ tokens 语义色唯一映射点
 * - 描边胶囊：五 tone 全 token 合规（无 successSoft/warningSoft 角色，故不用实心填充）
 * - spin 进行态（task running）转圈，对齐 job-card 的不确定进度表达
 */
import { ActivityIndicator, Text, View } from 'react-native';

import { useAppTheme } from '@/hooks/use-app-theme';
import type { StatusTone } from '@/lib/agent-run';
import type { Palette } from '@/theme/tokens';

export function toneColor(tone: StatusTone, colors: Palette): string {
  switch (tone) {
    case 'accent':
      return colors.accent;
    case 'ok':
      return colors.success;
    case 'warn':
      return colors.warning;
    case 'err':
      return colors.danger;
    default:
      return colors.textSecondary;
  }
}

export function StatusBadge({
  label,
  tone,
  spin = false,
  testID,
}: {
  label: string;
  tone: StatusTone;
  /** 进行态（徽章转圈） */
  spin?: boolean;
  testID?: string;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const fg = toneColor(tone, colors);

  return (
    <View
      testID={testID}
      accessibilityLabel={`状态：${label}`}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: spacing[1],
        paddingHorizontal: spacing[2],
        minHeight: 24,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: tone === 'neutral' ? colors.border : fg,
      }}
    >
      {spin ? <ActivityIndicator size={12} color={fg} /> : null}
      <Text
        style={{
          color: fg,
          fontSize: typography.caption.fontSize - 2,
          lineHeight: typography.caption.lineHeight,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </View>
  );
}
