/**
 * ESLint 配置（MP6 收口）
 * 范围：TS strict 语义 + Vue3 推荐规则；uni 全局只读声明
 */
module.exports = {
  root: true,
  env: { es2022: true, browser: true },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    ecmaVersion: 'latest',
    sourceType: 'module',
    extraFileExtensions: ['.vue'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  globals: {
    uni: 'readonly',
    wx: 'readonly',
    getApp: 'readonly',
    getCurrentPages: 'readonly',
    App: 'readonly',
    Page: 'readonly',
    UniApp: 'readonly',
  },
  rules: {
    // uni-app 单文件组件多词名限制放宽（页面名如 index/jobs 是路由约定）
    'vue/multi-word-component-names': 'off',
    // TS 类型已强制 props 契约，require-default-prop 是 JS 时代安全网
    'vue/require-default-prop': 'off',
    // 小程序模板大量用 view/text 原生标签
    'vue/no-unused-components': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: ['dist', 'node_modules', 'src/components/ui/icons.generated.ts', 'unpackage'],
};
