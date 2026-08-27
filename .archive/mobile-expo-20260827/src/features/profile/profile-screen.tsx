/**
 * 我的屏
 * - 账户卡片：邮箱 + 角色（auth store 快照，弱网兜底已在 restore 层处理）
 * - 外观设置：显示模式三段切换 + 五色板换肤（指南 3.3；换肤零组件改动由 Token 保证）
 * - 管理：参考资产库入口（M13，创作页可引用库内资产图）
 * - 关于（M26）：版本号直显 + 关于弹层；清理缓存（白名单保留登录/设置/对话草稿）；导出诊断（脱敏 JSON 复制剪贴板）
 * - 退出登录用 secondary 变体：危险但非破坏性操作，保持视觉克制（指南 4.2）
 */
import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import {
  Alert,
  Modal,
  PixelRatio,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/hooks/use-app-theme';
import { resolveApiBase } from '@/lib/config';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';
import type { ThemeMode } from '@/stores/settings';
import { getPalette, palettes } from '@/theme/tokens';

import {
  buildDiagnostics,
  clearCache,
  collectStorageKeyStats,
  estimateCacheBytes,
  formatBytes,
} from './settings-utils';
import type { Diagnostics } from './settings-utils';

const MODES: { id: ThemeMode; label: string; icon: IconName }[] = [
  { id: 'light', label: '浅色', icon: 'Sun' },
  { id: 'dark', label: '深色', icon: 'Moon' },
  { id: 'system', label: '跟随系统', icon: 'SunMoon' },
];

function lightHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** 版本号走 Constants.expoConfig（v57 官方推荐读法，lib/config.ts 有先例）；Expo Go/缺失时兜底 */
const APP_VERSION = Constants.expoConfig?.version ?? '未知';
/** 应用配置名（诊断用，排查配置事故时以真实 app.json 为准） */
const APP_CONFIG_NAME = Constants.expoConfig?.name ?? 'ToIV';

/** 设置行（M26 关于区三行复用：图标 + 标题/副标题 + 可选 chevron） */
function SettingsRow({
  testID,
  icon,
  title,
  subtitle,
  showBorder = false,
  showChevron = false,
  onPress,
}: {
  testID: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  showBorder?: boolean;
  showChevron?: boolean;
  onPress: () => void;
}) {
  const { colors, spacing, typography } = useAppTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 48,
        paddingHorizontal: spacing[4],
        paddingVertical: spacing[3],
        borderTopWidth: showBorder ? 1 : 0,
        borderTopColor: colors.border,
      }}
    >
      <Icon name={icon} size={20} color={colors.accent} />
      <View style={{ marginLeft: spacing[3], flex: 1 }}>
        <Text
          style={{
            color: colors.text,
            fontSize: typography.body.fontSize,
            lineHeight: typography.body.lineHeight,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={{
              marginTop: spacing[1],
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {showChevron ? <Icon name="ChevronRight" size={20} color={colors.textSecondary} /> : null}
    </Pressable>
  );
}

export function ProfileScreen() {
  const { colors, spacing, radius, typography, resolvedMode } = useAppTheme();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const authStatus = useAuthStore((s) => s.status);
  const paletteId = useSettingsStore((s) => s.paletteId);
  const mode = useSettingsStore((s) => s.mode);
  const setPalette = useSettingsStore((s) => s.setPalette);
  const setMode = useSettingsStore((s) => s.setMode);
  const nsfwIntent = useSettingsStore((s) => s.nsfwIntent);
  const [aboutVisible, setAboutVisible] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [cacheBytes, setCacheBytes] = useState(() => estimateCacheBytes());

  /** 清理缓存：Alert 二次确认 → 白名单外缓存清除 → 内联反馈释放量（M26） */
  const confirmClearCache = (): void => {
    lightHaptic();
    Alert.alert('清理缓存', '仅清理下载缓存与临时数据，保留登录状态、设置与对话草稿。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清理',
        style: 'destructive',
        onPress: () => {
          const freed = clearCache();
          setCacheBytes(estimateCacheBytes());
          setFeedback(`已清理 ${formatBytes(freed)}`);
        },
      },
    ]);
  };

  /** 导出诊断：组装脱敏 JSON → 剪贴板 → 内联反馈（M26；token 不入诊断，键只出名与大小） */
  const exportDiagnostics = async (): Promise<void> => {
    lightHaptic();
    const diagnostics: Diagnostics = buildDiagnostics({
      appName: APP_CONFIG_NAME,
      appVersion: APP_VERSION,
      platform: Platform.OS,
      osVersion: Platform.Version,
      deviceModel: Device.modelName,
      pixelRatio: PixelRatio.get(),
      apiBase: resolveApiBase(),
      signedIn: authStatus === 'signedIn',
      nsfwIntent,
      storageKeys: collectStorageKeyStats(),
      generatedAt: new Date(),
    });
    try {
      await Clipboard.setStringAsync(JSON.stringify(diagnostics, null, 2));
      setFeedback('诊断信息已复制');
    } catch {
      setFeedback('复制失败，请重试');
    }
  };

  return (
    <Screen testID="screen-profile">
      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing[4], paddingBottom: spacing[8] }}>
        <Text
          style={{
            marginTop: spacing[4],
            color: colors.text,
            fontSize: typography.title.fontSize,
            lineHeight: typography.title.lineHeight,
            fontWeight: '700',
            letterSpacing: typography.title.letterSpacing,
          }}
        >
          我的
        </Text>

        {/* 账户卡片 */}
        <View
          testID="profile-user-card"
          style={{
            marginTop: spacing[6],
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.surface,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            padding: spacing[4],
          }}
        >
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: radius.full,
              backgroundColor: colors.accentSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="UserRound" size={28} color={colors.accent} />
          </View>
          <View style={{ marginLeft: spacing[4], flex: 1 }}>
            <Text
              style={{
                color: colors.text,
                fontSize: typography.heading.fontSize,
                lineHeight: typography.heading.lineHeight,
                fontWeight: '600',
              }}
            >
              {user?.email ?? '未登录'}
            </Text>
            <Text
              style={{
                marginTop: spacing[1],
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              {user ? `角色：${user.role}` : '会话未建立'}
            </Text>
          </View>
        </View>

        {/* 外观 */}
        <Text
          style={{
            marginTop: spacing[8],
            marginBottom: spacing[3],
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
            letterSpacing: 1,
          }}
        >
          外观
        </Text>

        {/* 显示模式三段切换 */}
        <View
          testID="section-mode"
          style={{
            flexDirection: 'row',
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            padding: spacing[1],
          }}
        >
          {MODES.map((m) => {
            const active = mode === m.id;
            return (
              <Pressable
                key={m.id}
                testID={`mode-option-${m.id}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={m.label}
                onPress={() => {
                  lightHaptic();
                  setMode(m.id);
                }}
                style={{
                  flex: 1,
                  height: 40,
                  borderRadius: radius.sm,
                  flexDirection: 'row',
                  gap: spacing[2],
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: active ? colors.accentSoft : 'transparent',
                }}
              >
                <Icon name={m.icon} size={18} color={active ? colors.accent : colors.textSecondary} />
                <Text
                  style={{
                    color: active ? colors.accent : colors.textSecondary,
                    fontSize: typography.body.fontSize,
                    lineHeight: typography.body.lineHeight,
                    fontWeight: active ? '600' : '400',
                  }}
                >
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* 色板换肤 */}
        <View
          testID="section-palette"
          style={{
            marginTop: spacing[3],
            backgroundColor: colors.surface,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
          }}
        >
          {palettes.map((p, idx) => {
            const active = p.id === paletteId;
            return (
              <Pressable
                key={p.id}
                testID={`palette-option-${p.id}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`色板 ${p.name}`}
                onPress={() => {
                  lightHaptic();
                  setPalette(p.id);
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  minHeight: 48,
                  paddingHorizontal: spacing[4],
                  paddingVertical: spacing[3],
                  borderTopWidth: idx === 0 ? 0 : 1,
                  borderTopColor: colors.border,
                }}
              >
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: radius.full,
                    backgroundColor: getPalette(p.id, resolvedMode).accent,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                />
                <Text
                  style={{
                    marginLeft: spacing[3],
                    flex: 1,
                    color: colors.text,
                    fontSize: typography.body.fontSize,
                    lineHeight: typography.body.lineHeight,
                    fontWeight: active ? '600' : '400',
                  }}
                >
                  {p.name}
                </Text>
                {active ? (
                  <Icon name="Check" size={20} color={colors.accent} testID={`palette-check-${p.id}`} />
                ) : null}
              </Pressable>
            );
          })}
        </View>

        {/* 管理：参考资产库入口（M13） */}
        <Text
          style={{
            marginTop: spacing[8],
            marginBottom: spacing[3],
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
            letterSpacing: 1,
          }}
        >
          管理
        </Text>
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
          }}
        >
          <Pressable
            testID="entry-assets"
            accessibilityRole="button"
            accessibilityLabel="参考资产库"
            onPress={() => {
              lightHaptic();
              router.push('/assets');
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: 48,
              paddingHorizontal: spacing[4],
              paddingVertical: spacing[3],
            }}
          >
            <Icon name="Layers" size={20} color={colors.accent} />
            <Text
              style={{
                marginLeft: spacing[3],
                flex: 1,
                color: colors.text,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              参考资产库
            </Text>
            <Icon name="ChevronRight" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>

        {/* 关于（M26）：版本直显 / 清理缓存（白名单保护）/ 导出诊断（脱敏） */}
        <Text
          style={{
            marginTop: spacing[8],
            marginBottom: spacing[3],
            color: colors.textSecondary,
            fontSize: typography.caption.fontSize,
            lineHeight: typography.caption.lineHeight,
            letterSpacing: 1,
          }}
        >
          关于
        </Text>
        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
          }}
        >
          <SettingsRow
            testID="row-about"
            icon="Info"
            title="关于 ToIV"
            subtitle={`v${APP_VERSION}`}
            showChevron
            onPress={() => {
              lightHaptic();
              setAboutVisible(true);
            }}
          />
          <SettingsRow
            testID="row-clear-cache"
            icon="Trash2"
            title="清理缓存"
            subtitle={`占用 ${formatBytes(cacheBytes)}`}
            showBorder
            onPress={confirmClearCache}
          />
          <SettingsRow
            testID="row-export-diagnostics"
            icon="Share2"
            title="导出诊断信息"
            subtitle="不含敏感信息，复制到剪贴板"
            showBorder
            onPress={() => {
              void exportDiagnostics();
            }}
          />
        </View>
        {feedback ? (
          <Text
            testID="settings-feedback"
            style={{
              marginTop: spacing[3],
              color: colors.textSecondary,
              fontSize: typography.caption.fontSize,
              lineHeight: typography.caption.lineHeight,
            }}
          >
            {feedback}
          </Text>
        ) : null}

        {/* 退出登录 */}
        <Button
          title="退出登录"
          variant="secondary"
          onPress={() => {
            lightHaptic();
            void signOut();
          }}
          testID="signout-button"
          style={{ marginTop: spacing[8] }}
        />
      </ScrollView>

      {/* 关于弹层（M26）：产品名 / 版本 / 定位（对齐主站落地页文案）/ 版权 */}
      <Modal
        testID="about-modal"
        visible={aboutVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAboutVisible(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            justifyContent: 'center',
            paddingHorizontal: spacing[6],
          }}
        >
          <View
            style={{
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              padding: spacing[6],
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
              ToIV
            </Text>
            <Text
              style={{
                marginTop: spacing[1],
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              版本 {APP_VERSION}
            </Text>
            <Text
              style={{
                marginTop: spacing[4],
                color: colors.text,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              一个工作台，装下图像、视频与数字人的完整创作流程。
            </Text>
            <Text
              style={{
                marginTop: spacing[6],
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              © 2026 ToIV
            </Text>
            <Button
              title="关闭"
              variant="secondary"
              testID="about-close"
              onPress={() => setAboutVisible(false)}
              style={{ marginTop: spacing[6] }}
            />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
