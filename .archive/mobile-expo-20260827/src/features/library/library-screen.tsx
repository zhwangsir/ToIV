/**
 * 作品库屏（指南 4.2 GalleryGrid / 7.1 断点）
 * - 双列等宽网格（431-767 三列 / ≥768 四列），1:1 缩略，视觉对称
 * - 无限分页（M15，契约已读 jobs.py list_jobs）：offset 分页 + onEndReached 追加，
 *   按 id 去重；下拉刷新重置 offset=0 重拉
 * - 类型过滤 chips（M16 服务端 kind 过滤）：切换过滤桶时重置分页，按 kind 参数
 *   请求服务端过滤后数据（不再依赖客户端过滤已加载前缀）
 * - 点按进全屏详情（复用/下载/删除）；空态区分「无作品」与「该分类暂无作品」
 * - 多选批量管理（M25）：长按卡片或页头「选择」进入；选择集跨分页保持（Set<id>），
 *   切桶/下拉刷新清空退出；底部操作条全选（已加载拍平项）/批量删除（确认 Alert →
 *   限速循环单删 → 失败项保留勾选）/批量保存相册（image/video 走下载封装，audio/3D 跳过）
 */
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/hooks/use-app-theme';
import { deleteJob, listJobs, mediaUrl } from '@/lib/api';
import { downloadAndSaveToLibrary } from '@/lib/media';
import type { JobItem } from '@/types/api';

import { ArtifactDetail } from './artifact-detail';
import {
  runBatchLimited,
  selectAllIds,
  splitSavable,
  summarizeBatch,
  toggleSelect,
} from './batch-utils';
import {
  firstPageOnly,
  LIBRARY_PAGE_SIZE,
  mergePagesUnique,
  nextOffset,
  pageHasMore,
} from './library-paging';
import { FILTERS, kindLabel, kindToFilter } from './library-utils';
import type { FilterKey } from './library-utils';

const GROUP_ICON: Record<string, IconName> = {
  video: 'Film',
  audio: 'Music',
  '3d': 'Box',
};

/** 断点 → 列数（指南 7.1：phone 2 列 / 大屏 3 列 / 平板 4 列） */
export function columnCount(windowWidth: number): number {
  if (windowWidth >= 768) return 4;
  if (windowWidth >= 431) return 3;
  return 2;
}

/** 作品库只收藏完成且有产物的作业 */
export function collectArtifacts(jobs: JobItem[] | undefined): JobItem[] {
  return (jobs ?? []).filter((j) => j.status === 'done' && j.results.length > 0);
}

/** 过滤桶 → 服务端 kind 参数（逗号分隔多值） */
function filterToKind(f: FilterKey): string {
  if (f === 'all') return '';
  const def = FILTERS.find((d) => d.key === f);
  return def ? def.kinds.join(',') : '';
}

