import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import type { SeedMode } from '@/types/api';

/**
 * 重新生成确认抽屉（M7.3，指南 4.2 底部抽屉 / 5.3 异步 UX）
 * - seed 策略二选一：保持种子（复现微调）/ 随机种子（重新抽卡），默认保持
 * - 纯受控组件：提交态与人话错误由父级（ArtifactDetail 的 mutation）注入
 * - explicit（指定 seed）留给后续里程碑：移动端先覆盖 Web 最高频两档
 */

export type RerunSeedMode = Extract<SeedMode, 'keep' | 'random'>;

const SEED_OPTIONS: readonly { key: RerunSeedMode; label: string; hint: string }[] = [
  { key: 'keep', label: '保持种子', hint: '同一 seed 复现画面，适合微调提示词' },
  { key: 'random', label: '随机种子', hint: '换 seed 重新抽卡，同提示词出新图' },
];

export interface RerunSheetProps {
  visible: boolean;
  submitting: boolean;
  /** 提交失败人话（ApiError.message），展示在确认按钮上方 */
  error?: string | null;
  onConfirm: (mode: RerunSeedMode) => void;
  onClose: () => void;
  testID?: string;
}

export function RerunSheet({
  visible,
  submitting,
  error,
  onConfirm,
  onClose,
  testID = 'rerun-sheet',
}: RerunSheetProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<RerunSeedMode>('keep');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="关闭重新生成"
        onPress={onClose}
        testID={`${testID}-backdrop`}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.32)' }}
      />
      <View
        testID={testID}
        style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          paddingHorizontal: spacing[4],
          paddingBottom: Math.max(insets.bottom, spacing[4]),
          borderTopWidth: 1,
          borderColor: colors.border,
        }}
      >
        {/* 拖拽柄 36×4 居中 */}
        <View
          style={{
            alignSelf: 'center',
            width: 36,
            height: 4,
            borderRadius: radius.full,
            backgroundColor: colors.border,
            marginTop: spacing[2],
            marginBottom: spacing[3],
          }}
        />

        <Text
          style={{
            color: colors.text,
            fontSize: typography.heading.fontSize,
            lineHeight: typography.heading.lineHeight,
            fontWeight: '600',
          }}
        >
          重新生成
        </Text>
        <Text
          style={{
            marginTop: spacing[1],
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          以该作品的参数快照精确重生，新作业自动挂入版本链
        </Text>

        {/* seed 策略 */}
        <View style={{ marginTop: spacing[4], gap: spacing[2] }}>
          {SEED_OPTIONS.map((opt) => {
            const active = opt.key === mode;
            return (
              <Pressable
                key={opt.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setMode(opt.key)}
                testID={`${testID}-seed-${opt.key}`}
                style={{
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accentSoft : colors.bg,
                  paddingHorizontal: spacing[3],
                  paddingVertical: spacing[3],
                }}
              >
                <Text
                  style={{
                    color: active ? colors.accent : colors.text,
                    fontSize: typography.body.fontSize,
                    lineHeight: typography.body.lineHeight,
                    fontWeight: active ? '600' : '400',
                  }}
                >
                  {opt.label}
                </Text>
                <Text
                  style={{
                    marginTop: spacing[1] / 2,
                    color: colors.textSecondary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                  }}
                >
                  {opt.hint}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {error ? (
          <Text
            testID={`${testID}-error`}
            style={{
              marginTop: spacing[3],
              color: colors.danger,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {error}
          </Text>
        ) : null}

        {/* 确认（主按钮，提交态禁用） */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: submitting }}
          disabled={submitting}
          onPress={() => onConfirm(mode)}
          testID={`${testID}-confirm`}
          style={({ pressed }) => ({
            marginTop: spacing[4],
            height: 48,
            borderRadius: radius.md,
            backgroundColor: colors.accent,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: submitting ? 0.5 : pressed ? 0.85 : 1,
          })}
        >
          {submitting ? (
            <ActivityIndicator color={colors.bg} testID={`${testID}-loading`} />
          ) : (
            <>
              <Icon name="RefreshCw" size={20} color={colors.bg} />
              <Text
                style={{
                  marginLeft: spacing[2],
                  color: colors.bg,
                  fontSize: typography.body.fontSize,
                  lineHeight: typography.body.lineHeight,
                  fontWeight: '600',
                }}
              >
                开始生成
              </Text>
            </>
          )}
        </Pressable>
      </View>
    </Modal>
  );
}
