import { Pressable, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import type { EngineParam, LoraValue } from '@/types/api';

/**
 * LoRA 叠加字段（ParamSheet loras 型渲染器，M10.3，H3 引擎）
 * 语义对齐 Web ParamField loras 分支与 MiniProgram loras-field.vue：
 * - 多选 ≤3（后端 h3_studio.py _MAX_LORAS 同源，超出后端 422 兜底），选中追加 {name, strength:0.6}
 * - 强度区间/步进取注册表 param.min/max/step（H3LoraInput 0.5-1.0 / 0.05）；
 *   移动端无原生滑杆，以 +/- 步进器承载（步进即注册表 step，结果规整 2 位小数）
 * - options 为空 = H3 实例不可达/无 LoRA（注册表声明态兜底），显式提示不静默吞掉
 */

/** 后端 h3_studio.py _MAX_LORAS 同一约束 */
const MAX_LORAS = 3;
/** H3LoraInput 缺省强度（作者推荐，与 generate-screen LORA_DEFAULT_STRENGTH 同源；本地常量避免组件反向依赖屏幕模块） */
const DEFAULT_STRENGTH = 0.6;

export interface LorasFieldProps {
  param: EngineParam;
  /** 表单值载体：LoraValue 数组；脏值（非数组）按空数组渲染 */
  value: LoraValue[];
  onChange: (value: LoraValue[]) => void;
  testID?: string;
}

export function LorasField({ param, value, onChange, testID = 'loras-field' }: LorasFieldProps) {
  const { colors, radius, spacing, typography } = useAppTheme();

  const options = param.options ?? [];
  const selected: LoraValue[] = Array.isArray(value) ? value : [];

  const strengthMin = param.min ?? 0.5;
  const strengthMax = param.max ?? 1.0;
  const strengthStep = param.step ?? 0.05;

  const isOn = (name: string) => selected.some((l) => l && l.name === name);
  const strengthOf = (name: string): number => {
    const s = selected.find((l) => l && l.name === name)?.strength;
    return typeof s === 'number' && Number.isFinite(s) ? s : DEFAULT_STRENGTH;
  };
  /** 已达上限且未选中的项禁止再选（capped 只挡未选项，已选项仍可取消） */
  const isCapped = (name: string) => !isOn(name) && selected.length >= MAX_LORAS;

  const toggle = (name: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isOn(name)) {
      onChange(selected.filter((l) => l.name !== name));
      return;
    }
    if (selected.length >= MAX_LORAS) return;
    onChange([...selected, { name, strength: DEFAULT_STRENGTH }]);
  };

  /** 强度步进：±step 后钳到 [min,max] 并规整 2 位小数（0.6+0.05 浮点误差兜底） */
  const bump = (name: string, dir: 1 | -1) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onChange(
      selected.map((l) => {
        if (l.name !== name) return l;
        const clamped = Math.min(strengthMax, Math.max(strengthMin, strengthOf(name) + dir * strengthStep));
        return { ...l, strength: Math.round(clamped * 100) / 100 };
      }),
    );
  };

  const captionStyle = {
    color: colors.textSecondary,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
  } as const;

  const stepButtonStyle = {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;

  return (
    <View style={{ marginTop: spacing[5] }} testID={testID}>
      <Text style={{ marginBottom: spacing[2], ...captionStyle }}>{param.label}</Text>

      {options.length === 0 ? (
        <Text testID={`${testID}-empty`} style={captionStyle}>
          引擎实例上暂无可用 LoRA
        </Text>
      ) : (
        <View style={{ gap: spacing[2] }}>
          {options.map((opt) => {
            const on = isOn(opt.value);
            const capped = isCapped(opt.value);
            return (
              <View key={opt.value} style={{ gap: spacing[1] }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: capped }}
                  disabled={capped}
                  onPress={() => toggle(opt.value)}
                  testID={`${testID}-opt-${opt.value}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing[2],
                    minHeight: 44,
                    paddingHorizontal: spacing[3],
                    borderWidth: 1,
                    borderRadius: radius.md,
                    borderColor: on ? colors.accent : colors.border,
                    backgroundColor: on ? colors.accentSoft : colors.bg,
                    opacity: capped ? 0.5 : 1,
                  }}
                >
                  {/* 选中勾选框 */}
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderWidth: 1,
                      borderRadius: radius.sm,
                      borderColor: on ? colors.accent : colors.border,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {on ? <Icon name="Check" size={14} color={colors.accent} /> : null}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      color: on ? colors.accent : colors.text,
                      fontSize: typography.body.fontSize,
                      lineHeight: typography.body.lineHeight,
                      fontWeight: on ? '600' : '400',
                    }}
                  >
                    {opt.label}
                  </Text>
                  {opt.nsfw ? (
                    <Text
                      style={{
                        fontSize: 10,
                        color: colors.danger,
                        borderWidth: 1,
                        borderColor: colors.danger,
                        borderRadius: radius.sm,
                        paddingHorizontal: spacing[1],
                      }}
                    >
                      R18
                    </Text>
                  ) : null}
                </Pressable>

                {/* 强度步进器：仅选中项展示 */}
                {on ? (
                  <View
                    testID={`${testID}-strength-${opt.value}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing[3],
                      paddingHorizontal: spacing[2],
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${opt.label} 强度减`}
                      onPress={() => bump(opt.value, -1)}
                      testID={`${testID}-strength-${opt.value}-minus`}
                      style={stepButtonStyle}
                    >
                      <Icon name="Minus" size={16} color={colors.text} />
                    </Pressable>
                    <Text style={{ flex: 1, textAlign: 'center', ...captionStyle }}>
                      {strengthOf(opt.value).toFixed(2)}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${opt.label} 强度加`}
                      onPress={() => bump(opt.value, 1)}
                      testID={`${testID}-strength-${opt.value}-plus`}
                      style={stepButtonStyle}
                    >
                      <Icon name="Plus" size={16} color={colors.text} />
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })}
          <Text style={[captionStyle, { opacity: 0.75 }]}>{`已选 ${selected.length}/${MAX_LORAS}`}</Text>
        </View>
      )}

      {param.hint ? (
        <Text style={{ marginTop: spacing[1], ...captionStyle, opacity: 0.8 }}>{param.hint}</Text>
      ) : null}
    </View>
  );
}
