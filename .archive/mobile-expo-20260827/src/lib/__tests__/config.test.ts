import {
  assertApiBaseSane,
  DEFAULT_API_BASE,
  resolveApiBase,
  setApiBaseOverride,
} from '../config';

describe('config：API 基址解析', () => {
  beforeEach(() => {
    setApiBaseOverride(null);
  });

  it('无覆盖且无 extra 时回落到默认生产值', () => {
    expect(resolveApiBase()).toBe(DEFAULT_API_BASE);
  });

  it('用户覆盖优先于默认值，且自动 trim', () => {
    setApiBaseOverride('  https://api.example.com  ');
    expect(resolveApiBase()).toBe('https://api.example.com');
  });

  it('空白覆盖视为清除', () => {
    setApiBaseOverride('https://api.example.com');
    setApiBaseOverride('   ');
    expect(resolveApiBase()).toBe(DEFAULT_API_BASE);
  });
});

describe('config：生产防呆（assertApiBaseSane）', () => {
  it('开发构建放行回环地址', () => {
    expect(assertApiBaseSane('http://localhost:8090', true)).toBe(true);
  });

  it('生产构建命中 localhost 判为事故并告警', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(assertApiBaseSane('http://localhost:8090', false)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('生产构建命中 127.0.0.1 判为事故', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(assertApiBaseSane('http://127.0.0.1:8090/api', false)).toBe(false);
    warn.mockRestore();
  });

  it('生产构建使用真实域名放行', () => {
    expect(assertApiBaseSane('https://api.toiv.app', false)).toBe(true);
  });
});
