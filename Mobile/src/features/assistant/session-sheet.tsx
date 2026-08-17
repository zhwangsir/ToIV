/**
 * 会话列表抽屉（M19.2）：历史会话查看 / 载入回放 / 删除
 * - Modal 底部抽屉（对齐 ParamSheet 语言：slide 动画 + 半透明 backdrop + 贴底圆角卡）
 * - 数据按需拉取（visible 才启用查询），updated_at 倒序由后端保证（agent.py list）
 * - 删除二次确认（Alert，对齐 asset-edit 删除语义）；删当前会话由主屏清空上下文
 * - 分叉（M24）：列表项 GitFork 钮「分叉副本」全量 fork → 主屏 forkMutation 载入新会话
 *   （非破坏性操作，无需二次确认；失败人话由主屏内联）
 */
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';

import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { deleteAgentSession, listAgentSessions } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import type { AgentSessionSummary } from '@/types/api';

export interface SessionSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 当前屏正在浏览的会话 id（删除它后主屏需清空上下文） */
  activeSessionId: string | undefined;
  /** 点选会话：主屏拉详情回放 */
  onPick: (session: AgentSessionSummary) => void;
  /** 分叉副本（M24）：全量 fork 该会话，主屏载入新会话 */
  onFork: (session: AgentSessionSummary) => void;
  /** 删除了当前会话：主屏清空为新会话 */
  onDeletedActive: () => void;
  testID?: string;
}

export function SessionSheet({
  visible,
  onClose,
  activeSessionId,
  onPick,
  onFork,
  onDeletedActive,
  testID = 'session-sheet',
}: SessionSheetProps) {
  const { colors, radius, spacing, typography } = useAppTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: ['agent', 'sessions'],
    queryFn: listAgentSessions,
    // 抽屉关闭期间不拉取（列表非首屏数据，按需加载省流量）
    enabled: visible,
  });
  const sessions = sessionsQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: deleteAgentSession,
    onSuccess: (_data, sid) => {
      void queryClient.invalidateQueries({ queryKey: ['agent', 'sessions'] });
      if (sid === activeSessionId) onDeletedActive();
    },
  });

  const confirmDelete = (session: AgentSessionSummary) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert('删除会话', `「${session.title || '未命名会话'}」删除后不可恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => deleteMutation.mutate(session.id),
      },
    ]);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="关闭会话列表"
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
            历史会话
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

        {sessionsQuery.isPending ? (
          <View style={{ paddingVertical: spacing[6], alignItems: 'center' }}>
            <ActivityIndicator color={colors.accent} testID={`${testID}-loading`} />
          </View>
        ) : sessions.length === 0 ? (
          <View style={{ paddingVertical: spacing[4] }}>
            <EmptyState
              icon="MessageCircle"
              title="还没有历史会话"
              description="发出的每条对话都会自动留存，随时回来继续"
              testID={`${testID}-empty`}
            />
          </View>
        ) : (
          <FlatList
            data={sessions}
            keyExtractor={(item) => item.id}
            style={{ flexGrow: 0, marginTop: spacing[2] }}
            renderItem={({ item }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.bg,
                  paddingHorizontal: spacing[3],
                  paddingVertical: spacing[3],
                  marginBottom: spacing[2],
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`载入会话：${item.title || '未命名会话'}`}
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onPick(item);
                  }}
                  testID={`session-item-${item.id}`}
                  style={{ flex: 1, minHeight: 48, justifyContent: 'center' }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
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
                      {item.title || '未命名会话'}
                    </Text>
                    {item.nsfw ? (
                      <Text
                        testID={`session-item-${item.id}-r18`}
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
                    {item.message_count} 条消息 · {formatRelativeTime(item.updated_at)}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`分叉副本：${item.title || '未命名会话'}`}
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onFork(item);
                  }}
                  hitSlop={8}
                  testID={`session-fork-${item.id}`}
                  style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="GitFork" size={20} color={colors.textSecondary} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`删除会话：${item.title || '未命名会话'}`}
                  onPress={() => confirmDelete(item)}
                  hitSlop={8}
                  testID={`session-delete-${item.id}`}
                  style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="Trash2" size={20} color={colors.textSecondary} />
                </Pressable>
              </View>
            )}
          />
        )}
      </View>
    </Modal>
  );
}
