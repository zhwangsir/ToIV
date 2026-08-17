import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme } from '@/hooks/use-app-theme';

/**
 * 页面容器：SafeArea + 主题底色
 * 页面左右安全边距 16（指南 3.2），由各页面自行组合 padding
 */
export function Screen({
  children,
  edges,
  testID,
}: {
  children: ReactNode;
  /** 默认四边全避让；贴底悬浮条页面可传 ['left','right','top'] 自行处理底部 */
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  testID?: string;
}) {
  const { colors } = useAppTheme();
  return (
    <SafeAreaView
      edges={edges ?? ['top', 'bottom', 'left', 'right']}
      style={[styles.base, { backgroundColor: colors.bg }]}
      testID={testID}
    >
      <View style={styles.inner}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  base: { flex: 1 },
  inner: { flex: 1 },
});
