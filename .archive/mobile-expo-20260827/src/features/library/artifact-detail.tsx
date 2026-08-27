/**
 * 产物详情（指南 4.2 MediaStage 精简版 / 5.3 异步 UX）
 * - 全屏舞台：图像大图 contain / 视频内嵌播放（VideoView 原生控制条）/ 音频·3D 图标占位；多产物底部缩略条切换
 * - 版本链：同根版本横滑条带（>1 个版本时显示），点按经 onSelectVersion 切版本（M7.3）
 * - 参数区：prompt 全文（mono）+ seed/时间/类型
 * - 操作：复用提示词（草稿回填创作屏）/ 重新生成（has_params 作品，seed 策略抽屉）/ 下载（保存相册）/ 存为资产（仅 image 类，M28）/ 删除（二次确认，危险左置）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { buildAssetPrefillParam } from '@/features/assets/asset-prefill';
import { ASSET_UPLOAD_KIND } from '@/features/assets/asset-utils';
import { useAppTheme } from '@/hooks/use-app-theme';
import { deleteJob, fetchVersions, mediaUrl, rerunJob, uploadImage } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { downloadAndSaveToLibrary, downloadToCache } from '@/lib/media';
import { useGenerationDraft } from '@/stores/generation-draft';
import type { JobItem } from '@/types/api';

import { kindLabel, kindToFilter } from './library-utils';
import { RerunSheet } from './rerun-sheet';
import type { RerunSeedMode } from './rerun-sheet';

/** 非图像类的舞台占位图标 */
const GROUP_ICON: Record<string, IconName> = {
  video: 'Film',
  audio: 'Music',
  '3d': 'Box',
};

type DownloadState = 'idle' | 'saving' | 'saved';

/**
 * 视频舞台（expo-video v57：useVideoPlayer + VideoView，原生控制条）
 * 独立子组件挂载点：仅视频类产物渲染，hook 数量随类型恒定的同时避免为空 source 建 player
 */
function VideoStage({ url, testID }: { url: string; testID?: string }) {
  const player = useVideoPlayer(url);
  return (
    <VideoView
      player={player}
      style={{ width: '100%', height: '100%' }}
      contentFit="contain"
      nativeControls
      testID={testID}
    />
  );
}

export interface ArtifactDetailProps {
  /** null = 关闭；内容用最后非空 job 保活，保证淡出动画完整 */
  job: JobItem | null;
  onClose: () => void;
  /** 删除成功后回调（父级清选中态） */
  onDeleted: (jobId: string) => void;
  /** 版本链条带点按：父级切换选中作业（复用同一详情模态） */
  onSelectVersion?: (job: JobItem) => void;
  testID?: string;
}

