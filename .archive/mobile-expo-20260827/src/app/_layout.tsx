import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useAppTheme } from '@/hooks/use-app-theme';
import { QueryProvider } from '@/providers/query-client';
import { useAuthStore } from '@/stores/auth';

/**
 * 根布局（规范 3.1）
 * - Provider 挂载：手势根容器 → QueryClient → 导航主题（色板驱动）
 * - auth gate：restoring 期间保持 Splash；signedOut 强制进 (auth)，signedIn 禁止回 (auth)
 */
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const restore = useAuthStore((s) => s.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryProvider>
        <RootNavigator />
      </QueryProvider>
    </GestureHandlerRootView>
  );
}

function RootNavigator() {
  const status = useAuthStore((s) => s.status);
  const segments = useSegments();
  const router = useRouter();
  const theme = useAppTheme();

  // 会话恢复完成后才放行 Splash，避免登录页/主页闪跳
  useEffect(() => {
    if (status !== 'restoring') void SplashScreen.hideAsync();
  }, [status]);

  useEffect(() => {
    if (status === 'restoring') return;
    const inAuthGroup = segments[0] === '(auth)';
    if (status === 'signedOut' && !inAuthGroup) {
      router.replace('/login');
    } else if (status === 'signedIn' && inAuthGroup) {
      router.replace('/');
    }
  }, [status, segments, router]);

  // 导航主题由当前色板驱动（五色板换肤时导航容器同步换色）
  const base = theme.isDark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.colors.accent,
      background: theme.colors.bg,
      card: theme.colors.surface,
      text: theme.colors.text,
      border: theme.colors.border,
      notification: theme.colors.danger,
    },
  };

  return (
    <>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <ThemeProvider value={navTheme}>
        <Stack screenOptions={{ headerShown: false }} />
      </ThemeProvider>
    </>
  );
}
