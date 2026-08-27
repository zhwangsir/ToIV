import { docStatusLabel, formatDocSize } from '../doc-utils';

describe('docStatusLabel（M20.1，对齐 Web 文案）', () => {
  it('ready → 已索引', () => {
    expect(docStatusLabel('ready')).toBe('已索引');
  });

  it('partial → 部分索引(超长截断)', () => {
    expect(docStatusLabel('partial')).toBe('部分索引(超长截断)');
  });

  it('no_embed → 未索引(向量服务不可用)', () => {
    expect(docStatusLabel('no_embed')).toBe('未索引(向量服务不可用)');
  });

  it('未知状态原样透传（后端新增状态前向兼容）', () => {
    expect(docStatusLabel('processing')).toBe('processing');
  });

  it('空串原样透传', () => {
    expect(docStatusLabel('')).toBe('');
  });
});

describe('formatDocSize（M20.1，对齐 Web 格式化）', () => {
  it('<1024 字节 → `{n}B`（含 0 与边界 1023）', () => {
    expect(formatDocSize(0)).toBe('0B');
    expect(formatDocSize(512)).toBe('512B');
    expect(formatDocSize(1023)).toBe('1023B');
  });

  it('<1MB → `{x.x}KB`（含边界 1024 与 1MB-1）', () => {
    expect(formatDocSize(1024)).toBe('1.0KB');
    expect(formatDocSize(1536)).toBe('1.5KB');
    expect(formatDocSize(1024 * 1024 - 1)).toBe('1024.0KB');
  });

  it('≥1MB → `{x.x}MB`（含边界 1MB）', () => {
    expect(formatDocSize(1024 * 1024)).toBe('1.0MB');
    expect(formatDocSize(2.5 * 1024 * 1024)).toBe('2.5MB');
    expect(formatDocSize(50 * 1024 * 1024)).toBe('50.0MB');
  });
});
