// ESLint 扁平配置：eslint-config-expo 基底 + 项目硬性规则（见 docs/development-standards.md 第四节）
const flat = require('eslint-config-expo/flat');
const expoConfig = Array.isArray(flat) ? flat : flat.default;

module.exports = [
  ...expoConfig,
  {
    ignores: ['node_modules/**', '.expo/**', 'dist/**', 'coverage/**'],
  },
  {
    rules: {
      // 禁止遗留调试输出（warn/error 允许）
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // 禁止 any 逃逸
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
