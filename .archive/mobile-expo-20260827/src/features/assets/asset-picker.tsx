/**
 * 资产选择器（M13.3 创作页引用入口）
 * - Modal 底部抽屉：kind 过滤 chips → 资产行 → 展开该资产 1-4 张图 → 点选回填
 * - 回填 {filename, worker} 句柄（不重新上传）；previewUri 用 assetImageUrl 远程缩略（视为已上传完成态）
 * - 与列表屏共用 ['assets','list',kind] 查询缓存；nsfw 资产可见性由后端按 X-NSFW 上下文过滤
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { assetImageUrl, listAssets } from '@/lib/api';
import type { AssetItem, AssetKind, UploadedRefImage } from '@/types/api';

import { ASSET_KINDS, assetKindLabel } from './asset-utils';

type KindFilter = AssetKind | 'all';

export interface AssetPickerProps {
  visible: boolean;
  onClose: () => void;
  /** 点选某张资产图：句柄 + 远程预览，直接进表单值（不再走 uploadImage） */
  onSelect: (image: UploadedRefImage) => void;
  testID?: string;
}

export function AssetPicker({ visible, onClose, onSelect, testID = 'asset-picker' }: AssetPickerProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [filter, setFilter] = useState<KindFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const assetsQuery = useQuery({
    queryKey: ['assets', 'list', filter],
    queryFn: () => listAssets(filter === 'all' ? undefined : filter),
    // 抽屉关闭期间不后台轮询；打开时命中列表屏缓存
    enabled: visible,
  });
  const assets = assetsQuery.data ?? [];

  const pickImage = (asset: AssetItem, index: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const img = asset.images[index];
    onSelect({
      filename: img.filename,
      worker: img.worker,
      previewUri: assetImageUrl(asset.id, index),
      name: `${asset.name} · 图${index + 1}`,
    });
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="关闭资产选择器"
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
        {/* 拖拽柄 */}
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
            从资产库选择
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            hitSlop={8}
            testID={`${testID}-close`}
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="X" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>

        {/* kind 过滤 chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginBottom: spacing[3] }}
          contentContainerStyle={{ gap: spacing[2] }}
          testID={`${testID}-filters`}
        >
          {[{ key: 'all' as const, label: '全部' }, ...ASSET_KINDS].map((f) => {
            const active = f.key === filter;
            return (
              <Pressable
                key={f.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={f.label}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setFilter(f.key);
                }}
                testID={`${testID}-filter-${f.key}`}
                style={{
                  minHeight: 36,
                  paddingHorizontal: spacing[3],
                  borderRadius: radius.full,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accentSoft : colors.bg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    color: active ? colors.accent : colors.textSecondary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                    fontWeight: active ? '600' : '400',
                  }}
                >
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {assetsQuery.isPending ? (
          <View style={{ alignItems: 'center', paddingVertical: spacing[8] }}>
            <ActivityIndicator color={colors.accent} testID={`${testID}-loading`} />
          </View>
        ) : assets.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: spacing[8] }} testID={`${testID}-empty`}>
            <Icon name="Layers" size={24} color={colors.textSecondary} />
            <Text
              style={{
                marginTop: spacing[2],
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {filter === 'all' ? '资产库为空，先去「我的 → 参考资产库」新建' : '该分类暂无资产'}
            </Text>
          </View>
        ) : (
          <FlatList
            data={assets}
            keyExtractor={(item) => item.id}
            showsVerticalScrollIndicator={false}
            style={{ flexGrow: 0 }}
            renderItem={({ item }) => {
              const expanded = item.id === expandedId;
              return (
                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: colors.border,
                    paddingVertical: spacing[2],
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    accessibilityLabel={`${assetKindLabel(item.kind)}资产：${item.name}`}
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setExpandedId(expanded ? null : item.id);
                    }}
                    testID={`${testID}-asset-${item.id}`}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[3], minHeight: 48 }}
                  >
                    <Image
                      source={{ uri: assetImageUrl(item.id, 0) }}
                      style={{ width: 40, height: 40, borderRadius: radius.sm }}
                      contentFit="cover"
                      transition={200}
                      recyclingKey={item.id}
                      testID={`${testID}-asset-${item.id}-thumb`}
                    />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[1] }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            color: colors.text,
                            fontSize: typography.body.fontSize,
                            lineHeight: typography.body.lineHeight,
                            fontWeight: '500',
                            flexShrink: 1,
                          }}
                        >
                          {item.name}
                        </Text>
                        {item.nsfw ? (
                          <Text
                            testID={`${testID}-asset-${item.id}-r18`}
                            style={{
                              color: colors.warning,
                              fontSize: typography.caption.fontSize - 2,
                              lineHeight: typography.caption.lineHeight,
                              fontWeight: '700',
                            }}
                          >
                            R18
                          </Text>
                        ) : null}
                      </View>
                      <Text
                        style={{
                          color: colors.textSecondary,
                          fontSize: typography.caption.fontSize,
                          lineHeight: typography.caption.lineHeight,
                        }}
                      >
                        {`${assetKindLabel(item.kind)} · ${item.images.length} 张`}
                      </Text>
                    </View>
                    <Icon
                      name={expanded ? 'ChevronUp' : 'ChevronDown'}
                      size={18}
                      color={colors.textSecondary}
                    />
                  </Pressable>

                  {/* 展开：该资产 1-4 张图，点选回填 */}
                  {expanded ? (
                    <View
                      style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        gap: spacing[2],
                        paddingTop: spacing[2],
                        paddingLeft: 40 + spacing[3],
                      }}
                    >
                      {item.images.map((img, idx) => (
                        <Pressable
                          key={`${img.filename}-${idx}`}
                          accessibilityRole="button"
                          accessibilityLabel={`选择 ${item.name} 第 ${idx + 1} 张`}
                          onPress={() => pickImage(item, idx)}
                          testID={`${testID}-image-${item.id}-${idx}`}
                          style={({ pressed }) => ({
                            borderRadius: radius.sm,
                            borderWidth: 1,
                            borderColor: colors.border,
                            overflow: 'hidden',
                            opacity: pressed ? 0.85 : 1,
                          })}
                        >
                          <Image
                            source={{ uri: assetImageUrl(item.id, idx) }}
                            style={{ width: 64, height: 64 }}
                            contentFit="cover"
                            transition={200}
                            recyclingKey={`${item.id}-${idx}`}
                          />
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}
