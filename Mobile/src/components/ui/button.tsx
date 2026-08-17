import { ActivityIndicator, Pressable, Text } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { useAppTheme } from '@/hooks/use-app-theme';

/**
 * 按钮（指南 4.2）
 * - 三变体：primary=accent 实心 / secondary=描边 / danger=危险
 * - 两档高：main=48（主操作）/ sub=40（次操作）
 * - 四态齐备：default / pressed（透明度反馈 ≤120ms）/ disabled / loading（转圈禁重复提交）
 */
export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'main' | 'sub';
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'main',
  loading = false,
  disabled = false,
  fullWidth = true,
  accessibilityLabel,
  testID,
  style,
}: ButtonProps) {
  const { colors, radius, typography } = useAppTheme();
  const blocked = disabled || loading;

  const backgroundColor =
    variant === 'primary' ? colors.accent : variant === 'danger' ? colors.danger : 'transparent';
  const textColor =
    variant === 'secondary' ? colors.text : colors.bg;
  const borderColor = variant === 'secondary' ? colors.border : 'transparent';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: blocked, busy: loading }}
      disabled={blocked}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        {
          height: size === 'main' ? 48 : 40,
          minWidth: 48,
          borderRadius: radius.md,
          backgroundColor,
          borderColor,
          borderWidth: variant === 'secondary' ? 1 : 0,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 20,
          opacity: blocked ? 0.5 : pressed ? 0.85 : 1,
        },
        fullWidth ? { alignSelf: 'stretch' } : { alignSelf: 'center' },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} testID={testID ? `${testID}-loading` : undefined} />
      ) : (
        <Text
          style={{
            color: textColor,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
            fontWeight: '600',
          }}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}
