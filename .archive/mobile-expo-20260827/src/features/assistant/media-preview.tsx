/**
 * 媒体产物全屏预览（M24）：消息气泡图片/视频点开查看
 * - Modal fade + 深色遮罩全屏；图片页点按关闭（手势），右上 X 与系统返回键同效
 * - 图片：FlatList pagingEnabled 多图左右翻页（contain 防裁切）；视频：expo-video v57
 *   useVideoPlayer + VideoView 原生控制条（与产物详情 VideoStage 同式，读 v57 官方文档确认用法）
 * - 「保存到相册」复用 lib/media.ts downloadAndSaveToLibrary（下载 cache → 入册），
 *   saving/saved/失败人话内联三态（对齐 artifact-detail 下载语义）
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';

import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { mediaUrl } from '@/lib/api';
import { downloadAndSaveToLibrary } from '@/lib/media';

/** 预览目标：一组同类媒体 + 初始页（图片多 url 翻页；视频逐条播放） */
export interface MediaPreviewTarget {
  type: 'image' | 'video';
  urls: string[];
  index: number;
}

type SaveState = 'idle' | 'saving' | 'saved';

/**
 * 视频页（独立挂载点：仅视频页渲染时建 player，关闭预览即随卸载释放）
 */
function PreviewVideo({ url, testID }: { url: string; testID?: string }) {
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

export interface MediaPreviewProps {
  /** null = 关闭；内容用最后非空 target 保活，保证淡出动画完整（对齐 artifact-detail） */
  target: MediaPreviewTarget | null;
  onClose: () => void;
  testID?: string;
}

export function MediaPreview({ target, onClose, testID = 'media-preview' }: MediaPreviewProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const [lastTarget, setLastTarget] = useState<MediaPreviewTarget | null>(target);
  // openIndex：打开时的初始页（FlatList initialScrollIndex）；index：当前停留页（翻页驱动）
  const [openIndex, setOpenIndex] = useState(0);
  const [index, setIndex] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  if (target && target !== lastTarget) {
    // 新一次打开：保活 + 重置初始页/保存反馈（渲染期调整，React 推荐模式）
    setLastTarget(target);
    setOpenIndex(target.index);
    setIndex(target.index);
    setSaveState('idle');
    setSaveError(null);
  }

  const shown = target ?? lastTarget;
  if (!shown) return null;

  const currentPath = shown.urls[Math.min(index, shown.urls.length - 1)];
  const currentUrl = currentPath ? mediaUrl(currentPath) : '';

  const save = async (): Promise<void> => {
    if (saveState === 'saving' || !currentUrl) return;
    setSaveState('saving');
    setSaveError(null);
    try {
      await downloadAndSaveToLibrary(currentUrl);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSaveState('saved');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSaveState('idle');
      setSaveError(err instanceof Error ? err.message : '下载失败');
    }
  };

  return (
    <Modal visible={!!target} transparent animationType="fade" onRequestClose={onClose} testID={testID}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.96)' }}>
        {/* 舞台：全屏分页（图片页点按关闭；视频页让位原生控制条手势，仅 X/返回键关闭） */}
        <FlatList
          // 每次新打开强制重挂载，initialScrollIndex 才生效（同 urls 再开不同页亦然）
          key={`${shown.type}:${shown.urls.join('|')}:${openIndex}`}
          data={shown.urls}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={openIndex}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          onMomentumScrollEnd={(e) => {
            const next = Math.round(e.nativeEvent.contentOffset.x / width);
            setIndex(Math.max(0, Math.min(next, shown.urls.length - 1)));
          }}
          keyExtractor={(u, i) => `${i}-${u}`}
          renderItem={({ item: u, index: i }) => (
            <View style={{ width, height }}>
              {shown.type === 'image' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭预览"
                  onPress={onClose}
                  style={{ flex: 1 }}
                >
                  <Image
                    source={{ uri: mediaUrl(u) }}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="contain"
                    transition={200}
                    recyclingKey={`${shown.type}-${i}-${u}`}
                    testID={`${testID}-image-${i}`}
                  />
                </Pressable>
              ) : (
                <PreviewVideo url={mediaUrl(u)} testID={`${testID}-video-${i}`} />
              )}
            </View>
          )}
          testID={`${testID}-pager`}
        />

        {/* 顶栏：页码（多产物时）+ 关闭（SafeArea 避让） */}
        <View
          style={{
            position: 'absolute',
            top: insets.top + spacing[2],
            left: spacing[4],
            right: spacing[4],
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {shown.urls.length > 1 ? (
            <View
              testID={`${testID}-counter`}
              style={{
                paddingHorizontal: spacing[3],
                paddingVertical: spacing[1],
                borderRadius: radius.full,
                backgroundColor: 'rgba(0,0,0,0.45)',
              }}
            >
              <Text
                style={{
                  color: '#FFFFFF',
                  fontSize: typography.caption.fontSize,
                  lineHeight: typography.caption.lineHeight,
                }}
              >
                {index + 1} / {shown.urls.length}
              </Text>
            </View>
          ) : (
            <View />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onClose();
            }}
            hitSlop={8}
            testID={`${testID}-close`}
            style={{
              width: 48,
              height: 48,
              borderRadius: radius.full,
              backgroundColor: 'rgba(0,0,0,0.45)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="X" size={24} color="#FFFFFF" />
          </Pressable>
        </View>

        {/* 底栏：保存反馈人话 + 保存到相册（SafeArea 避让） */}
        <View
          style={{
            position: 'absolute',
            left: spacing[4],
            right: spacing[4],
            bottom: insets.bottom + spacing[3],
            alignItems: 'center',
          }}
        >
          {saveError ? (
            <Text
              testID={`${testID}-save-error`}
              style={{
                marginBottom: spacing[2],
                color: '#FFFFFF',
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {saveError}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="保存到相册"
            accessibilityState={{ busy: saveState === 'saving' }}
            disabled={saveState === 'saving'}
            onPress={() => void save()}
            testID={`${testID}-save`}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing[2],
              height: 48,
              paddingHorizontal: spacing[4],
              borderRadius: radius.full,
              backgroundColor: colors.surface,
              opacity: saveState === 'saving' ? 0.6 : pressed ? 0.85 : 1,
            })}
          >
            {saveState === 'saving' ? (
              <ActivityIndicator color={colors.accent} testID={`${testID}-save-loading`} />
            ) : (
              <Icon
                name={saveState === 'saved' ? 'Check' : 'Download'}
                size={20}
                color={saveState === 'saved' ? colors.success : colors.text}
              />
            )}
            <Text
              style={{
                color: colors.text,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
                fontWeight: '600',
              }}
            >
              {saveState === 'saved' ? '已保存到相册' : '保存到相册'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
