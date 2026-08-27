import { storage } from '@/lib/mmkv';
import { DEFAULT_PALETTE_ID } from '@/theme/tokens';

import { useSettingsStore } from '../settings';

// 桥接函数打桩：验证 store 变更会同步到 lib 模块级状态
const mockSetApiBaseOverride = jest.fn();
const mockBridgeNsfw = jest.fn();

jest.mock('@/lib/config', () => ({
  setApiBaseOverride: (v: string | null) => mockSetApiBaseOverride(v),
}));

jest.mock('@/lib/api', () => ({
  setNsfwIntent: (on: boolean) => mockBridgeNsfw(on),
}));

describe('settings store', () => {
  beforeEach(() => {
    storage.clearAll();
    mockSetApiBaseOverride.mockClear();
    mockBridgeNsfw.mockClear();
    useSettingsStore.setState({
      paletteId: DEFAULT_PALETTE_ID,
      mode: 'light',
      apiBaseOverride: null,
      nsfwIntent: false,
    });
  });

  it('默认值：palette-01 浅色、无 API 覆盖、NSFW 关闭（指南：默认浅色）', () => {
    const s = useSettingsStore.getState();
    expect(s.paletteId).toBe('palette-01');
    expect(s.mode).toBe('light');
    expect(s.apiBaseOverride).toBeNull();
    expect(s.nsfwIntent).toBe(false);
  });

  it('setPalette / setMode 更新并持久化到 MMKV', () => {
    useSettingsStore.getState().setPalette('palette-03');
    useSettingsStore.getState().setMode('dark');

    expect(useSettingsStore.getState().paletteId).toBe('palette-03');
    expect(useSettingsStore.getState().mode).toBe('dark');

    const raw = storage.getString('toiv.settings');
    expect(raw).toBeDefined();
    const persisted = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(persisted.state.paletteId).toBe('palette-03');
    expect(persisted.state.mode).toBe('dark');
    // actions 不应被持久化
    expect(persisted.state.setPalette).toBeUndefined();
  });

  it('setApiBase 桥接 lib/config 的模块级覆盖', () => {
    useSettingsStore.getState().setApiBase('http://10.0.0.2:8090');
    expect(mockSetApiBaseOverride).toHaveBeenCalledWith('http://10.0.0.2:8090');
    expect(useSettingsStore.getState().apiBaseOverride).toBe('http://10.0.0.2:8090');

    useSettingsStore.getState().setApiBase(null);
    expect(mockSetApiBaseOverride).toHaveBeenLastCalledWith(null);
  });

  it('setNsfw 桥接 lib/api 的请求头意图', () => {
    useSettingsStore.getState().setNsfw(true);
    expect(mockBridgeNsfw).toHaveBeenCalledWith(true);
    expect(useSettingsStore.getState().nsfwIntent).toBe(true);
  });

  it('水合完成后把持久化值桥接回 lib（冷启动恢复）', () => {
    // 模拟上一次会话留下的持久化内容，手动触发 rehydrate 回调
    useSettingsStore.setState({ apiBaseOverride: 'http://192.168.1.5:8090', nsfwIntent: true });
    const options = (
      useSettingsStore as unknown as {
        persist: { getOptions: () => { onRehydrateStorage?: (s: unknown) => (state: unknown) => void } };
      }
    ).persist.getOptions();
    const callback = options.onRehydrateStorage?.(useSettingsStore.getState());
    callback?.(useSettingsStore.getState());

    expect(mockSetApiBaseOverride).toHaveBeenCalledWith('http://192.168.1.5:8090');
    expect(mockBridgeNsfw).toHaveBeenCalledWith(true);
  });
});
