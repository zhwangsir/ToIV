import { Tabs } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/Icon';
import { useAppTheme } from '@/hooks/use-app-theme';

/**
 * 主导航（指南 4.2 TabBar）：创作 / 作业 / 作品库 / 我的
 * - 4 项上限、图标+文字、激活 accent + 轻触 haptic
 * - 底部拇指区，双端平台惯例一致
 */
const TABS: readonly { name: string; title: string; icon: IconName }[] = [
  { name: 'index', title: '创作', icon: 'Sparkles' },
  { name: 'jobs', title: '作业', icon: 'ListVideo' },
  { name: 'library', title: '作品库', icon: 'Images' },
  { name: 'profile', title: '我的', icon: 'UserRound' },
];

export default function TabsLayout() {
  const { colors } = useAppTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
      }}
      screenListeners={{
        tabPress: () => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: ({ color, size }) => <Icon name={tab.icon} color={color as string} size={size} />,
            tabBarAccessibilityLabel: tab.title,
          }}
        />
      ))}
    </Tabs>
  );
}
