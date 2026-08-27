/**
 * 参考资产库列表屏（M13）
 * - 顶部 kind 过滤 chips（全部/角色/场景/道具/风格，后端 ?kind= 过滤）
 * - 双列卡片（断点同作品库：指南 7.1）：首图缩略 + 名称 + kind 徽标 + 图片数 + R18 徽标
 * - 空态引导新建；下拉刷新；点卡进 /assets/edit 编辑
 * - 多选批量管理（M27）：长按卡片或头部「选择」进入；左上选择圈 + accent 描边；
 *   切桶/下拉刷新清空退出；底部操作条全选/批量删除（确认 Alert → 限速循环单删 →
 *   失败项保留勾选）/取消；后端 ReferenceAsset 无 tags 字段，批量打标不做
 */
import { useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/hooks/use-app-theme';
import { assetImageUrl, deleteAsset, listAssets } from '@/lib/api';
import type { AssetItem, AssetKind } from '@/types/api';

import { runBatchLimited, selectAllIds, summarizeBatch, toggleSelect } from '../library/batch-utils';
import { ASSET_KINDS, assetKindLabel } from './asset-utils';

type KindFilter = AssetKind | 'all';

/** 断点 → 列数（与作品库同源，指南 7.1：phone 2 列 / 大屏 3 列 / 平板 4 列） */
export function assetColumnCount(windowWidth: number): number {
  if (windowWidth >= 768) return 4;
  if (windowWidth >= 431) return 3;
  return 2;
}

function AssetCard({
  asset,
  size,
  onPress,
  onLongPress,
  selecting,
  checked,
  testID,
}: {
  asset: AssetItem;
  size: number;
  onPress: (asset: AssetItem) => void;
  onLongPress: (asset: AssetItem) => void;
  selecting: boolean;
  checked: boolean;
  testID?: string;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const [failed, setFailed] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${assetKindLabel(asset.kind)}资产：${asset.name}`}
      accessibilityState={selecting ? { selected: checked } : undefined}
      onPress={() => onPress(asset)}
      onLongPress={() => onLongPress(asset)}
      delayLongPress={300}
      testID={testID}
      style={({ pressed }) => ({
        width: size,
        borderRadius: radius.lg,
        overflow: 'hidden',
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: checked ? colors.accent : colors.border,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ width: '100%', height: size, alignItems: 'center', justifyContent: 'center' }}>
        {!failed ? (
          <Image
            source={{ uri: assetImageUrl(asset.id, 0) }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={200}
            recyclingKey={asset.id}
            onError={() => setFailed(true)}
            testID={testID ? `${testID}-image` : undefined}
          />
        ) : (
          <Icon
            name="Image"
            size={32}
            color={colors.textSecondary}
            testID={testID ? `${testID}-icon` : undefined}
          />
        )}
        {/* 图片数角标（>1 时，对齐作品库多产物角标样式） */}
        {asset.images.length > 1 ? (
          <View
            testID={testID ? `${testID}-count` : undefined}
            style={{
              position: 'absolute',
              right: spacing[2],
              bottom: spacing[2],
              paddingHorizontal: spacing[2],
              minHeight: 22,
              borderRadius: radius.full,
              backgroundColor: 'rgba(0,0,0,0.55)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              style={{
                color: '#FFFFFF',
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
                fontWeight: '500',
              }}
            >
              ×{asset.images.length}
            </Text>
          </View>
        ) : null}

        {/* M27 选择圈（左上角）：未选空心（半透明底保证图上可见）/ 已选 accent 实心 + Check */}
        {selecting ? (
          <View
            testID={testID ? `${testID}-check` : undefined}
            style={{
              position: 'absolute',
              top: spacing[2],
              left: spacing[2],
              width: 22,
              height: 22,
              borderRadius: radius.full,
              borderWidth: 1.5,
              borderColor: checked ? colors.accent : '#FFFFFF',
              backgroundColor: checked ? colors.accent : 'rgba(0,0,0,0.35)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {checked ? (
              <Icon
                name="Check"
                size={14}
                color="#FFFFFF"
                testID={testID ? `${testID}-check-mark` : undefined}
              />
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={{ padding: spacing[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[1] }}>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: colors.text,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
              fontWeight: '600',
            }}
          >
            {asset.name}
          </Text>
          {/* R18 徽标（对齐 generate-screen 引擎芯片：取主题 warning 色） */}
          {asset.nsfw ? (
            <Text
              testID={testID ? `${testID}-r18` : undefined}
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
            marginTop: spacing[1],
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
          }}
        >
          {assetKindLabel(asset.kind)}
        </Text>
      </View>
    </Pressable>
  );
}

export function AssetsScreen() {
  const { colors, radius, spacing, typography } = useAppTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<KindFilter>('all');

  // M27 多选模式：选择集 Set<id>；batch 非空 = 批量删除进行中（操作条与卡片交互冻结）
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [batchSummary, setBatchSummary] = useState<string | null>(null);

  const assetsQuery = useQuery({
    // kind 进 key：服务端过滤（routes/reference_assets.py ?kind=），各桶独立缓存
    queryKey: ['assets', 'list', filter],
    queryFn: () => listAssets(filter === 'all' ? undefined : filter),
  });
  const assets = assetsQuery.data ?? [];

  const windowWidth = Dimensions.get('window').width;
  const columns = assetColumnCount(windowWidth);
  const gap = spacing[3];
  const cardSize = (windowWidth - spacing[4] * 2 - gap * (columns - 1)) / columns;

  const openEdit = (asset: AssetItem) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/assets/edit', params: { id: asset.id } });
  };
  const openCreate = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/assets/edit');
  };

  // ── M27 多选模式与批量删除 ──

  /** 退出多选并清空选择集（取消/切桶/刷新/操作完成共用） */
  const exitSelecting = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };

  /** 进入多选：清空既有选择集（防上次残留勾选指向已变化数据） */
  const enterSelecting = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBatchSummary(null);
    setSelectedIds(new Set());
    setSelecting(true);
  };

  /** 选择模式下点按 = 切换勾选；非选择模式 = 进编辑；批量进行中冻结 */
  const pressCard = (asset: AssetItem) => {
    if (batch) return;
    if (selecting) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setSelectedIds((prev) => toggleSelect(prev, asset.id));
    } else {
      openEdit(asset);
    }
  };

  /** 长按直接进入多选并选中该卡（已选则取消勾选） */
  const longPressCard = (asset: AssetItem) => {
    if (batch) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBatchSummary(null);
    setSelecting(true);
    setSelectedIds((prev) => toggleSelect(prev, asset.id));
  };

  /** 全选：当前列表全部项 */
  const selectAll = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedIds(selectAllIds(assets));
  };

  /** 批量删除：确认 Alert（不可恢复，worker 文件保留）→ 限速循环单删 → 失败项保留勾选 → 失效重取 */
  const confirmBatchDelete = () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || batch) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert(
      '删除资产',
      `删除 ${ids.length} 项资产？删除后不可恢复（worker 上的图片文件保留）。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => void runBatchDelete(ids) },
      ],
    );
  };

  const runBatchDelete = async (ids: string[]) => {
    setBatchSummary(null);
    setBatch({ done: 0, total: ids.length });
    const result = await runBatchLimited(ids, deleteAsset, {
      onProgress: (done, total) => setBatch({ done, total }),
    });
    setBatch(null);
    await queryClient.invalidateQueries({ queryKey: ['assets'] });
    setBatchSummary(
      summarizeBatch({
        action: 'delete',
        succeeded: result.succeeded.length,
        failed: result.failed.length,
      }),
    );
    // 成功项移出选择集，失败项保留勾选便于重试；无剩余勾选则退出多选
    setSelectedIds(new Set(result.failed));
    if (result.failed.length === 0) setSelecting(false);
  };

  return (
    <Screen testID="screen-assets">
      <View style={{ flex: 1, paddingHorizontal: spacing[4] }}>
        {/* 头部：返回 + 标题 + 新建 */}
        <View
          style={{
            marginTop: spacing[2],
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回"
            onPress={() => router.back()}
            hitSlop={8}
            testID="assets-back"
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="ChevronLeft" size={24} color={colors.text} />
          </Pressable>
          <Text
            style={{
              color: colors.text,
              fontSize: typography.heading.fontSize,
              lineHeight: typography.heading.lineHeight,
              fontWeight: '700',
            }}
          >
            参考资产库
          </Text>
          {/* M27：常态右侧 = 新建 + 选择入口；选择态隐藏（退出靠操作条「取消」，对齐作品库） */}
          {!selecting ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="新建资产"
                onPress={openCreate}
                hitSlop={8}
                testID="assets-new"
                style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="Plus" size={24} color={colors.accent} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={enterSelecting}
                hitSlop={8}
                testID="assets-select-toggle"
                style={({ pressed }) => ({
                  minHeight: 36,
                  paddingHorizontal: spacing[3],
                  borderRadius: radius.full,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text
                  style={{
                    color: colors.text,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                    fontWeight: '500',
                  }}
                >
                  选择
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        {/* kind 过滤 chips（全部/角色/场景/道具/风格） */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginTop: spacing[2], marginBottom: spacing[3] }}
          contentContainerStyle={{ gap: spacing[2] }}
          testID="asset-filters"
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
                  // M27：切桶数据基准变化，清空选择并退出多选（对齐作品库）
                  exitSelecting();
                  setBatchSummary(null);
                  setFilter(f.key);
                }}
                testID={`asset-filter-${f.key}`}
                style={{
                  minHeight: 36,
                  paddingHorizontal: spacing[3],
                  borderRadius: radius.full,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accentSoft : colors.surface,
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

        {/* M27 批量汇总（内联人话；选择模式内外均可见，下次操作/切桶/刷新清除） */}
        {batchSummary ? (
          <Text
            testID="assets-batch-summary"
            style={{
              marginBottom: spacing[2],
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {batchSummary}
          </Text>
        ) : null}

        {assetsQuery.isPending ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.accent} testID="assets-loading" />
          </View>
        ) : assets.length === 0 ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              icon="Layers"
              title={filter === 'all' ? '还没有参考资产' : '该分类暂无资产'}
              description={
                filter === 'all'
                  ? '把常用角色 / 场景 / 道具 / 风格图存进来，创作时一键引用'
                  : '换个分类看看，或新建一件资产'
              }
              actionTitle={filter === 'all' ? '新建资产' : undefined}
              onAction={filter === 'all' ? openCreate : undefined}
              testID="empty-assets"
            />
          </View>
        ) : (
          <FlatList
            key={columns}
            data={assets}
            numColumns={columns}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <AssetCard
                asset={item}
                size={cardSize}
                onPress={pressCard}
                onLongPress={longPressCard}
                selecting={selecting}
                checked={selectedIds.has(item.id)}
                testID={`asset-card-${item.id}`}
              />
            )}
            columnWrapperStyle={columns > 1 ? { gap } : undefined}
            contentContainerStyle={{ gap, paddingBottom: spacing[4] }}
            showsVerticalScrollIndicator={false}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews
            refreshControl={
              <RefreshControl
                refreshing={assetsQuery.isRefetching}
                onRefresh={() => {
                  // M27：数据基准变化即清空选择并退出多选（防勾选指向已不可见项）
                  exitSelecting();
                  setBatchSummary(null);
                  void assetsQuery.refetch();
                }}
                tintColor={colors.accent}
              />
            }
            testID="assets-grid"
          />
        )}
      </View>

      {/* M27 底部操作条：已选计数/全选 + 删除/取消（Screen 底边 SafeArea 已避让） */}
      {selecting ? (
        <View
          testID="assets-batch-bar"
          style={{
            borderTopWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
            paddingHorizontal: spacing[4],
            paddingTop: spacing[2],
            paddingBottom: spacing[3],
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text
              style={{
                color: colors.text,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
                fontWeight: '600',
                fontVariant: ['tabular-nums'],
              }}
            >
              {batch ? `删除中 ${batch.done}/${batch.total}` : `已选 ${selectedIds.size} 项`}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !!batch }}
              disabled={!!batch}
              onPress={selectAll}
              hitSlop={8}
              testID="assets-batch-select-all"
              style={({ pressed }) => ({
                minHeight: 36,
                paddingHorizontal: spacing[2],
                alignItems: 'center',
                justifyContent: 'center',
                opacity: batch ? 0.5 : pressed ? 0.85 : 1,
              })}
            >
              <Text
                style={{
                  color: colors.accent,
                  fontSize: typography.body.fontSize,
                  lineHeight: typography.body.lineHeight,
                  fontWeight: '500',
                }}
              >
                全选
              </Text>
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', gap: spacing[2], marginTop: spacing[2] }}>
            <Button
              title="删除"
              variant="danger"
              size="sub"
              disabled={!!batch || selectedIds.size === 0}
              onPress={confirmBatchDelete}
              testID="assets-batch-delete"
              style={{ flex: 1 }}
            />
            <Button
              title="取消"
              variant="secondary"
              size="sub"
              disabled={!!batch}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                exitSelecting();
              }}
              testID="assets-batch-cancel"
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : null}
    </Screen>
  );
}
