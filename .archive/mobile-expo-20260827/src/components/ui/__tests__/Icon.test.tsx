import { render, screen } from '@testing-library/react-native';

import { Icon } from '../Icon';

// lucide 组件链路（react-native-svg + css-interop）在 jest 环境不稳定，
// 且本测试目标是「我们的封装逻辑」而非 svg 渲染，故整体替身
// （jest.mock 会被 babel 提升到文件顶部，imports 放上面不影响生效）
jest.mock('lucide-react-native', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return new Proxy(
    { __esModule: true },
    {
      get: (_target, prop) => {
        if (prop === '__esModule') return true;
        const C = (props: Record<string, unknown>) => React.createElement(View, props);
        C.displayName = `Lucide(${String(prop)})`;
        return C;
      },
    },
  );
});

describe('Icon（lucide 唯一封装）', () => {
  it('按名字渲染注册表内图标并透传 testID', async () => {
    await render(<Icon name="Sparkles" testID="ic-sparkles" />);
    expect(screen.getByTestId('ic-sparkles')).toBeTruthy();
  });

  it('未传 color 时回落到主题 text 色（palette-01 light）', async () => {
    await render(<Icon name="Check" testID="ic-check" />);
    expect(screen.getByTestId('ic-check').props.color).toBe('#1C1B1A');
  });

  it('默认描边 1.75（指南区间 1.5-2）', async () => {
    await render(<Icon name="Check" testID="ic-stroke" />);
    expect(screen.getByTestId('ic-stroke').props.strokeWidth).toBe(1.75);
  });

  it('支持可访问性标签', async () => {
    await render(<Icon name="Trash2" accessibilityLabel="删除" testID="ic-trash" />);
    expect(screen.getByLabelText('删除')).toBeTruthy();
  });
});
