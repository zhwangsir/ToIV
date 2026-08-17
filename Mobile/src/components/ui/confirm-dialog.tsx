/**
 * 确认对话框（指南 4.2 Dialog）
 * - 标题 + 简述 + 双按钮；危险确认主按钮在左（防误触习惯位）
 * - Modal 透明遮罩 + 居中卡片；loading 态禁重复确认
 */
import { Modal, Pressable, Text, View } from 'react-native';

import { useAppTheme } from '@/hooks/use-app-theme';
import { Button } from './button';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  description?: string;
  /** 确认按钮文案（如「删除」） */
  confirmText: string;
  cancelText?: string;
  /** danger 时确认按钮用危险色 */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 内联错误信息（确认失败后展示，不关闭对话框） */
  errorMessage?: string | null;
  testID?: string;
}

export function ConfirmDialog({
  visible,
  title,
  description,
  confirmText,
  cancelText = '取消',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
  errorMessage,
  testID,
}: ConfirmDialogProps) {
  const { colors, spacing, typography, radius } = useAppTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={loading ? undefined : onCancel}
      statusBarTranslucent
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭对话框"
        onPress={loading ? undefined : onCancel}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.4)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing[6],
        }}
        testID={testID ? `${testID}-backdrop` : undefined}
      >
        {/* 阻止冒泡：点卡片不关闭 */}
        <Pressable
          onPress={() => {}}
          testID={testID}
          style={{
            alignSelf: 'stretch',
            backgroundColor: colors.surface,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.border,
            padding: spacing[5],
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
          {description ? (
            <Text
              style={{
                marginTop: spacing[2],
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {description}
            </Text>
          ) : null}

          {errorMessage ? (
            <Text
              testID={testID ? `${testID}-error` : undefined}
              style={{
                marginTop: spacing[3],
                color: colors.danger,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {errorMessage}
            </Text>
          ) : null}

          <View
            style={{
              flexDirection: 'row',
              gap: spacing[3],
              marginTop: spacing[5],
            }}
          >
            {/* 危险确认主按钮在左（指南 4.2 Dialog：防误触习惯位） */}
            <Button
              title={confirmText}
              onPress={onConfirm}
              variant={danger ? 'danger' : 'primary'}
              size="sub"
              loading={loading}
              testID={testID ? `${testID}-confirm` : undefined}
              style={{ flex: 1 }}
            />
            <Button
              title={cancelText}
              onPress={onCancel}
              variant="secondary"
              size="sub"
              disabled={loading}
              testID={testID ? `${testID}-cancel` : undefined}
              style={{ flex: 1 }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
