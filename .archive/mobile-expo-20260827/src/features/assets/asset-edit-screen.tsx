/**
 * 参考资产新建/编辑屏（M13）
 * - 新建：/assets/edit；编辑：/assets/edit?id=<id>（getAsset 回显，PATCH 仅变化字段落库）
 * - 新建支持 prefill 参数（M28 产物存为资产：encodeURIComponent(JSON)，解析失败静默忽略）
 * - 图片 1-4 张：相册多选 → 客户端先验（扩展名/≤20MB）→ 逐张上传，第 2-4 张钉第一张落点 worker
 *   （对齐 ref-images-field 互钉逻辑；kind=img2img 无能力门槛，见 asset-utils ASSET_UPLOAD_KIND）
 * - NSFW 开关仅 R18 上下文（settings store nsfwIntent）渲染；删除走确认 Alert → 返回刷新列表
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  assetImageUrl,
  createAsset,
  deleteAsset,
  getAsset,
  updateAsset,
  uploadImage,
} from '@/lib/api';
import { useSettingsStore } from '@/stores/settings';
import type { AssetItem, AssetKind } from '@/types/api';

import {
  ASSET_IMAGE_MAX,
  ASSET_KINDS,
  ASSET_NAME_MAX,
  ASSET_UPLOAD_KIND,
  buildAssetPatch,
  imageExtOf,
  validateAssetDraft,
  validateImagePick,
} from './asset-utils';
import { parseAssetPrefill } from './asset-prefill';

/** 编辑表单内的图片草稿：服务端句柄 + 本地/远程预览（资产图回显走 assetImageUrl 代理） */
export interface AssetDraftImage {
  filename: string;
  worker: string;
  previewUri: string;
  name: string;
}

function lightHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export function AssetEditScreen() {
  const { colors, radius, spacing, typography } = useAppTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const nsfwIntent = useSettingsStore((s) => s.nsfwIntent);

  const params = useLocalSearchParams<{ id?: string; prefill?: string }>();
  const id = typeof params.id === 'string' && params.id ? params.id : null;

  const detailQuery = useQuery({
    queryKey: ['assets', 'detail', id],
    queryFn: () => getAsset(id as string),
    enabled: id !== null,
  });

  const [original, setOriginal] = useState<AssetItem | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AssetKind>('character');
  const [description, setDescription] = useState('');
  const [nsfw, setNsfw] = useState(false);
  const [images, setImages] = useState<AssetDraftImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefillApplied, setPrefillApplied] = useState(false);

  // M28 产物存为资产：新建态消费 prefill 参数一次（渲染期条件调整，同 detailData 回填模式）；
  // 编辑态（带 id）忽略；解析失败静默按空白表单
  if (!id && !prefillApplied) {
    const prefill = parseAssetPrefill(
      typeof params.prefill === 'string' ? params.prefill : undefined,
    );
    if (prefill) {
      setName(prefill.name);
      setNsfw(prefill.nsfw);
      setImages(
        prefill.images.map((img) => ({
          filename: img.filename,
          worker: img.worker,
          previewUri: img.preview,
          name: img.filename,
        })),
      );
    }
    setPrefillApplied(true);
  }

  // 编辑态数据到达后回填一次：渲染期条件调整（React 官方模式），refetch 不覆盖用户编辑
  const detailData = detailQuery.data;
  if (detailData && !hydrated) {
    setOriginal(detailData);
    setName(detailData.name);
    setKind(detailData.kind);
    setDescription(detailData.description);
    setNsfw(detailData.nsfw);
    setImages(
      detailData.images.map((img, idx) => ({
        filename: img.filename,
        worker: img.worker,
        previewUri: assetImageUrl(detailData.id, idx),
        name: img.filename,
      })),
    );
    setHydrated(true);
  }

  const pick = async () => {
    if (uploading) return;
    setError(null);
    lightHaptic();

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: ASSET_IMAGE_MAX - images.length,
        quality: 1,
      });
    } catch {
      setError('无法打开相册，请重试');
      return;
    }
    if (result.canceled) return;
    const picked = (result.assets ?? []).slice(0, ASSET_IMAGE_MAX - images.length);
    if (picked.length === 0) return;

    // 客户端先验：每张扩展名 + 体积，任一不合规整体放弃（与 ref-images-field 同语义）
    for (const asset of picked) {
      const invalid = validateImagePick(asset);
      if (invalid) {
        setError(invalid);
        return;
      }
    }

    setUploading(true);
    try {
      // 互钉：已有第一张的 worker 为钉点；否则本批第一张自由落点，后续钉它
      let pin = images[0]?.worker;
      const uploaded: AssetDraftImage[] = [];
      for (const asset of picked) {
        const r = await uploadImage(
          { uri: asset.uri, fileName: asset.fileName, mimeType: asset.mimeType },
          ASSET_UPLOAD_KIND,
          pin,
        );
        uploaded.push({
          filename: r.filename,
          worker: r.worker,
          previewUri: asset.uri,
          name: asset.fileName ?? `upload.${imageExtOf(asset.fileName, asset.mimeType)}`,
        });
        pin = pin ?? r.worker;
      }
      setImages([...images, ...uploaded]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  const removeAt = (idx: number) => {
    lightHaptic();
    setError(null);
    setImages(images.filter((_, i) => i !== idx));
  };

  const save = async () => {
    const invalid = validateAssetDraft({ name, images });
    if (invalid) {
      setError(invalid);
      return;
    }
    lightHaptic();
    setSaving(true);
    setError(null);
    try {
      const handles = images.map(({ filename, worker }) => ({ filename, worker }));
      if (original) {
        const patch = buildAssetPatch(original, { kind, name, description, images: handles, nsfw });
        // 无变化不发请求（后端 AssetPatch 空体为无操作，省一次往返）
        if (Object.keys(patch).length > 0) await updateAsset(original.id, patch);
      } else {
        await createAsset({
          kind,
          name: name.trim(),
          description: description.trim(),
          images: handles,
          nsfw,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    lightHaptic();
    Alert.alert('删除资产', `「${original?.name ?? ''}」删除后不可恢复（worker 上的文件本体保留）。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void doDelete() },
    ]);
  };

  const doDelete = async () => {
    if (!original) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAsset(original.id);
      await queryClient.invalidateQueries({ queryKey: ['assets'] });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败，请重试');
    } finally {
      setDeleting(false);
    }
  };

  const labelStyle = {
    marginBottom: spacing[2],
    color: colors.textSecondary,
    fontSize: typography.caption.fontSize,
    lineHeight: typography.caption.lineHeight,
  } as const;
  const inputStyle = {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    color: colors.text,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  } as const;

  return (
    <Screen testID="screen-asset-edit">
      <View style={{ flex: 1, paddingHorizontal: spacing[4] }}>
        {/* 头部：返回 + 标题（新建/编辑） */}
        <View
          style={{
            marginTop: spacing[2],
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回"
            onPress={() => router.back()}
            hitSlop={8}
            testID="asset-edit-back"
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="ChevronLeft" size={24} color={colors.text} />
          </Pressable>
          <Text
            testID="asset-edit-title"
            style={{
              marginLeft: spacing[2],
              color: colors.text,
              fontSize: typography.heading.fontSize,
              lineHeight: typography.heading.lineHeight,
              fontWeight: '700',
            }}
          >
            {id ? '编辑资产' : '新建资产'}
          </Text>
        </View>

        {id && detailQuery.isPending ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.accent} testID="asset-edit-loading" />
          </View>
        ) : id && detailQuery.isError ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text
              testID="asset-edit-load-error"
              style={{
                color: colors.danger,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {detailQuery.error instanceof Error ? detailQuery.error.message : '资产加载失败'}
            </Text>
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: spacing[8] }}
            testID="asset-edit-form"
          >
            {/* 名称 */}
            <Text style={[labelStyle, { marginTop: spacing[4] }]}>名称</Text>
            <TextInput
              value={name}
              onChangeText={(t) => {
                setName(t);
                setError(null);
              }}
              placeholder="例如：女主-A / 赛博街道"
              placeholderTextColor={colors.textSecondary}
              maxLength={ASSET_NAME_MAX}
              testID="asset-edit-name-input"
              style={inputStyle}
            />

            {/* kind 四选一 */}
            <Text style={[labelStyle, { marginTop: spacing[5] }]}>类别</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
              {ASSET_KINDS.map((k) => {
                const active = kind === k.key;
                return (
                  <Pressable
                    key={k.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={k.label}
                    onPress={() => {
                      lightHaptic();
                      setKind(k.key);
                    }}
                    testID={`asset-kind-${k.key}`}
                    style={{
                      minHeight: 40,
                      paddingHorizontal: spacing[3],
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: active ? colors.accent : colors.border,
                      backgroundColor: active ? colors.accentSoft : colors.surface,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: spacing[1],
                    }}
                  >
                    <Icon
                      name={k.icon}
                      size={16}
                      color={active ? colors.accent : colors.textSecondary}
                    />
                    <Text
                      style={{
                        color: active ? colors.accent : colors.text,
                        fontSize: typography.body.fontSize,
                        lineHeight: typography.body.lineHeight,
                        fontWeight: active ? '600' : '400',
                      }}
                    >
                      {k.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* 描述 */}
            <Text style={[labelStyle, { marginTop: spacing[5] }]}>描述（可留空）</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="外观、画风、使用场景等补充说明"
              placeholderTextColor={colors.textSecondary}
              multiline
              testID="asset-edit-desc-input"
              style={{
                ...inputStyle,
                minHeight: typography.body.lineHeight * 3,
                maxHeight: typography.body.lineHeight * 5,
                textAlignVertical: 'top',
              }}
            />

            {/* 参考图 1-4 张 */}
            <Text style={[labelStyle, { marginTop: spacing[5] }]}>
              {`参考图(${images.length}/${ASSET_IMAGE_MAX})`}
            </Text>
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], alignItems: 'center' }}
            >
              {images.map((img, i) => (
                <View key={`${img.filename}-${i}`} testID={`asset-edit-item-${i}`}>
                  <Image
                    source={{ uri: img.previewUri }}
                    testID={`asset-edit-thumb-${i}`}
                    style={{
                      width: 56,
                      height: 56,
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
                    testID={`asset-edit-remove-${i}`}
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

              {images.length < ASSET_IMAGE_MAX ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ busy: uploading }}
                  disabled={uploading}
                  onPress={() => void pick()}
                  testID="asset-edit-pick"
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
                    <ActivityIndicator color={colors.accent} testID="asset-edit-uploading" />
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
                    {uploading ? '上传中…' : images.length === 0 ? '添加参考图' : '再加一张'}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {/* NSFW 开关：仅 R18 上下文（nsfwIntent）渲染，对齐后端 nsfw 可见性门控 */}
            {nsfwIntent ? (
              <View
                style={{ marginTop: spacing[5], flexDirection: 'row', alignItems: 'center' }}
                testID="asset-nsfw-row"
              >
                <View style={{ flex: 1 }}>
                  <Text style={labelStyle}>R18 资产</Text>
                  <Text
                    style={{
                      color: colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                      opacity: 0.8,
                    }}
                  >
                    开启后仅在 NSFW 专区上下文可见
                  </Text>
                </View>
                <Switch value={nsfw} onValueChange={setNsfw} testID="asset-nsfw-switch" />
              </View>
            ) : null}

            {/* 错误人话 */}
            {error ? (
              <Text
                testID="asset-edit-error"
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

            <Button
              title={original ? '保存修改' : '创建资产'}
              onPress={() => void save()}
              loading={saving}
              testID="asset-edit-save"
              style={{ marginTop: spacing[6] }}
            />

            {original ? (
              <Button
                title="删除资产"
                variant="danger"
                onPress={confirmDelete}
                loading={deleting}
                testID="asset-edit-delete"
                style={{ marginTop: spacing[3] }}
              />
            ) : null}
          </ScrollView>
        )}
      </View>
    </Screen>
  );
}
