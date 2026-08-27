import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';

/**
 * 表单输入框（登录/注册等受控表单）
 * - 左侧图标 + 可选右侧附件（如密码可见性切换）
 * - 错误三通道：danger 边框 + CircleAlert 图标 + 错误文字（指南第八章）
 * - 热区 ≥48
 */
export interface InputProps extends Omit<TextInputProps, 'style'> {
  label: string;
  icon: IconName;
  error?: string;
  rightAccessory?: { icon: IconName; onPress: () => void; accessibilityLabel: string };
  testID?: string;
}

export function Input({ label, icon, error, rightAccessory, testID, ...rest }: InputProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const [focused, setFocused] = useState(false);

  const borderColor = error ? colors.danger : focused ? colors.accent : colors.border;

  return (
    <View style={{ alignSelf: 'stretch' }}>
      <Text
        style={{
          color: colors.textSecondary,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
          marginBottom: spacing[1],
        }}
      >
        {label}
      </Text>
      <View
        style={{
          minHeight: 48,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor,
          backgroundColor: colors.surface,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: spacing[3],
        }}
      >
        <Icon name={icon} size={20} color={colors.textSecondary} />
        <TextInput
          placeholderTextColor={colors.textSecondary}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          testID={testID}
          style={{
            flex: 1,
            marginLeft: spacing[2],
            color: colors.text,
            fontSize: typography.body.fontSize,
            paddingVertical: 0,
          }}
          {...rest}
        />
        {rightAccessory ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={rightAccessory.accessibilityLabel}
            onPress={rightAccessory.onPress}
            hitSlop={8}
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
            testID={testID ? `${testID}-accessory` : undefined}
          >
            <Icon name={rightAccessory.icon} size={20} color={colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: spacing[1],
          }}
        >
          <Icon name="CircleAlert" size={20} color={colors.danger} />
          <Text
            style={{
              marginLeft: spacing[1],
              color: colors.danger,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
