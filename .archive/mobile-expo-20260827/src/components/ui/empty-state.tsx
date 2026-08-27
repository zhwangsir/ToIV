import { Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { useAppTheme } from '@/hooks/use-app-theme';
import type { IconName } from '@/components/ui/Icon';
import { Icon } from '@/components/ui/Icon';

/**
 * 空状态（指南 4.2 Empty + 5.4）
 * 结构：径向微光晕锚点 + display 大标题 + 一句话说明 + 一个主动作按钮
 * 视觉对称：全部元素主轴居中
 */
export interface EmptyStateProps {
  icon: IconName;
  title: string;
  description?: string;
  actionTitle?: string;
  onAction?: () => void;
  testID?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  actionTitle,
  onAction,
  testID,
}: EmptyStateProps) {
  const { colors, spacing, typography } = useAppTheme();

  return (
    <View
      testID={testID}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing[8],
        paddingVertical: spacing[12],
      }}
    >
      {/* 微光晕：双层 accentSoft 同心圆近似径向渐变（克制、无高饱和） */}
      <View
        style={{
          width: 120,
          height: 120,
          borderRadius: 60,
          backgroundColor: colors.accentSoft,
          opacity: 0.55,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            backgroundColor: colors.accentSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size={24} color={colors.accent} />
        </View>
      </View>

      <Text
        style={{
          marginTop: spacing[6],
          color: colors.text,
          fontSize: typography.display.fontSize,
          lineHeight: typography.display.lineHeight,
          fontWeight: '600',
          textAlign: 'center',
        }}
      >
        {title}
      </Text>

      {description ? (
        <Text
          style={{
            marginTop: spacing[2],
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
            textAlign: 'center',
          }}
        >
          {description}
        </Text>
      ) : null}

      {actionTitle && onAction ? (
        <Button
          title={actionTitle}
          onPress={onAction}
          fullWidth={false}
          style={{ marginTop: spacing[6], paddingHorizontal: spacing[8] }}
          testID={testID ? `${testID}-action` : undefined}
        />
      ) : null}
    </View>
  );
}
