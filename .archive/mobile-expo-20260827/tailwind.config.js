/** @type {import('tailwindcss').Config} */
// NativeWind v4：承载布局/间距/排版工具类；颜色一律走 src/theme/tokens.ts 设计 Token（见开发规范禁令 2）
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      spacing: {
        // 与 tokens.spacing 对齐的 4pt 网格补充档位
        18: '72px',
        22: '88px',
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '16px',
        xl: '24px',
      },
    },
  },
  plugins: [],
};
