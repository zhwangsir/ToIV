import { Modal, Pressable, ScrollView, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { uploadKindForEngine } from '@/lib/api';
import type { EngineInfo, EngineParam, LoraValue, UploadedRefAudio, UploadedRefImage, UploadedRefVideo } from '@/types/api';

import { RefAudioField } from './ref-audio-field';
import { RefImageField } from './ref-image-field';
import { RefImagesField } from './ref-images-field';
import { RefVideoField } from './ref-video-field';
import { LorasField } from './loras-field';

/**
 * ParamSheet（指南 4.2）：底部参数抽屉 —— M7.4 起由 EngineInfo.params 驱动
 * - 画幅比例预设置顶（高频），点按写入 width/height 表单值；引擎 schema 无 width/height 时隐藏（如 img2img 尺寸随参考图）
 * - 其余字段按注册表 schema 动态渲染：text/textarea/number/select/switch；
 *   images 由 RefImageField（单图，M8）/ RefImagesField（多图 max>1，M9 wan-vace）承载，选中即传互钉 worker
 * - video 由 RefVideoField 承载（M9 wan-animate 驱动视频，上传钉参考图落点）
 * - loras 由 LorasField 承载（M10.3 H3 LoRA 叠加：多选 ≤3 + 强度步进）
 * - audio 由 RefAudioField 承载（M11 ltx-nsfw-lipsync 驱动音频，上传钉参考图落点）
 * - width/height 由画幅预设承载，动态区跳过，避免重复入口
 */

/** 画幅预设：比例 → 像素尺寸（对齐后端 width/height 8 对齐约束） */
export const SIZE_PRESETS = [
  { id: '1:1', label: '1:1', width: 1024, height: 1024 },
  { id: '3:4', label: '3:4', width: 832, height: 1216 },
  { id: '4:3', label: '4:3', width: 1216, height: 832 },
  { id: '16:9', label: '16:9', width: 1344, height: 768 },
  { id: '9:16', label: '9:16', width: 768, height: 1344 },
] as const;

export type SizePreset = (typeof SIZE_PRESETS)[number];

/** 表单值载体：key → 参数当前值（number 编辑中允许暂存 ''，失焦/提交时回落 default） */
export type ParamValues = Record<string, unknown>;

/** 由引擎 schema 生成初始表单值（default 直抄，与后端请求模型默认值同源） */
export function defaultParamValues(engine: EngineInfo | null): ParamValues {
  const values: ParamValues = {};
  for (const p of engine?.params ?? []) {
    values[p.key] = p.default;
  }
  return values;
}

/** 画幅预设已覆盖的 key，动态渲染区跳过 */
const PRESET_KEYS = new Set(['width', 'height']);

export interface ParamSheetProps {
  visible: boolean;
  onClose: () => void;
  engine: EngineInfo | null;
  values: ParamValues;
  onValueChange: (key: string, value: unknown) => void;
  testID?: string;
}

export function ParamSheet({
  visible,
  onClose,
  engine,
  values,
  onValueChange,
  testID = 'param-sheet',
}: ParamSheetProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  const activeSize = SIZE_PRESETS.find((p) => p.width === values.width && p.height === values.height);
  const dynamicParams = (engine?.params ?? []).filter((p) => !PRESET_KEYS.has(p.key));
  // 画幅预设仅对 schema 声明了 width/height 的引擎展示（img2img 无尺寸参数，输出随参考图）
  const showSizePresets = (engine?.params ?? []).some((p) => PRESET_KEYS.has(p.key));
  // 上传路由 kind（M9 起按引擎路由；img2img 兜底）；驱动视频/音频钉参考图落点 worker
  const uploadKind = engine ? uploadKindForEngine(engine.id) : 'img2img';
  const mediaPinWorker = firstRefWorker(readImagesRaw(engine, values));

  const labelStyle = {
    marginBottom: spacing[2],
    color: colors.textSecondary,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
  } as const;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="关闭参数抽屉"
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
          maxHeight: windowHeight * 0.82,
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

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text
            style={{
              color: colors.text,
              fontSize: typography.heading.fontSize,
              lineHeight: typography.heading.lineHeight,
              fontWeight: '600',
            }}
          >
            生成参数
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="完成"
            onPress={onClose}
            hitSlop={8}
            testID={`${testID}-done`}
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="Check" size={20} color={colors.accent} />
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} style={{ flexGrow: 0 }}>
          {/* 画幅比例（前置高频参数，写入 width/height；schema 无尺寸参数时隐藏） */}
          {showSizePresets ? (
            <>
              <Text style={[labelStyle, { marginTop: spacing[2] }]} testID={`${testID}-size-label`}>
                画幅比例
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
                {SIZE_PRESETS.map((preset) => {
                  const active = preset.id === activeSize?.id;
                  return (
                    <Pressable
                      key={preset.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => {
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        onValueChange('width', preset.width);
                        onValueChange('height', preset.height);
                      }}
                      testID={`${testID}-size-${preset.id}`}
                      style={{
                        minHeight: 40,
                        paddingHorizontal: spacing[4],
                        borderRadius: radius.md,
                        borderWidth: 1,
                        borderColor: active ? colors.accent : colors.border,
                        backgroundColor: active ? colors.accentSoft : colors.bg,
                        alignItems: 'center',
                        justifyContent: 'center',
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
                        {preset.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          {/* schema 驱动的动态字段 */}
          {dynamicParams.map((param) => (
            <ParamField
              key={param.key}
              param={param}
              value={values[param.key]}
              onChange={(v) => onValueChange(param.key, v)}
              uploadKind={uploadKind}
              mediaPinWorker={mediaPinWorker}
              testID={`${testID}-field-${param.key}`}
            />
          ))}

          <View style={{ height: spacing[2] }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── 字段渲染器 ──────────────────────────────────────────────

/** 取引擎 images 参数的原始表单值（单图对象或多图数组；无 images 参数为 null） */
function readImagesRaw(engine: EngineInfo | null, values: ParamValues): unknown {
  const key = engine?.params.find((p) => p.type === 'images')?.key;
  return key ? values[key] : null;
}

/** 第一张已上传参考图的 worker（驱动视频钉点；单图对象/多图数组兼容，脏值兜底 null） */
function firstRefWorker(raw: unknown): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first && typeof first === 'object' && typeof (first as UploadedRefImage).worker === 'string') {
    return (first as UploadedRefImage).worker;
  }
  return null;
}

interface ParamFieldProps {
  param: EngineParam;
  value: unknown;
  onChange: (value: unknown) => void;
  /** 上传路由 kind（images/video/audio 型字段用） */
  uploadKind: string;
  /** 驱动媒体钉点：参考图落点 worker（video/audio 型字段用） */
  mediaPinWorker: string | null;
  testID: string;
}

function ParamField({ param, value, onChange, uploadKind, mediaPinWorker, testID }: ParamFieldProps) {
  const { colors, radius, spacing, typography } = useAppTheme();

  const label = (
    <Text
      style={{
        marginBottom: spacing[2],
        color: colors.textSecondary,
        fontSize: typography.caption.fontSize,
        lineHeight: typography.caption.lineHeight,
      }}
    >
      {param.label}
    </Text>
  );
  const hint = param.hint ? (
    <Text
      style={{
        marginTop: spacing[1],
        color: colors.textSecondary,
        fontSize: typography.caption.fontSize,
        lineHeight: typography.caption.lineHeight,
        opacity: 0.8,
      }}
    >
      {param.hint}
    </Text>
  ) : null;

  const inputStyle = {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    color: colors.text,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  } as const;

  switch (param.type) {
    case 'textarea':
      return (
        <View style={{ marginTop: spacing[5] }} testID={testID}>
          {label}
          <TextInput
            value={typeof value === 'string' ? value : ''}
            onChangeText={onChange}
            placeholder={param.hint ? undefined : '可留空'}
            placeholderTextColor={colors.textSecondary}
            multiline
            testID={`${testID}-input`}
            style={{
              ...inputStyle,
              minHeight: typography.body.lineHeight * 3,
              maxHeight: typography.body.lineHeight * 5,
              textAlignVertical: 'top',
            }}
          />
          {hint}
        </View>
      );

    case 'text':
      return (
        <View style={{ marginTop: spacing[5] }} testID={testID}>
          {label}
          <TextInput
            value={typeof value === 'string' ? value : String(value ?? '')}
            onChangeText={onChange}
            placeholderTextColor={colors.textSecondary}
            testID={`${testID}-input`}
            style={inputStyle}
          />
          {hint}
        </View>
      );

    case 'number':
      return (
        <View style={{ marginTop: spacing[5] }} testID={testID}>
          {label}
          <NumberField param={param} value={value} onChange={onChange} testID={`${testID}-input`} />
          {hint}
        </View>
      );

    case 'select': {
      const options = param.options ?? [];
      return (
        <View style={{ marginTop: spacing[5] }} testID={testID}>
          {label}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
            {options.map((opt) => {
              const active = opt.value === value;
              return (
                <Pressable
                  key={opt.value || '__default__'}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onChange(opt.value);
                  }}
                  testID={`${testID}-opt-${opt.value || 'default'}`}
                  style={{
                    minHeight: 40,
                    paddingHorizontal: spacing[3],
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: active ? colors.accent : colors.border,
                    backgroundColor: active ? colors.accentSoft : colors.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
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
                </Pressable>
              );
            })}
          </View>
          {hint}
        </View>
      );
    }

    case 'switch':
      return (
        <View
          style={{ marginTop: spacing[5], flexDirection: 'row', alignItems: 'center' }}
          testID={testID}
        >
          <View style={{ flex: 1 }}>
            {label}
            {hint}
          </View>
          <Switch
            value={value === true}
            onValueChange={onChange}
            testID={`${testID}-input`}
          />
        </View>
      );

    case 'images':
      // 参考图：选中即传（自带上传/预览/移除/错误态）
      // max>1 多图（M9 wan-vace 1-4 张互钉）；否则单图句柄（img2img/ltx25-i2v/wan-animate）
      if (typeof param.max === 'number' && param.max > 1) {
        return (
          <RefImagesField
            param={param}
            value={(value as UploadedRefImage[] | null) ?? null}
            onChange={onChange}
            uploadKind={uploadKind}
            testID={testID}
          />
        );
      }
      return (
        <RefImageField
          param={param}
          value={(value as UploadedRefImage | null) ?? null}
          onChange={onChange}
          uploadKind={uploadKind}
          testID={testID}
        />
      );

    case 'video':
      // 驱动视频（M9 wan-animate）：选中即传并钉参考图落点 worker
      return (
        <RefVideoField
          param={param}
          value={(value as UploadedRefVideo | null) ?? null}
          onChange={onChange}
          uploadKind={uploadKind}
          pinWorker={mediaPinWorker}
          testID={testID}
        />
      );

    case 'audio':
      // 驱动音频（M11 ltx-nsfw-lipsync）：选中即传并钉参考图落点 worker
      return (
        <RefAudioField
          param={param}
          value={(value as UploadedRefAudio | null) ?? null}
          onChange={onChange}
          uploadKind={uploadKind}
          pinWorker={mediaPinWorker}
          testID={testID}
        />
      );

    case 'loras':
      // LoRA 叠加（M10.3 H3）：多选 ≤3 + 单项强度步进（脏值按空数组渲染）
      return (
        <LorasField
          param={param}
          value={(value as LoraValue[] | null) ?? []}
          onChange={onChange}
          testID={testID}
        />
      );

    default:
      return null;
  }
}

/** 数值输入：编辑中暂存原文，失焦时 clamp 到 [min,max]，空串回落 default */
function NumberField({
  param,
  value,
  onChange,
  testID,
}: Pick<ParamFieldProps, 'param' | 'value' | 'onChange' | 'testID'>) {
  const { colors, radius, spacing, typography } = useAppTheme();
  // 受控原文：value 为 number 时直接展示；'' 表示用户清空中
  const text = value === '' || value === null || value === undefined ? '' : String(value);

  return (
    <TextInput
      keyboardType="numeric"
      value={text}
      onChangeText={(t) => {
        if (t === '') {
          onChange('');
          return;
        }
        const n = Number(t);
        if (!Number.isNaN(n)) onChange(n);
      }}
      onEndEditing={() => {
        let n = text === '' ? NaN : Number(text);
        if (Number.isNaN(n)) n = Number(param.default);
        if (Number.isNaN(n)) n = 0;
        if (param.min !== undefined) n = Math.max(param.min, n);
        if (param.max !== undefined) n = Math.min(param.max, n);
        onChange(n);
      }}
      placeholderTextColor={colors.textSecondary}
      testID={testID}
      style={{
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bg,
        paddingHorizontal: spacing[3],
        paddingVertical: spacing[2],
        color: colors.text,
        fontSize: typography.body.fontSize,
        lineHeight: typography.body.lineHeight,
      }}
    />
  );
}
