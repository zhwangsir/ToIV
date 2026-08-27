import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';

/**
 * PromptBar（指南 4.2）
 * - 贴底悬浮：shadow-float + lg 圆角，左右 16 边距，底部贴安全区
 * - 多行自适应 1-6 行；右侧发送按钮常驻拇指区（40×40 accent 圆形）
 * - 左侧参数入口（SlidersHorizontal）点开 ParamSheet
 */
export interface PromptBarProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onOpenParams: () => void;
  /** M17 反推提示词入口（可选）：选图/视频 → /api/reverse 反推回填；不传则不渲染按钮 */
  onReverse?: () => void;
  /** 反推中：按钮转圈并禁用（VLM 长任务，防重复触发） */
  reversing?: boolean;
  /** M18 优化提示词入口（可选）：口语输入 → /api/optimize 扩写回填；不传则不渲染按钮 */
  onOptimize?: () => void;
  /** 优化中：按钮转圈并禁用（LLM 调用，防重复触发） */
  optimizing?: boolean;
  submitting?: boolean;
  placeholder?: string;
  testID?: string;
}

export function PromptBar({
  value,
  onChange,
  onSubmit,
  onOpenParams,
  onReverse,
  reversing = false,
  onOptimize,
  optimizing = false,
  submitting = false,
  placeholder = '描述想要的画面…',
  testID = 'prompt-bar',
}: PromptBarProps) {
  const { colors, radius, spacing, typography, elevation } = useAppTheme();
  const insets = useSafeAreaInsets();
  const canSend = value.trim().length > 0 && !submitting;
  // 优化依赖已有 prompt 文本：空输入不可点（对齐小程序端 disabled 语义）
  const canOptimize = value.trim().length > 0 && !submitting && !optimizing && !reversing;

  return (
    <View
      testID={testID}
      style={{
        marginHorizontal: spacing[4],
        marginBottom: Math.max(insets.bottom, spacing[2]),
        marginTop: spacing[2],
        flexDirection: 'row',
        alignItems: 'flex-end',
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        paddingLeft: spacing[1],
        paddingRight: spacing[1],
        paddingVertical: spacing[1],
        ...elevation.float,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="生成参数"
        onPress={onOpenParams}
        testID={`${testID}-params`}
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.full,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="SlidersHorizontal" size={20} color={colors.textSecondary} />
      </Pressable>

      {/* M17 反推提示词：选图/视频 → VLM 反推英文 prompt 回填（样式对齐参数入口的 40×40 圆形语言） */}
      {onReverse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="反推提示词"
          accessibilityState={{ disabled: reversing || submitting, busy: reversing }}
          disabled={reversing || submitting}
          onPress={onReverse}
          testID={`${testID}-reverse`}
          style={({ pressed }) => ({
            width: 40,
            height: 40,
            borderRadius: radius.full,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: reversing || submitting ? 0.4 : pressed ? 0.85 : 1,
          })}
        >
          {reversing ? (
            <ActivityIndicator color={colors.accent} testID={`${testID}-reversing`} />
          ) : (
            <Icon name="Wand2" size={20} color={colors.accent} />
          )}
        </Pressable>
      ) : null}

      {/* M18 优化提示词：口语输入 → LLM 扩写专业英文 prompt 回填（对齐 Web OptimizeButton 语义） */}
      {onOptimize ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="优化提示词"
          accessibilityState={{ disabled: !canOptimize, busy: optimizing }}
          disabled={!canOptimize}
          onPress={onOptimize}
          testID={`${testID}-optimize`}
          style={({ pressed }) => ({
            width: 40,
            height: 40,
            borderRadius: radius.full,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: !canOptimize ? 0.4 : pressed ? 0.85 : 1,
          })}
        >
          {optimizing ? (
            <ActivityIndicator color={colors.accent} testID={`${testID}-optimizing`} />
          ) : (
            <Icon name="Sparkles" size={20} color={colors.accent} />
          )}
        </Pressable>
      ) : null}

      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        multiline
        testID={`${testID}-input`}
        style={{
          flex: 1,
          marginHorizontal: spacing[2],
          color: colors.text,
          fontSize: typography.body.fontSize,
          lineHeight: typography.body.lineHeight,
          // 1-6 行自适应：最小 1 行高，最大 6 行高
          minHeight: typography.body.lineHeight,
          maxHeight: typography.body.lineHeight * 6,
          paddingVertical: spacing[2],
        }}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="生成"
        accessibilityState={{ disabled: !canSend, busy: submitting }}
        disabled={!canSend}
        onPress={onSubmit}
        testID={`${testID}-send`}
        style={({ pressed }) => ({
          width: 40,
          height: 40,
          borderRadius: radius.full,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.accent,
          opacity: !canSend ? 0.4 : pressed ? 0.85 : 1,
        })}
      >
        {submitting ? (
          <ActivityIndicator color={colors.bg} testID={`${testID}-sending`} />
        ) : (
          <Icon name="ArrowUp" size={20} color={colors.bg} />
        )}
      </Pressable>
    </View>
  );
}
