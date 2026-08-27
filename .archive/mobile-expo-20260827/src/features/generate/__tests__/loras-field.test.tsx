import { fireEvent, render, screen } from '@testing-library/react-native';

import { LorasField } from '../loras-field';
import type { EngineParam, LoraValue } from '@/types/api';

// lucide 渲染链路在 jest 不稳定，替身隔离（与 ref-image-field.test.tsx 同理）
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

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light' },
}));

/** 与后端 engine_registry _h3_loras_select 同形（min/max/step 即强度滑杆范围） */
const PARAM: EngineParam = {
  key: 'loras',
  label: 'LoRA 叠加',
  type: 'loras',
  default: [],
  options: [
    { value: 'film.safetensors', label: '胶片质感' },
    { value: 'motion.safetensors', label: '运动增强' },
    { value: 'r18.safetensors', label: '成人向', nsfw: true },
  ],
  min: 0.5,
  max: 1.0,
  step: 0.05,
  hint: '可选,最多 3 个',
};

const EMPTY_OPTIONS_PARAM: EngineParam = { ...PARAM, options: [] };

async function renderField(value: LoraValue[] = [], param: EngineParam = PARAM) {
  const onChange = jest.fn();
  const utils = await render(<LorasField param={param} value={value} onChange={onChange} testID="loras" />);
  const setValue = (next: LoraValue[]) =>
    utils.rerender(<LorasField param={param} value={next} onChange={onChange} testID="loras" />);
  return { onChange, setValue };
}

describe('LorasField（H3 LoRA 叠加字段，M10.3）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('options 为空（H3 实例不可达声明态兜底）渲染显式提示，不静默吞掉', async () => {
    await renderField([], EMPTY_OPTIONS_PARAM);
    expect(screen.getByTestId('loras-empty')).toBeTruthy();
    expect(screen.getByText('引擎实例上暂无可用 LoRA')).toBeTruthy();
  });

  it('渲染选项行 + 计数；nsfw 选项带 R18 标', async () => {
    await renderField();
    expect(screen.getByTestId('loras-opt-film.safetensors')).toBeTruthy();
    expect(screen.getByTestId('loras-opt-motion.safetensors')).toBeTruthy();
    expect(screen.getByText('胶片质感')).toBeTruthy();
    expect(screen.getByText('R18')).toBeTruthy();
    expect(screen.getByText('已选 0/3')).toBeTruthy();
  });

  it('点选追加 {name, strength: 0.6}；已选状态再点取消选中', async () => {
    const { onChange, setValue } = await renderField();
    await fireEvent.press(screen.getByTestId('loras-opt-film.safetensors'));
    expect(onChange).toHaveBeenCalledWith([{ name: 'film.safetensors', strength: 0.6 }]);

    // 父组件受控回写后再点 = 取消
    await setValue([{ name: 'film.safetensors', strength: 0.6 }]);
    await fireEvent.press(screen.getByTestId('loras-opt-film.safetensors'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('选中项展示强度步进器（默认 0.60），未选中的不展示', async () => {
    await renderField([{ name: 'film.safetensors', strength: 0.6 }]);
    expect(screen.getByTestId('loras-strength-film.safetensors')).toBeTruthy();
    expect(screen.getByText('0.60')).toBeTruthy();
    expect(screen.queryByTestId('loras-strength-motion.safetensors')).toBeNull();
    expect(screen.getByText('已选 1/3')).toBeTruthy();
  });

  it('强度步进：plus 加 0.05、minus 减 0.05（按注册表 step）', async () => {
    const { onChange, setValue } = await renderField([{ name: 'film.safetensors', strength: 0.6 }]);
    await fireEvent.press(screen.getByTestId('loras-strength-film.safetensors-plus'));
    expect(onChange).toHaveBeenCalledWith([{ name: 'film.safetensors', strength: 0.65 }]);

    await setValue([{ name: 'film.safetensors', strength: 0.65 }]);
    await fireEvent.press(screen.getByTestId('loras-strength-film.safetensors-minus'));
    expect(onChange).toHaveBeenCalledWith([{ name: 'film.safetensors', strength: 0.6 }]);
  });

  it('强度钳到 [min,max] 边界：0.5 不可再减、1.0 不可再加（浮点规整 2 位小数）', async () => {
    const { onChange, setValue } = await renderField([{ name: 'film.safetensors', strength: 0.5 }]);
    await fireEvent.press(screen.getByTestId('loras-strength-film.safetensors-minus'));
    expect(onChange).toHaveBeenCalledWith([{ name: 'film.safetensors', strength: 0.5 }]);

    await setValue([{ name: 'film.safetensors', strength: 1.0 }]);
    await fireEvent.press(screen.getByTestId('loras-strength-film.safetensors-plus'));
    expect(onChange).toHaveBeenCalledWith([{ name: 'film.safetensors', strength: 1.0 }]);
  });

  it('选满 3 个后未选项 capped 禁用，点按不再追加（后端 max_length=3 同源）', async () => {
    const three: LoraValue[] = [
      { name: 'a.safetensors', strength: 0.6 },
      { name: 'b.safetensors', strength: 0.6 },
      { name: 'c.safetensors', strength: 0.6 },
    ];
    const fullParam: EngineParam = {
      ...PARAM,
      options: [
        { value: 'a.safetensors', label: 'A' },
        { value: 'b.safetensors', label: 'B' },
        { value: 'c.safetensors', label: 'C' },
        { value: 'd.safetensors', label: 'D' },
      ],
    };
    const { onChange } = await renderField(three, fullParam);
    expect(screen.getByText('已选 3/3')).toBeTruthy();
    const d = screen.getByTestId('loras-opt-d.safetensors');
    expect(d.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(d);
    expect(onChange).not.toHaveBeenCalled();
    // 已选项仍可取消（capped 只挡未选项）
    await fireEvent.press(screen.getByTestId('loras-opt-a.safetensors'));
    expect(onChange).toHaveBeenCalledWith([
      { name: 'b.safetensors', strength: 0.6 },
      { name: 'c.safetensors', strength: 0.6 },
    ]);
  });

  it('脏值兜底：非数组 value 按空数组渲染', async () => {
    await render(<LorasField param={PARAM} value={'junk' as unknown as LoraValue[]} onChange={jest.fn()} testID="loras" />);
    expect(screen.getByText('已选 0/3')).toBeTruthy();
  });
});
