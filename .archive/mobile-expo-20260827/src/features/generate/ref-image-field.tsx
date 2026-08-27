import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { AssetPicker } from '@/features/assets/asset-picker';
import { uploadImage } from '@/lib/api';
import type { EngineParam, UploadedRefImage } from '@/types/api';

/**
 * 参考图字段（ParamSheet images 型渲染器，M8）
 * 链路对齐 Web RefImageUpload「选中即传」：
 * 系统相册选图（Expo v57 launchImageLibraryAsync，启动无需运行时权限）
 * → 客户端先验（扩展名白名单 / ≤20MB，与 upload.py 三重白名单同源）
 * → POST /api/upload 拿 { filename, worker } 句柄 → 本地 uri 预览
 * 提交时由 buildImg2ImgRequest 消费句柄（生成与参考图同 worker）
 * M13.3：标签行右侧「资产库」次级入口，点选库内图直接回填句柄（不重新上传，选中即替换）
 */

/** 与后端 upload.py 一致的图片上限 */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 客户端扩展名白名单（后端 _EXT_TO_KIND 图片侧子集；gif 不动图语义不一致，不收） */
const IMAGE_EXT_OK = new Set(['jpg', 'jpeg', 'png', 'webp']);
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface RefImageFieldProps {
  param: EngineParam;
  value: UploadedRefImage | null;
  onChange: (value: UploadedRefImage | null) => void;
  /** 上传路由 kind（M9 起按引擎路由：img2img/ltx_i2v/wan_animate，决定后端接收校验与落点） */
  uploadKind?: string;
  testID?: string;
}

export function RefImageField({ param, value, onChange, uploadKind, testID = 'ref-image-field' }: RefImageFieldProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const pick = async () => {
    if (uploading) return;
    setError(null);
    lightHaptic();

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
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
    if (!IMAGE_EXT_OK.has(ext)) {
      setError('仅支持 jpg / png / webp 图片');
      return;
    }
    if (asset.fileSize !== undefined && asset.fileSize > IMAGE_MAX_BYTES) {
      setError('图片超过 20MB 上限');
      return;
    }

    setUploading(true);
    try {
      const r = await uploadImage(
        {
          uri: asset.uri,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
        },
        uploadKind,
      );
      onChange({
        filename: r.filename,
        worker: r.worker,
        previewUri: asset.uri,
        name: asset.fileName ?? `upload.${ext}`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={{ marginTop: spacing[5] }} testID={testID}>
      <View
        style={{
          marginBottom: spacing[2],
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {param.label}
        </Text>
        {/* 资产库次级入口（M13.3）：选中即替换当前参考图，句柄已带 worker 视为已上传完成态 */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="从资产库选择"
          hitSlop={8}
          onPress={() => {
            lightHaptic();
            setError(null);
            setPickerOpen(true);
          }}
          testID={`${testID}-asset-entry`}
          style={{
            minHeight: 32,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[1],
            paddingHorizontal: spacing[2],
          }}
        >
          <Icon name="Layers" size={14} color={colors.accent} />
          <Text
            style={{
              color: colors.accent,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            资产库
          </Text>
        </Pressable>
      </View>

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
          <Image
            source={{ uri: value.previewUri }}
            testID={`${testID}-thumb`}
            style={{ width: 40, height: 40, borderRadius: radius.sm }}
          />
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
            accessibilityLabel="移除参考图"
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
            {uploading ? '上传中…' : '上传参考图'}
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

      <AssetPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(image) => onChange(image)}
        testID={`${testID}-asset-picker`}
      />
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
  return MIME_TO_EXT[mimeType ?? ''] ?? '';
}
