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
 * 多参考图字段（ParamSheet images 型 max>1 渲染器，M9 wan-vace 1-4 张链路）
 * 链路对齐 Web RefImagesUpload「选中即传」：
 * 系统相册多选（Expo v57 launchImageLibraryAsync，allowsMultipleSelection + selectionLimit）
 * → 客户端先验（扩展名白名单 / ≤20MB，与 upload.py 三重白名单同源）
 * → 逐张 POST /api/upload：第一张自由落点，后续钉第一张落点 worker（跨机取不到文件）
 * 提交时由 buildWanVaceRequest 消费句柄数组（worker 取第一张落点）
 * M13.3：标签行右侧「资产库」次级入口，点选库内图追加句柄（不重新上传，不超 max 上限）
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

export interface RefImagesFieldProps {
  param: EngineParam;
  /** 已上传句柄数组（兼容 schema default null） */
  value: UploadedRefImage[] | null;
  onChange: (value: UploadedRefImage[]) => void;
  /** 上传路由 kind（wan_vace 等，决定后端接收校验与落点） */
  uploadKind: string;
  testID?: string;
}

export function RefImagesField({
  param,
  value,
  onChange,
  uploadKind,
  testID = 'ref-images-field',
}: RefImagesFieldProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const values = value ?? [];
  const max = typeof param.max === 'number' && param.max > 0 ? param.max : 4;

  /** 资产库点选追加（M13.3）：句柄已带 worker 视为已上传完成态；不超 max 上限 */
  const appendFromAsset = (image: UploadedRefImage) => {
    setError(null);
    if (values.length >= max) return;
    onChange([...values, image]);
  };

  const pick = async () => {
    if (uploading) return;
    setError(null);
    lightHaptic();

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: max - values.length,
        quality: 1,
      });
    } catch {
      setError('无法打开相册，请重试');
      return;
    }
    if (result.canceled) return;
    const assets = (result.assets ?? []).slice(0, max - values.length);
    if (assets.length === 0) return;

    // 客户端先验：每张扩展名 + 体积，任一不合规整体放弃（与单图字段同语义）
    for (const asset of assets) {
      const ext = extOf(asset.fileName, asset.mimeType);
      if (!IMAGE_EXT_OK.has(ext)) {
        setError('仅支持 jpg / png / webp 图片');
        return;
      }
      if (asset.fileSize !== undefined && asset.fileSize > IMAGE_MAX_BYTES) {
        setError('图片超过 20MB 上限');
        return;
      }
    }

    setUploading(true);
    try {
      // 互钉：已有第一张的 worker 为钉点；否则本批第一张自由落点，后续钉它（对齐 Web pinWorker=values[0]?.worker）
      let pin = values[0]?.worker;
      const uploaded: UploadedRefImage[] = [];
      for (const asset of assets) {
        const ext = extOf(asset.fileName, asset.mimeType);
        const r = await uploadImage(
          {
            uri: asset.uri,
            fileName: asset.fileName,
            mimeType: asset.mimeType,
          },
          uploadKind,
          pin,
        );
        uploaded.push({
          filename: r.filename,
          worker: r.worker,
          previewUri: asset.uri,
          name: asset.fileName ?? `upload.${ext}`,
        });
        pin = pin ?? r.worker;
      }
      onChange([...values, ...uploaded]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  const removeAt = (idx: number) => {
    lightHaptic();
    setError(null);
    onChange(values.filter((_, i) => i !== idx));
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
          {`${param.label}(${values.length}/${max})`}
        </Text>
        {/* 资产库次级入口（M13.3）：与上传按钮同生命周期，满员后隐藏 */}
        {values.length < max ? (
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
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], alignItems: 'center' }}>
        {values.map((v, i) => (
          <View key={v.filename} testID={`${testID}-item-${i}`}>
            <Image
              source={{ uri: v.previewUri }}
              testID={`${testID}-thumb-${i}`}
              style={{
                width: 48,
                height: 48,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`移除参考图 ${i + 1}`}
              hitSlop={8}
              onPress={() => removeAt(i)}
              testID={`${testID}-remove-${i}`}
              style={{
                position: 'absolute',
                top: -6,
                right: -6,
                width: 20,
                height: 20,
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <Icon name="X" size={11} color={colors.textSecondary} />
            </Pressable>
          </View>
        ))}

        {values.length < max ? (
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
              {uploading ? '上传中…' : values.length === 0 ? '上传参考图' : '再加一张'}
            </Text>
          </Pressable>
        ) : null}
      </View>

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
        onSelect={appendFromAsset}
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
