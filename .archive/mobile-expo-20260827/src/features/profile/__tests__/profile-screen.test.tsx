import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Directory } from 'expo-file-system';
import { Alert } from 'react-native';

import { ProfileScreen } from '../profile-screen';
import { storage } from '@/lib/mmkv';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';
import { DEFAULT_PALETTE_ID } from '@/theme/tokens';

// 与 Icon.test.tsx 同理：lucide 渲染链路在 jest 不稳定，测试目标是我们的封装与交互逻辑
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

// 触觉反馈无原生实现，替身
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

// expo-router 真身依赖原生导航栈（standard-navigation ESM），替身隔离路由跳转断言
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// auth store 依赖 lib/api（SecureStore + fetch），整体替身隔离
const mockLogout = jest.fn(async () => undefined);
jest.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
  fetchMe: jest.fn(),
  getToken: jest.fn(async () => null),
  login: jest.fn(),
  logout: () => mockLogout(),
  setNsfwIntent: jest.fn(),
}));

jest.mock('@/lib/config', () => ({
  resolveApiBase: () => 'https://api.test',
  setApiBaseOverride: jest.fn(),
}));

// M26：应用名/版本号走 Constants.expoConfig（v57 官方推荐，lib/config 有先例）
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { name: 'Mobile', version: '9.9.9', extra: {} } },
}));

// M26：设备型号进诊断（原生模块在 jest 无值，显式替身）
jest.mock('expo-device', () => ({ __esModule: true, modelName: 'Pixel 8' }));

// M26：导出诊断复制到剪贴板
const mockSetStringAsync = jest.fn(async (_text: string) => undefined);
jest.mock('expo-clipboard', () => ({
  setStringAsync: (text: string) => mockSetStringAsync(text),
}));

// M26：cache 目录估算/清理（expo-file-system v57 同步 API 替身）
jest.mock('expo-file-system', () => {
  class MockDirectory {
    static sizeValue: number | null = 0;
    static listItems: { name: string; size: number | null; delete: jest.Mock }[] = [];
    get size(): number | null {
      return MockDirectory.sizeValue;
    }
    list(): { name: string; size: number | null; delete: jest.Mock }[] {
      return MockDirectory.listItems;
    }
  }
  return {
    Paths: { cache: { uri: 'file:///mock/cache' } },
    Directory: MockDirectory,
  };
});

describe('ProfileScreen（我的）', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockLogout.mockClear();
    useAuthStore.setState({
      status: 'signedIn',
      user: { id: 'u1', email: 'a@b.c', role: 'user' },
    });
    useSettingsStore.setState({ paletteId: DEFAULT_PALETTE_ID, mode: 'light' });
  });

  it('展示当前用户邮箱与角色', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByText('a@b.c')).toBeTruthy();
    expect(screen.getByText('角色：user')).toBeTruthy();
  });

  it('列出 5 套色板且默认勾选 palette-01', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByTestId('palette-option-palette-05')).toBeTruthy();
    expect(screen.getByTestId('palette-check-palette-01')).toBeTruthy();
    expect(screen.queryByTestId('palette-check-palette-02')).toBeNull();
  });

  it('点选色板后写入 settings store', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByTestId('palette-option-palette-02'));
    expect(useSettingsStore.getState().paletteId).toBe('palette-02');
  });

  it('切换显示模式为深色', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByTestId('mode-option-dark'));
    expect(useSettingsStore.getState().mode).toBe('dark');
  });

  it('管理区渲染「参考资产库」入口，点按跳转 /assets（M13）', async () => {
    await render(<ProfileScreen />);
    const entry = screen.getByTestId('entry-assets');
    expect(entry).toBeTruthy();
    expect(screen.getByText('参考资产库')).toBeTruthy();
    fireEvent.press(entry);
    expect(mockPush).toHaveBeenCalledWith('/assets');
  });

  it('退出登录清空会话', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByTestId('signout-button'));
    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe('signedOut');
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toBeNull();
  });
});

const mockDir = Directory as unknown as {
  sizeValue: number | null;
  listItems: { name: string; size: number | null; delete: jest.Mock }[];
};

