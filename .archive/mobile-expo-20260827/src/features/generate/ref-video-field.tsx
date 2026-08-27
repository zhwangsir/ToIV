import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { uploadVideo } from '@/lib/api';
import type { EngineParam, UploadedRefVideo } from '@/types/api';

/**
 * 驱动视频字段（ParamSheet video 型渲染器，M9 wan-animate 动作迁移链路）
 * 链路对齐 Web RefVideoUpload「选中即传」：
 * 系统相册选视频（Expo v57 launchImageLibraryAsync，mediaTypes: ['videos']）
 * → 客户端先验（扩展名 mp4/mov/webm / ≤200MB，与 upload.py 三重白名单同源）
 * → POST /api/upload（pinWorker 钉参考图落点，提交时后端同机转运到专用实例）
 * 参考图换 worker/被移除时由 syncVideoWithRefImage 清空本字段（跨机取不到文件）
 */

/** 与后端 upload.py 一致的视频上限 */
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
/** 客户端扩展名白名单（后端 _EXT_TO_KIND 视频侧子集） */
const VIDEO_EXT_OK = new Set(['mp4', 'mov', 'webm']);
const VIDEO_MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export interface RefVideoFieldProps {
  param: EngineParam;
  value: UploadedRefVideo | null;
  onChange: (value: UploadedRefVideo | null) => void;
  /** 上传路由 kind（wan_animate 等，决定后端接收校验与落点） */
  uploadKind: string;
  /** 钉到指定 worker（参考图落点；为空自由落点） */
  pinWorker?: string | null;
  testID?: string;
}

export function RefVideoField({
  param,
  value,
  onChange,
  uploadKind,
  pinWorker,
  testID = 'ref-video-field',
}: RefVideoFieldProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    if (uploading) return;
    setError(null);
    lightHaptic();

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
      });
    } catch {
      setError('无法打开相册，请重试');
      return;
    }
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    // 客户端先验：扩展名（fileName → mimeType 推断）+ 体积（fileSize 可得时）
    const ext = extOf(asset.fileName, asset.mimeType);
    if (!VIDEO_EXT_OK.has(ext)) {
      setError('仅支持 mp4 / mov / webm 视频');
      return;
    }
    if (asset.fileSize !== undefined && asset.fileSize > VIDEO_MAX_BYTES) {
      setError('视频超过 200MB 上限');
      return;
    }

    setUploading(true);
    try {
      const r = await uploadVideo(
        {
          uri: asset.uri,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
        },
        uploadKind,
        pinWorker ?? undefined,
      );
      onChange({
        filename: r.filename,
        worker: r.worker,
        name: asset.fileName ?? `upload.${ext}`,
        durationMs: typeof asset.duration === 'number' ? asset.duration : null,
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
          <Icon name="Video" size={20} color={colors.accent} />
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
            accessibilityLabel="移除驱动视频"
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
            {uploading ? '上传中…' : '上传驱动视频'}
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

/** 扩展名推断：fileName 优先，缺省按 mimeType；识别不出返回 ''（交给白名单拦截） */
function extOf(fileName: string | null | undefined, mimeType: string | undefined): string {
  const fromName = fileName?.split('.').pop()?.toLowerCase() ?? '';
  if (fromName && fromName !== fileName?.toLowerCase()) return fromName;
  return VIDEO_MIME_TO_EXT[mimeType ?? ''] ?? '';
}
