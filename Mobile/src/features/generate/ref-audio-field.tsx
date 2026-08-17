import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { uploadAudio } from '@/lib/api';
import type { EngineParam, UploadedRefAudio } from '@/types/api';

/**
 * 驱动音频字段（ParamSheet audio 型渲染器，M11 ltx-nsfw-lipsync 口型同步链路）
 * 链路对齐 Web RefAudioUpload「选中即传」：
 * 系统文档选择器选音频（Expo v57 DocumentPicker.getDocumentAsync，type: 'audio/*'；
 * expo-image-picker 不能选音频）→ 客户端先验（扩展名 wav/mp3/m4a/ogg/flac / ≤20MB，
 * 与 upload.py 三重白名单同源）→ POST /api/upload（pinWorker 钉参考图落点，LTX2.3 口型同机生成）
 * 参考图换 worker/被移除时由 syncAudioWithRefImage 清空本字段（跨机取不到文件）
 */

/** 与后端 upload.py 一致的音频上限 */
const AUDIO_MAX_BYTES = 20 * 1024 * 1024;
/** 客户端扩展名白名单（后端 _EXT_TO_KIND 音频侧子集，与注册表 _audio() 提示一致） */
const AUDIO_EXT_OK = new Set(['wav', 'mp3', 'm4a', 'ogg', 'flac']);
const AUDIO_MIME_TO_EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

export interface RefAudioFieldProps {
  param: EngineParam;
  value: UploadedRefAudio | null;
  onChange: (value: UploadedRefAudio | null) => void;
  /** 上传路由 kind（ltx_lipsync，决定后端接收校验与落点 worker 能力集） */
  uploadKind: string;
  /** 钉到指定 worker（参考图落点；为空自由落点） */
  pinWorker?: string | null;
  testID?: string;
}

export function RefAudioField({
  param,
  value,
  onChange,
  uploadKind,
  pinWorker,
  testID = 'ref-audio-field',
}: RefAudioFieldProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    if (uploading) return;
    setError(null);
    lightHaptic();

    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({ type: 'audio/*' });
    } catch {
      setError('无法打开文件选择器，请重试');
      return;
    }
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    // 客户端先验：扩展名（name → mimeType 推断）+ 体积（size 可得时）
    const ext = extOf(asset.name, asset.mimeType);
    if (!AUDIO_EXT_OK.has(ext)) {
      setError('仅支持 wav / mp3 / m4a / ogg / flac 音频');
      return;
    }
    if (typeof asset.size === 'number' && asset.size > AUDIO_MAX_BYTES) {
      setError('音频超过 20MB 上限');
      return;
    }

    setUploading(true);
    try {
      const r = await uploadAudio(
        {
          uri: asset.uri,
          fileName: asset.name,
          mimeType: asset.mimeType,
        },
        uploadKind,
        pinWorker ?? undefined,
      );
      onChange({
        filename: r.filename,
        worker: r.worker,
        name: asset.name,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={{ marginTop: spacing[5] }} testID={testID}>
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

      {value ? (
        <View
          testID={`${testID}-preview`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[2],
            padding: spacing[2],
            backgroundColor: colors.bg,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
          }}
        >
          <Icon name="AudioLines" size={20} color={colors.accent} />
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {value.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="移除驱动音频"
            hitSlop={8}
            onPress={() => {
              lightHaptic();
              setError(null);
              onChange(null);
            }}
            testID={`${testID}-remove`}
            style={{
              minWidth: 48,
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="X" size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: uploading }}
          disabled={uploading}
          onPress={() => void pick()}
          testID={`${testID}-pick`}
          style={{
            minHeight: 48,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing[2],
            paddingHorizontal: spacing[4],
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.bg,
          }}
        >
          {uploading ? (
            <ActivityIndicator color={colors.accent} testID={`${testID}-uploading`} />
          ) : (
            <Icon name="Upload" size={16} color={colors.accent} />
          )}
          <Text
            style={{
              color: uploading ? colors.textSecondary : colors.accent,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {uploading ? '上传中…' : '上传驱动音频'}
          </Text>
        </Pressable>
      )}

      <Text
        testID={`${testID}-hint`}
        style={{
          marginTop: spacing[1],
          color: error ? colors.danger : colors.textSecondary,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
          opacity: error ? 1 : 0.8,
        }}
      >
        {error ?? param.hint ?? ''}
      </Text>
    </View>
  );
}

function lightHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** 扩展名推断：文件名优先，缺省按 mimeType；识别不出返回 ''（交给白名单拦截） */
function extOf(name: string | null | undefined, mimeType: string | undefined): string {
  const fromName = name?.split('.').pop()?.toLowerCase() ?? '';
  if (fromName && fromName !== name?.toLowerCase()) return fromName;
  return AUDIO_MIME_TO_EXT[mimeType ?? ''] ?? '';
}
