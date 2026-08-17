import { Stack } from 'expo-router';

/** 认证分组：无头 Stack（登录/未来的注册页） */
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
