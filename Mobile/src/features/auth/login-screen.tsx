import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { z } from 'zod';

import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Screen } from '@/components/ui/screen';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useAuthStore } from '@/stores/auth';

/**
 * 登录屏（指南：简洁优雅、视觉对称、表单错误三通道）
 * - 受控组件 + zod 校验（规范 3.2 表单层）
 * - 提交成功无需手动跳转：auth gate 监听 status 自动 replace 到主 Tab
 */
const credentialsSchema = z.object({
  email: z.email('请输入有效邮箱'),
  password: z.string().min(1, '请输入密码'),
});

export function LoginScreen() {
  const { colors, spacing, typography } = useAppTheme();
  const signIn = useAuthStore((s) => s.signIn);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    setFormError(null);
    const parsed = credentialsSchema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      const issues = parsed.error.issues;
      setFieldErrors({
        email: issues.find((i) => i.path[0] === 'email')?.message,
        password: issues.find((i) => i.path[0] === 'password')?.message,
      });
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await signIn(parsed.data.email, parsed.data.password);
    } catch (err) {
      // ApiError 已是人话（lib/api friendlyMessage）；非预期错误给通用恢复动作
      setFormError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
      setSubmitting(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            paddingHorizontal: spacing[6],
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* 品牌区：主轴对称 */}
          <View style={{ alignItems: 'center', marginBottom: spacing[10] }}>
            <Text
              style={{
                color: colors.text,
                fontSize: typography.display.fontSize,
                lineHeight: typography.display.lineHeight,
                fontWeight: '700',
              }}
            >
              ToIV
            </Text>
            <Text
              style={{
                marginTop: spacing[2],
                color: colors.textSecondary,
                fontSize: typography.caption.fontSize,
                lineHeight: typography.caption.lineHeight,
              }}
            >
              AI 创作工作台
            </Text>
          </View>

          <View style={{ gap: spacing[4] }}>
            <Input
              label="邮箱"
              icon="Mail"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              error={fieldErrors.email}
              testID="login-email"
            />
            <Input
              label="密码"
              icon="Lock"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoComplete="password"
              error={fieldErrors.password}
              rightAccessory={{
                icon: showPassword ? 'EyeOff' : 'Eye',
                onPress: () => setShowPassword((v) => !v),
                accessibilityLabel: showPassword ? '隐藏密码' : '显示密码',
              }}
              testID="login-password"
            />

            {formError ? (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text
                  style={{
                    color: colors.danger,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                  }}
                >
                  {formError}
                </Text>
              </View>
            ) : null}

            <Button
              title="登录"
              onPress={() => void onSubmit()}
              loading={submitting}
              testID="login-submit"
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
