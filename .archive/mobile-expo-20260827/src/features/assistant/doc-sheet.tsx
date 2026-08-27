/**
 * 文档面板（M20.2）：文档列表 / 上传 / 勾选挂载 / 删除
 * - Modal 底部抽屉（对齐 SessionSheet/ParamSheet 语言：slide 动画 + 半透明 backdrop + 贴底圆角卡）
 * - 数据按需拉取（visible 才启用查询），created_at 倒序由后端保证（documents.py list_docs）
 * - 上传：expo-document-picker（Expo v57 getDocumentAsync，type 四 mime 白名单 + copyToCacheDirectory）
 *   → 客户端先验（扩展名 pdf/docx/txt/md / ≤50MB，与 services/docs.py 同源语义提前拦截）
 *   → POST /api/docs/upload（大文件解析走 long 超时档，由 api 层保证）
 * - 列表项 = 文件名 + formatDocSize(size) + docStatusLabel(status) + 挂载勾选态 + 删除钮
 * - 删除二次确认走 ConfirmDialog（对齐 artifact-detail 删除语义）；删除挂载中文档由主屏卸载
 */
import { useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { deleteDoc, listDocs, uploadDoc } from '@/lib/api';
import { docStatusLabel, formatDocSize } from '@/lib/doc-utils';
import type { DocItem } from '@/types/api';

/** 与后端 services/docs.py MAX_FILE_BYTES 一致的上限 */
const DOC_MAX_BYTES = 50 * 1024 * 1024;
/** 客户端扩展名白名单（后端 services/docs.py _KINDS 同源） */
const DOC_EXT_OK = new Set(['pdf', 'docx', 'txt', 'md']);
/** 选择器 mime 过滤（Expo v57 DocumentPickerOptions.type 支持数组） */
const DOC_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
];

export interface DocSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 当前已挂载文档 id（列表勾选态数据源） */
  attachedIds: string[];
  /** 点按列表项：挂载/卸载切换 */
  onToggleAttach: (doc: DocItem) => void;
  /** 删除成功：主屏卸载该文档（若在挂载中） */
  onDeleted: (docId: string) => void;
  testID?: string;
}