describe('ProfileScreen · M26（关于区 / 清理缓存 / 导出诊断）', () => {
  beforeEach(() => {
    storage.clearAll();
    mockDir.sizeValue = 0;
    mockDir.listItems = [];
    mockSetStringAsync.mockClear();
    useAuthStore.setState({
      status: 'signedIn',
      user: { id: 'u1', email: 'a@b.c', role: 'user' },
    });
    useSettingsStore.setState({
      paletteId: DEFAULT_PALETTE_ID,
      mode: 'light',
      nsfwIntent: false,
      apiBaseOverride: null,
    });
  });

  afterEach(() => {
    // 用例失败时 spy 残留会污染后续用例的调用计数，统一兜底还原
    jest.restoreAllMocks();
  });

  it('关于区渲染：「关于 ToIV」行版本号副标题直显', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByTestId('row-about')).toBeTruthy();
    expect(screen.getByText('关于 ToIV')).toBeTruthy();
    expect(screen.getByText('v9.9.9')).toBeTruthy();
  });

  it('点开关于弹层：产品名 / 定位文案（对齐主站落地页）/ 版权行，关闭后消失', async () => {
    await render(<ProfileScreen />);
    await fireEvent.press(screen.getByTestId('row-about'));
    expect(screen.getByTestId('about-modal')).toBeTruthy();
    expect(screen.getByText('ToIV')).toBeTruthy();
    expect(
      screen.getByText('一个工作台，装下图像、视频与数字人的完整创作流程。'),
    ).toBeTruthy();
    expect(screen.getByText('© 2026 ToIV')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('about-close'));
    expect(screen.queryByText('© 2026 ToIV')).toBeNull();
  });

  it('清理缓存行副标题估算占用（cache 目录 + 非白名单 MMKV 键）', async () => {
    mockDir.sizeValue = 2048;
    storage.set('tmp_cache', 'z'.repeat(10));
    storage.set('assistant_draft:s1', 'y'.repeat(50)); // 白名单不计入
    await render(<ProfileScreen />);
    expect(screen.getByText('占用 2.0 KB')).toBeTruthy();
  });

  it('点清理弹 Alert 二次确认：文案声明保留登录/设置/对话草稿', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<ProfileScreen />);
    await fireEvent.press(screen.getByTestId('row-clear-cache'));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alertSpy.mock.calls[0];
    expect(String(title)).toContain('清理缓存');
    expect(String(message)).toContain('保留');
    expect(String(message)).toContain('草稿');
    expect(buttons?.some((b) => b.style === 'cancel')).toBe(true);
    // 未确认前不删任何键
    expect(storage.contains('toiv.settings')).toBe(true);
  });

  it('确认清理：非白名单键删除 + cache 项删除，白名单（登录/设置/草稿）保留，内联「已清理 N」', async () => {
    const delA = jest.fn();
    mockDir.listItems = [{ name: 'a.png', size: 100, delete: delA }];
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    storage.set('tmp_a', '12345');
    storage.set('toiv.cachedUser', '{"id":"u1"}');
    storage.set('assistant_draft:s1', 'SECRET_DRAFT');
    await render(<ProfileScreen />);

    await fireEvent.press(screen.getByTestId('row-clear-cache'));
    await act(async () => {
      alertSpy.mock.calls[0][2]?.find((b) => b.style === 'destructive')?.onPress?.();
    });

    expect(delA).toHaveBeenCalledTimes(1);
    expect(storage.contains('tmp_a')).toBe(false);
    expect(storage.contains('toiv.settings')).toBe(true);
    expect(storage.contains('toiv.cachedUser')).toBe(true);
    expect(storage.contains('assistant_draft:s1')).toBe(true);
    // freed = 100（文件）+ 5（tmp_a 值）= 105 B
    expect(screen.getByText('已清理 105 B')).toBeTruthy();
  });

  it('取消清理：键与缓存原样保留，无反馈文案', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    storage.set('tmp_a', '12345');
    await render(<ProfileScreen />);
    await fireEvent.press(screen.getByTestId('row-clear-cache'));
    // 不触发任何按钮回调（取消语义）
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(storage.contains('tmp_a')).toBe(true);
    expect(screen.queryByText(/已清理/)).toBeNull();
  });

  it('导出诊断：剪贴板 JSON 形状齐备且脱敏（无 token / 无存储值 / 无邮箱）', async () => {
    storage.set('assistant_draft:s1', 'SECRET_DRAFT');
    storage.set('toiv.cachedUser', '{"email":"a@b.c"}');
    await render(<ProfileScreen />);
    await fireEvent.press(screen.getByTestId('row-export-diagnostics'));
    await waitFor(() => expect(mockSetStringAsync).toHaveBeenCalledTimes(1));

    const payload = mockSetStringAsync.mock.calls[0][0] as string;
    const d = JSON.parse(payload) as {
      app: { name: string; version: string };
      device: { model: string | null };
      config: { apiBase: string; signedIn: boolean; nsfwIntent: boolean };
      storage: { keys: { key: string; size: number }[]; totalBytes: number };
      generatedAt: string;
    };
    expect(d.app.version).toBe('9.9.9');
    expect(d.device.model).toBe('Pixel 8');
    expect(d.config).toEqual({ apiBase: 'https://api.test', signedIn: true, nsfwIntent: false });
    expect(d.storage.keys.map((k) => k.key)).toContain('assistant_draft:s1');
    expect(d.storage.totalBytes).toBe(d.storage.keys.reduce((s, k) => s + k.size, 0));
    expect(Number.isNaN(Date.parse(d.generatedAt))).toBe(false);
    // 脱敏：键名透出、值不透出；登录态仅布尔
    expect(payload).not.toContain('SECRET_DRAFT');
    expect(payload).not.toContain('a@b.c');
    expect(payload).not.toContain('token');
    for (const k of d.storage.keys) {
      expect(Object.keys(k).sort()).toEqual(['key', 'size']);
    }
    expect(screen.getByText('诊断信息已复制')).toBeTruthy();
  });
});