export function ArtifactDetail({ job, onClose, onDeleted, onSelectVersion, testID }: ArtifactDetailProps) {
  const { colors, spacing, typography, radius } = useAppTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  // 保活最后非空 job，保证淡出动画完整（render 期间调整状态，React 推荐模式，
  // 替代 setState-in-effect：https://react.dev/learn/you-might-not-need-an-effect）
  const [lastJob, setLastJob] = useState<JobItem | null>(job);
  const [index, setIndex] = useState(0);
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [rerunVisible, setRerunVisible] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [assetSaving, setAssetSaving] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);

  if (job && job.id !== lastJob?.id) {
    // 换作业（含切版本）：保活 + 重置产物索引与下载/删除/重生/存资产反馈
    setLastJob(job);
    setIndex(0);
    setDownloadState('idle');
    setDownloadError(null);
    setDeleteError(null);
    setConfirmingDelete(false);
    setRerunVisible(false);
    setRerunError(null);
    setAssetSaving(false);
    setAssetError(null);
  }

  const shown = job ?? lastJob;

  // 版本链：仅在详情打开时拉取（enabled 跟随 visible），与 jobs 缓存互不污染
  const versionKey = shown ? shown.root_id || shown.id : '';
  const versionsQuery = useQuery({
    queryKey: ['versions', versionKey],
    queryFn: () => fetchVersions(versionKey),
    enabled: !!job && !!versionKey,
  });
  const versions = versionsQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (jobId: string) => deleteJob(jobId),
    onSuccess: (_data, jobId) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['versions'] });
      setConfirmingDelete(false);
      onDeleted(jobId);
    },
    onError: (err) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setDeleteError(err instanceof Error ? err.message : '删除失败');
    },
  });

  const rerunMutation = useMutation({
    mutationFn: (mode: RerunSeedMode) => rerunJob(shown?.id ?? '', { seed_mode: mode }),
    onSuccess: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // 新作业已建档入队：作业列表与版本链下次进入即刷新；跳作业屏看进度
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['versions'] });
      setRerunVisible(false);
      onClose();
      router.push('/jobs');
    },
    onError: (err) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setRerunError(err instanceof Error ? err.message : '重新生成失败');
    },
  });

  if (!shown) return null;

  const group = kindToFilter(shown.kind);
  const isImage = group === 'image' || group === null;
  const isVideo = group === 'video';
  const currentPath = shown.results[Math.min(index, shown.results.length - 1)];
  const currentUrl = currentPath ? mediaUrl(currentPath) : '';

  const reuse = () => {
    const prompt = shown.prompt?.trim();
    if (!prompt) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    useGenerationDraft.getState().setDraft({ prompt });
    onClose();
    router.push('/');
  };

  const download = async () => {
    if (downloadState === 'saving' || !currentUrl) return;
    setDownloadState('saving');
    setDownloadError(null);
    try {
      await downloadAndSaveToLibrary(currentUrl);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDownloadState('saved');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setDownloadState('idle');
      setDownloadError(err instanceof Error ? err.message : '下载失败');
    }
  };

  // 存为资产（M28）：下载当前产物到缓存 → uploadImage 换句柄 → 携 prefill 跳资产编辑屏
  const saveAsAsset = async () => {
    if (assetSaving || !currentUrl) return;
    setAssetSaving(true);
    setAssetError(null);
    try {
      const fileUri = await downloadToCache(currentUrl);
      const uploaded = await uploadImage({ uri: fileUri }, ASSET_UPLOAD_KIND);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push({
        pathname: '/assets/edit',
        params: {
          prefill: buildAssetPrefillParam({
            filename: uploaded.filename,
            worker: uploaded.worker,
            preview: currentUrl,
            prompt: shown.prompt,
            nsfw: shown.nsfw,
          }),
        },
      });
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setAssetError(err instanceof Error ? err.message : '存为资产失败');
    } finally {
      setAssetSaving(false);
    }
  };

  return (
    <Modal
      visible={!!job}
      animationType="fade"
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* 顶部栏：关闭 + 类型徽章 */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: insets.top + spacing[2],
            paddingHorizontal: spacing[4],
            paddingBottom: spacing[2],
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            hitSlop={8}
            testID={testID ? `${testID}-close` : undefined}
            style={{
              width: 48,
              height: 48,
              borderRadius: radius.full,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="X" size={24} color={colors.text} />
          </Pressable>

          <View
            style={{
              paddingHorizontal: spacing[3],
              minHeight: 28,
              borderRadius: radius.full,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {kindLabel(shown.kind)}
            </Text>
          </View>
        </View>

        {/* 舞台：图像 contain / 视频内嵌播放 / 音频·3D 图标占位 */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {isVideo && currentUrl ? (
            <VideoStage url={currentUrl} testID={testID ? `${testID}-video` : undefined} />
          ) : isImage && currentUrl ? (
            <Image
              source={{ uri: currentUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="contain"
              transition={200}
              recyclingKey={`${shown.id}:${index}`}
              testID={testID ? `${testID}-image` : undefined}
            />
          ) : (
            <Icon
              name={GROUP_ICON[group ?? ''] ?? 'Image'}
              size={80}
              color={colors.textSecondary}
              testID={testID ? `${testID}-placeholder` : undefined}
            />
          )}
        </View>

        {/* 多产物缩略条 */}
        {shown.results.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0 }}
            contentContainerStyle={{
              gap: spacing[2],
              paddingHorizontal: spacing[4],
              paddingVertical: spacing[2],
            }}
            testID={testID ? `${testID}-thumbs` : undefined}
          >
            {shown.results.map((path, i) => (
              <Pressable
                key={`${shown.id}-${i}`}
                accessibilityRole="button"
                accessibilityLabel={`第 ${i + 1} 张`}
                accessibilityState={{ selected: i === index }}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setIndex(i);
                }}
                testID={testID ? `${testID}-thumb-${i}` : undefined}
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: radius.sm,
                  borderWidth: 2,
                  borderColor: i === index ? colors.accent : colors.border,
                  overflow: 'hidden',
                  backgroundColor: colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isImage ? (
                  <Image
                    source={{ uri: mediaUrl(path) }}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="cover"
                    recyclingKey={`${shown.id}-thumb-${i}`}
                  />
                ) : (
                  <Icon
                    name={GROUP_ICON[group ?? ''] ?? 'Image'}
                    size={20}
                    color={colors.textSecondary}
                  />
                )}
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {/* 版本链条带：同根 >1 版本时显示，点按切换（当前版本 accent 描边） */}
        {versions.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0 }}
            contentContainerStyle={{
              gap: spacing[2],
              paddingHorizontal: spacing[4],
              paddingVertical: spacing[2],
              alignItems: 'center',
            }}
            testID={testID ? `${testID}-versions` : undefined}
          >
            {versions.map((v, i) => {
              const current = v.id === shown.id;
              const vGroup = kindToFilter(v.kind);
              const vThumb =
                (vGroup === 'image' || vGroup === null) && v.status === 'done' && v.results[0]
                  ? mediaUrl(v.results[0])
                  : '';
              return (
                <Pressable
                  key={v.id}
                  accessibilityRole="button"
                  accessibilityLabel={`版本 ${i + 1}`}
                  accessibilityState={{ selected: current }}
                  onPress={() => {
                    if (current) return;
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onSelectVersion?.(v);
                  }}
                  testID={testID ? `${testID}-version-${v.id}` : undefined}
                  style={{
                    width: 56,
                    alignItems: 'center',
                    opacity: current ? 1 : 0.85,
                  }}
                >
                  <View
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: radius.sm,
                      borderWidth: 2,
                      borderColor: current ? colors.accent : colors.border,
                      overflow: 'hidden',
                      backgroundColor: colors.surface,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {vThumb ? (
                      <Image
                        source={{ uri: vThumb }}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="cover"
                        recyclingKey={`ver-${v.id}`}
                      />
                    ) : (
                      <Icon
                        name={
                          v.status === 'error'
                            ? 'CircleAlert'
                            : (GROUP_ICON[vGroup ?? ''] ?? 'Image')
                        }
                        size={20}
                        color={v.status === 'error' ? colors.danger : colors.textSecondary}
                      />
                    )}
                  </View>
                  <Text
                    style={{
                      marginTop: spacing[1] / 2,
                      color: current ? colors.accent : colors.textSecondary,
                      fontSize: typography.caption.fontSize,
                      lineHeight: typography.caption.lineHeight,
                    }}
                  >
                    v{i + 1}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {/* 底部：参数 + 操作 */}
        <View
          style={{
            paddingHorizontal: spacing[4],
            paddingTop: spacing[2],
            paddingBottom: insets.bottom + spacing[3],
          }}
        >
          <Text
            style={{
              color: colors.text,
              fontSize: typography.mono.fontSize,
              lineHeight: typography.mono.lineHeight,
            }}
            numberOfLines={4}
          >
            {shown.prompt}
          </Text>
          <Text
            style={{
              marginTop: spacing[1],
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            seed {shown.seed} · {formatRelativeTime(shown.created_at)}
            {shown.results.length > 1 ? ` · 共 ${shown.results.length} 张` : ''}
          </Text>

          {downloadError ? (
            <Text
              testID={testID ? `${testID}-download-error` : undefined}
              style={{
                marginTop: spacing[2],
                color: colors.danger,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {downloadError}
            </Text>
          ) : null}

          {assetError ? (
            <Text
              testID={testID ? `${testID}-save-asset-error` : undefined}
              style={{
                marginTop: spacing[2],
                color: colors.danger,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {assetError}
            </Text>
          ) : null}

          {/* 操作行：复用（主）+ 下载 + 存为资产（仅 image）+ 删除（危险上移至行尾，二次确认） */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing[3],
              marginTop: spacing[3],
            }}
          >
            <Pressable
              accessibilityRole="button"
              onPress={reuse}
              testID={testID ? `${testID}-reuse` : undefined}
              style={({ pressed }) => ({
                flex: 1,
                height: 48,
                borderRadius: radius.md,
                backgroundColor: colors.accent,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Icon name="Wand2" size={20} color={colors.bg} />
              <Text
                style={{
                  marginLeft: spacing[2],
                  color: colors.bg,
                  fontSize: typography.body.fontSize,
                  lineHeight: typography.body.lineHeight,
                  fontWeight: '600',
                }}
              >
                复用提示词
              </Text>
            </Pressable>

            {/* 重新生成：仅有参数快照的作品可精确重生（旧数据后端 400） */}
            {shown.has_params ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="重新生成"
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setRerunError(null);
                  setRerunVisible(true);
                }}
                testID={testID ? `${testID}-rerun` : undefined}
                style={({ pressed }) => ({
                  width: 48,
                  height: 48,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Icon name="RefreshCw" size={20} color={colors.text} />
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="下载"
              accessibilityState={{ busy: downloadState === 'saving' }}
              disabled={downloadState === 'saving'}
              onPress={download}
              testID={testID ? `${testID}-download` : undefined}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: downloadState === 'saving' ? 0.5 : pressed ? 0.85 : 1,
              })}
            >
              <Icon
                name={downloadState === 'saved' ? 'Check' : 'Download'}
                size={20}
                color={downloadState === 'saved' ? colors.success : colors.text}
              />
            </Pressable>

            {/* 存为资产（M28）：仅 image 类产物（资产卡只收图片），下载 → 上传 → 携 prefill 跳资产编辑屏 */}
            {isImage ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="存为资产"
                accessibilityState={{ busy: assetSaving }}
                disabled={assetSaving}
                onPress={() => void saveAsAsset()}
                testID={testID ? `${testID}-save-asset` : undefined}
                style={({ pressed }) => ({
                  width: 48,
                  height: 48,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: assetSaving ? 0.5 : pressed ? 0.85 : 1,
                })}
              >
                <Icon name="ImagePlus" size={20} color={colors.text} />
              </Pressable>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="删除"
              onPress={() => {
                setDeleteError(null);
                setConfirmingDelete(true);
              }}
              testID={testID ? `${testID}-delete` : undefined}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.danger,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Icon name="Trash2" size={20} color={colors.danger} />
            </Pressable>
          </View>
        </View>

        <ConfirmDialog
          visible={confirmingDelete}
          title="删除这件作品？"
          description="删除后不可恢复，产物文件将由系统另行清理"
          confirmText="删除"
          danger
          loading={deleteMutation.isPending}
          errorMessage={deleteError}
          onConfirm={() => deleteMutation.mutate(shown.id)}
          onCancel={() => setConfirmingDelete(false)}
          testID={testID ? `${testID}-confirm` : undefined}
        />

        <RerunSheet
          visible={rerunVisible}
          submitting={rerunMutation.isPending}
          error={rerunError}
          onConfirm={(mode) => rerunMutation.mutate(mode)}
          onClose={() => setRerunVisible(false)}
          testID={testID ? `${testID}-rerun-sheet` : undefined}
        />
      </View>
    </Modal>
  );
}