export function DocSheet({
  visible,
  onClose,
  attachedIds,
  onToggleAttach,
  onDeleted,
  testID = 'doc-sheet',
}: DocSheetProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DocItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const docsQuery = useQuery({
    queryKey: ['docs'],
    queryFn: listDocs,
    // 面板关闭期间不拉取（列表非首屏数据，按需加载省流量）
    enabled: visible,
  });
  const docs = docsQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: deleteDoc,
    onSuccess: (_data, docId) => {
      void queryClient.invalidateQueries({ queryKey: ['docs'] });
      setPendingDelete(null);
      onDeleted(docId);
    },
    onError: (err) => {
      setDeleteError(err instanceof Error ? err.message : '删除失败，请重试');
    },
  });

  const pick = async (): Promise<void> => {
    if (uploading) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setUploadError(null);

    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({
        type: DOC_MIME_TYPES,
        copyToCacheDirectory: true,
      });
    } catch {
      setUploadError('无法打开文件选择器，请重试');
      return;
    }
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    // 客户端先验：扩展名 + 体积（size 可得时），与后端 400/413 语义对齐提前拦截
    const ext = asset.name.split('.').pop()?.toLowerCase() ?? '';
    if (!DOC_EXT_OK.has(ext)) {
      setUploadError('仅支持 pdf / docx / txt / md 文件');
      return;
    }
    if (typeof asset.size === 'number' && asset.size > DOC_MAX_BYTES) {
      setUploadError('文件超过 50MB 上限');
      return;
    }

    setUploading(true);
    try {
      await uploadDoc({ uri: asset.uri, fileName: asset.name, mimeType: asset.mimeType });
      await queryClient.invalidateQueries({ queryKey: ['docs'] });
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : '上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="关闭文档面板"
        onPress={onClose}
        testID={`${testID}-backdrop`}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.32)' }}
      />
      <View
        testID={testID}
        style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          paddingHorizontal: spacing[4],
          paddingTop: spacing[3],
          paddingBottom: Math.max(insets.bottom, spacing[3]),
          maxHeight: '70%',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text
            style={{
              color: colors.text,
              fontSize: typography.heading.fontSize,
              lineHeight: typography.heading.lineHeight,
              fontWeight: '700',
            }}
          >
            文档
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            hitSlop={8}
            testID={`${testID}-close`}
            style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="X" size={22} color={colors.textSecondary} />
          </Pressable>
        </View>

        {/* 上传入口置顶（高频动作）；选中即传，对齐 RefAudioField 模式 */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: uploading }}
          disabled={uploading}
          onPress={() => void pick()}
          testID={`${testID}-upload`}
          style={{
            minHeight: 48,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing[2],
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
            {uploading ? '上传中…' : '上传文档'}
          </Text>
        </Pressable>
        {uploadError ? (
          <Text
            testID={`${testID}-upload-error`}
            style={{
              marginTop: spacing[1],
              color: colors.danger,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {uploadError}
          </Text>
        ) : null}

        {docsQuery.isPending ? (
          <View style={{ paddingVertical: spacing[6], alignItems: 'center' }}>
            <ActivityIndicator color={colors.accent} testID={`${testID}-loading`} />
          </View>
        ) : docs.length === 0 ? (
          <View style={{ paddingVertical: spacing[4] }}>
            <EmptyState
              icon="FolderOpen"
              title="还没有文档"
              description="上传 pdf / docx / txt / md，发送对话时可挂载引用"
              testID={`${testID}-empty`}
            />
          </View>
        ) : (
          <FlatList
            data={docs}
            keyExtractor={(item) => item.id}
            style={{ flexGrow: 0, marginTop: spacing[2] }}
            renderItem={({ item }) => {
              const attached = attachedIds.includes(item.id);
              return (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: attached ? colors.accent : colors.border,
                    backgroundColor: attached ? colors.accentSoft : colors.bg,
                    paddingHorizontal: spacing[3],
                    paddingVertical: spacing[3],
                    marginBottom: spacing[2],
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${attached ? '取消挂载' : '挂载'}文档：${item.filename}`}
                    accessibilityState={{ selected: attached }}
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      onToggleAttach(item);
                    }}
                    testID={`doc-attach-${item.id}`}
                    style={{ flex: 1, minHeight: 48, justifyContent: 'center' }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                      <Icon
                        name="File"
                        size={18}
                        color={attached ? colors.accent : colors.textSecondary}
                      />
                      <Text
                        numberOfLines={1}
                        style={{
                          flex: 1,
                          color: colors.text,
                          fontSize: typography.body.fontSize,
                          lineHeight: typography.body.lineHeight,
                          fontWeight: '500',
                        }}
                      >
                        {item.filename}
                      </Text>
                      {attached ? (
                        <Icon
                          name="Check"
                          size={18}
                          color={colors.accent}
                          testID={`doc-attach-${item.id}-check`}
                        />
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
                      {formatDocSize(item.size)} · {docStatusLabel(item.status)}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`删除文档：${item.filename}`}
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setDeleteError(null);
                      setPendingDelete(item);
                    }}
                    hitSlop={8}
                    testID={`doc-delete-${item.id}`}
                    style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="Trash2" size={20} color={colors.textSecondary} />
                  </Pressable>
                </View>
              );
            }}
          />
        )}
      </View>

      <ConfirmDialog
        visible={pendingDelete !== null}
        title="删除文档"
        description={`「${pendingDelete?.filename ?? ''}」删除后不可恢复。`}
        confirmText="删除"
        danger
        loading={deleteMutation.isPending}
        errorMessage={deleteError}
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
        }}
        onCancel={() => setPendingDelete(null)}
        testID={`${testID}-delete-dialog`}
      />
    </Modal>
  );
}