function LibraryCard({
  job,
  size,
  onPress,
  onLongPress,
  selecting,
  checked,
  testID,
}: {
  job: JobItem;
  size: number;
  onPress: (job: JobItem) => void;
  onLongPress: (job: JobItem) => void;
  selecting: boolean;
  checked: boolean;
  testID?: string;
}) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const [failed, setFailed] = useState(false);
  const group = kindToFilter(job.kind);
  const showImage = (group === 'image' || group === null) && !failed;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${kindLabel(job.kind)}作品：${job.prompt}`}
      accessibilityState={selecting ? { selected: checked } : undefined}
      onPress={() => onPress(job)}
      onLongPress={() => onLongPress(job)}
      delayLongPress={300}
      testID={testID}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: radius.lg,
        overflow: 'hidden',
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: checked ? colors.accent : colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {showImage ? (
        <Image
          source={{ uri: mediaUrl(job.results[0]) }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          recyclingKey={job.id}
          onError={() => setFailed(true)}
          testID={testID ? `${testID}-image` : undefined}
        />
      ) : (
        <Icon
          name={GROUP_ICON[group ?? ''] ?? 'Image'}
          size={32}
          color={colors.textSecondary}
          testID={testID ? `${testID}-icon` : undefined}
        />
      )}

      {/* 多产物角标 */}
      {job.results.length > 1 ? (
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
            ×{job.results.length}
          </Text>
        </View>
      ) : null}

      {/* M25 选择圈：未选空心（半透明底保证图上可见）/ 已选 accent 实心 + Check */}
      {selecting ? (
        <View
          testID={testID ? `${testID}-check` : undefined}
          style={{
            position: 'absolute',
            top: spacing[2],
            right: spacing[2],
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
    </Pressable>
  );
}

export function LibraryScreen() {
  const { colors, spacing, typography, radius } = useAppTheme();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [selected, setSelected] = useState<JobItem | null>(null);

  // M25 多选模式：选择集跨分页保持（Set<id>）；batch 非空 = 批量进行中（操作条冻结）
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [batch, setBatch] = useState<{ kind: 'delete' | 'save'; done: number; total: number } | null>(
    null,
  );
  const [batchSummary, setBatchSummary] = useState<string | null>(null);

  // 过滤桶 → kind 参数（服务端过滤）
  const kindParam = filterToKind(filter);

  const jobsQuery = useInfiniteQuery({
    // 独立 key：与作业屏 limit 50 的 ['jobs'] 区分，避免同 key 不同参数互相覆盖缓存
    // 删除/新完成作业失效用前缀 ['jobs'] 可模糊命中本 key，驱动逐页重取
    // M16：kind 参数纳入 queryKey，切换过滤桶时自动重新查询
    queryKey: ['jobs', 'library', kindParam],
    queryFn: ({ pageParam }) =>
      listJobs({ limit: LIBRARY_PAGE_SIZE, offset: pageParam, kind: kindParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      pageHasMore(lastPage.length, LIBRARY_PAGE_SIZE)
        ? nextOffset(allPages.length, LIBRARY_PAGE_SIZE)
        : undefined,
  });

  // 按 id 去重合并：offset 分页页边界随顶部新作插入漂移，追加/失效重取都可能带回重叠行
  const jobs = useMemo(() => mergePagesUnique(jobsQuery.data?.pages ?? []), [jobsQuery.data]);

  const artifacts = useMemo(() => collectArtifacts(jobs), [jobs]);

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: artifacts.length, image: 0, video: 0, audio: 0, '3d': 0 };
    for (const j of artifacts) {
      const key = kindToFilter(j.kind);
      if (key) c[key] += 1;
    }
    return c;
  }, [artifacts]);

  /**
   * 防重入：ref 锁同步生效。isFetchingNextPage 经 TanStack notifyManager 异步派发，
   * 同一帧内连续 onEndReached 时组件闭包仍是旧值，仅靠状态判断会重复发请求。
   */
  const loadMoreLock = useRef(false);
  const loadMore = () => {
    if (loadMoreLock.current) return;
    if (!jobsQuery.hasNextPage || jobsQuery.isFetchingNextPage || jobsQuery.isRefetching) return;
    loadMoreLock.current = true;
    // fetchNextPage 返回的 promise 不 reject（错误进结果态），finally 释放锁即可
    void jobsQuery.fetchNextPage().finally(() => {
      loadMoreLock.current = false;
    });
  };

  /** 下拉刷新：截断到首页后重取（refetch 按 pageParams 逐页进行）→ 等效 offset=0 重拉并重算 hasMore */
  const refresh = async () => {
    // M25：数据基准变化即清空选择并退出多选（防勾选指向已不可见项）
    exitSelecting();
    setBatchSummary(null);
    queryClient.setQueryData<InfiniteData<JobItem[], number>>(['jobs', 'library', kindParam], (old) =>
      old ? firstPageOnly(old) : old,
    );
    await jobsQuery.refetch();
  };

  // ── M25 多选模式与批量操作 ──

  /** 退出多选并清空选择集（取消/切桶/刷新/操作完成共用） */
  const exitSelecting = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };

  const enterSelecting = () => {
    setBatchSummary(null);
    setSelecting(true);
  };

  /** 选择模式下点按 = 切换勾选；非选择模式 = 打开详情；批量进行中冻结 */
  const pressCard = (job: JobItem) => {
    if (batch) return;
    if (selecting) setSelectedIds((prev) => toggleSelect(prev, job.id));
    else setSelected(job);
  };

  /** 长按直接进入多选并选中该卡（已选则取消勾选） */
  const longPressCard = (job: JobItem) => {
    if (batch) return;
    setBatchSummary(null);
    setSelecting(true);
    setSelectedIds((prev) => toggleSelect(prev, job.id));
  };

  /** 全选：当前已加载 pages 拍平项 */
  const selectAll = () => {
    setSelectedIds(selectAllIds(artifacts));
  };

  /** 批量删除：确认 Alert（不可恢复）→ 限速循环单删 → 失败项保留勾选 → 失效重取 */
  const confirmBatchDelete = () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || batch) return;
    Alert.alert('删除作品', `删除 ${ids.length} 项作品？删除后不可恢复。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void runBatchDelete(ids) },
    ]);
  };

  const runBatchDelete = async (ids: string[]) => {
    setBatchSummary(null);
    setBatch({ kind: 'delete', done: 0, total: ids.length });
    const result = await runBatchLimited(ids, deleteJob, {
      onProgress: (done, total) => setBatch({ kind: 'delete', done, total }),
    });
    setBatch(null);
    await queryClient.invalidateQueries({ queryKey: ['jobs'] });
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

  /** 批量保存相册：image/video 走既有下载封装循环；audio/3D 跳过计入汇总并保留勾选 */
  const runBatchSave = async () => {
    if (batch) return;
    const chosen = artifacts.filter((j) => selectedIds.has(j.id));
    const { savable, skipped } = splitSavable(chosen);
    if (savable.length === 0) {
      setBatchSummary(summarizeBatch({ action: 'save', succeeded: 0, failed: 0, skipped }));
      return;
    }
    // 每项保存首个产物（对齐详情页下载当前产物语义），URL 拼 token
    const urlOf = new Map(savable.map((j) => [j.id, mediaUrl(j.results[0])]));
    setBatchSummary(null);
    setBatch({ kind: 'save', done: 0, total: savable.length });
    const result = await runBatchLimited(
      savable.map((j) => j.id),
      (id) => downloadAndSaveToLibrary(urlOf.get(id) ?? ''),
      { onProgress: (done, total) => setBatch({ kind: 'save', done, total }) },
    );
    setBatch(null);
    setBatchSummary(
      summarizeBatch({
        action: 'save',
        succeeded: result.succeeded.length,
        failed: result.failed.length,
        skipped,
      }),
    );
    // 成功项移出选择集；失败/跳过项保留勾选；无剩余则退出多选
    const remaining = new Set(selectedIds);
    for (const id of result.succeeded) remaining.delete(id);
    setSelectedIds(remaining);
    if (remaining.size === 0) setSelecting(false);
  };

  const windowWidth = Dimensions.get('window').width;
  const columns = columnCount(windowWidth);
  const gap = spacing[3];
  const cardSize = (windowWidth - spacing[4] * 2 - gap * (columns - 1)) / columns;

  // 空态语义：服务端已过滤，流为空即该条件下无作品
  const emptyTitle = filter === 'all' ? '还没有作品' : '该分类暂无作品';
  const emptyDescription =
    filter === 'all'
      ? '完成的图片与视频会收藏在这里'
      : '该分类下暂无作品，换个分类看看';

  const firstLoadError = jobsQuery.isError && jobs.length === 0;
  // 有数据或还在加载/有更多时显示网格
  const showGrid = artifacts.length > 0 || jobsQuery.isPending || jobsQuery.hasNextPage;

  const listFooter = jobsQuery.isFetchingNextPage ? (
    <View
      style={{ paddingVertical: spacing[4], alignItems: 'center' }}
      testID="library-footer-loading"
    >
      <ActivityIndicator color={colors.accent} />
    </View>
  ) : jobsQuery.isFetchNextPageError ? (
    <Text
      testID="library-footer-error"
      style={{
        paddingVertical: spacing[4],
        textAlign: 'center',
        color: colors.danger,
        fontSize: typography.caption.fontSize,
        lineHeight: typography.caption.lineHeight,
      }}
    >
      加载失败，上拉重试
    </Text>
  ) : !jobsQuery.hasNextPage ? (
    <Text
      testID="library-footer-end"
      style={{
        paddingVertical: spacing[4],
        textAlign: 'center',
        color: colors.textSecondary,
        fontSize: typography.caption.fontSize,
        lineHeight: typography.caption.lineHeight,
      }}
    >
      没有更多了
    </Text>
  ) : null;

  return (
    <Screen testID="screen-library">
      <View style={{ flex: 1, paddingHorizontal: spacing[4] }}>
        <View
          style={{
            marginTop: spacing[4],
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text
            style={{
              color: colors.text,
              fontSize: typography.title.fontSize,
              lineHeight: typography.title.lineHeight,
              fontWeight: '700',
              letterSpacing: typography.title.letterSpacing,
            }}
          >
            作品库
          </Text>
          {/* M25：多选入口（选择模式下由操作条「取消」退出，入口隐藏） */}
          {!selecting ? (
            <Pressable
              accessibilityRole="button"
              onPress={enterSelecting}
              hitSlop={8}
              testID="library-select-toggle"
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
          ) : null}
        </View>

        {/* 类型过滤 chips（计数为当前过滤条件下的作品数） */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginTop: spacing[3], marginBottom: spacing[3] }}
          contentContainerStyle={{ gap: spacing[2] }}
          testID="library-filters"
        >
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <Pressable
                key={f.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  // M25：切桶数据基准变化，清空选择并退出多选
                  exitSelecting();
                  setBatchSummary(null);
                  setFilter(f.key);
                }}
                testID={`filter-${f.key}`}
                style={{
                  minHeight: 36,
                  paddingHorizontal: spacing[3],
                  borderRadius: radius.full,
                  borderWidth: 1,
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accentSoft : colors.surface,
                  flexDirection: 'row',
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
                <Text
                  style={{
                    marginLeft: spacing[1],
                    color: active ? colors.accent : colors.textSecondary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {counts[f.key]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* M25 批量汇总（内联人话；选择模式内外均可见，下次操作/切桶/刷新清除） */}
        {batchSummary ? (
          <Text
            testID="library-batch-summary"
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

        {jobsQuery.isPending ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.accent} testID="library-loading" />
          </View>
        ) : firstLoadError ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              icon="WifiOff"
              title="作品库加载失败"
              description="检查网络后重试"
              actionTitle="重试"
              onAction={() => void jobsQuery.refetch()}
              testID="library-error"
            />
          </View>
        ) : showGrid ? (
          <FlatList
            key={columns}
            data={artifacts}
            numColumns={columns}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <LibraryCard
                job={item}
                size={cardSize}
                onPress={pressCard}
                onLongPress={longPressCard}
                selecting={selecting}
                checked={selectedIds.has(item.id)}
                testID={`library-card-${item.id}`}
              />
            )}
            ListEmptyComponent={
              <EmptyState
                icon="Images"
                title={emptyTitle}
                description={emptyDescription}
                testID="empty-library"
              />
            }
            ListFooterComponent={listFooter}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            columnWrapperStyle={columns > 1 ? { gap } : undefined}
            contentContainerStyle={{ gap, paddingBottom: spacing[4] }}
            showsVerticalScrollIndicator={false}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews
            refreshControl={
              <RefreshControl
                refreshing={jobsQuery.isRefetching}
                onRefresh={() => void refresh()}
                tintColor={colors.accent}
              />
            }
            testID="library-grid"
          />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              icon="Images"
              title={emptyTitle}
              description={emptyDescription}
              testID="empty-library"
            />
          </View>
        )}
      </View>

      {/* M25 底部操作条：已选计数/全选 + 保存/删除/取消（Screen 底边 SafeArea 已避让） */}
      {selecting ? (
        <View
          testID="library-batch-bar"
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
              {batch
                ? `${batch.kind === 'delete' ? '删除中' : '保存中'} ${batch.done}/${batch.total}`
                : `已选 ${selectedIds.size} 项`}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !!batch }}
              disabled={!!batch}
              onPress={selectAll}
              hitSlop={8}
              testID="library-batch-select-all"
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
              title="保存"
              variant="secondary"
              size="sub"
              disabled={!!batch || selectedIds.size === 0}
              onPress={() => void runBatchSave()}
              testID="library-batch-save"
              style={{ flex: 1 }}
            />
            <Button
              title="删除"
              variant="danger"
              size="sub"
              disabled={!!batch || selectedIds.size === 0}
              onPress={confirmBatchDelete}
              testID="library-batch-delete"
              style={{ flex: 1 }}
            />
            <Button
              title="取消"
              variant="secondary"
              size="sub"
              disabled={!!batch}
              onPress={exitSelecting}
              testID="library-batch-cancel"
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : null}

      <ArtifactDetail
        job={selected}
        onClose={() => setSelected(null)}
        onDeleted={() => setSelected(null)}
        onSelectVersion={setSelected}
        testID="artifact-detail"
      />
    </Screen>
  );
}
