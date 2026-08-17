// Jest 配置：jest-expo 预设；纯逻辑（lib/）与状态（stores/）纳入覆盖率门禁 ≥80%
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)'],
  moduleNameMapper: {
    // 路径别名与 tsconfig paths 对齐
    '^@/(.*)$': '<rootDir>/src/$1',
    // MMKV 原生模块在 jest 不可用，全局替换为内存替身
    '^react-native-mmkv$': '<rootDir>/src/test/mmkv-mock.ts',
    // jest-expo 解析器会把 lucide 指到 ESM(.mjs)，而 transform 不含 mjs → 强制走 CJS 构建
    '^lucide-react-native$':
      '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js',
  },
  // lucide-react-native 以 ESM 发布，需纳入 babel 转换范围（jest-expo 默认白名单之外）
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|lucide-react-native)',
  ],
  collectCoverageFrom: [
    'src/lib/**/*.ts',
    'src/stores/**/*.ts',
    '!**/__tests__/**',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
