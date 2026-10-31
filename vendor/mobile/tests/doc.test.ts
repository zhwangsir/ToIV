import { describe, expect, it } from 'vitest';

import { DOC_MAX_BYTES, docStatusLabel, formatDocSize, validateDocFile } from '@/utils/doc';

describe('docStatusLabel（MP20，对齐 Web/Mobile 文案）', () => {
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

describe('formatDocSize（MP20，对齐 Web/Mobile 格式化）', () => {
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

  it('≥1MB → `{x.x}MB`（含边界 1MB 与 50MB 上限）', () => {
    expect(formatDocSize(1024 * 1024)).toBe('1.0MB');
    expect(formatDocSize(2.5 * 1024 * 1024)).toBe('2.5MB');
    expect(formatDocSize(DOC_MAX_BYTES)).toBe('50.0MB');
  });
});

describe('validateDocFile（MP20，选文档处客户端先验）', () => {
  it('pdf / docx / txt / md 放行（大小写不敏感）', () => {
    expect(validateDocFile('需求.pdf')).toBeNull();
    expect(validateDocFile('合同.DOCX')).toBeNull();
    expect(validateDocFile('notes.txt')).toBeNull();
    expect(validateDocFile('README.md')).toBeNull();
  });

  it('不支持扩展名 → 人话拒绝', () => {
    expect(validateDocFile('x.exe')).toBe('仅支持 pdf / docx / txt / md 文档');
    expect(validateDocFile('无扩展名')).toBe('仅支持 pdf / docx / txt / md 文档');
    expect(validateDocFile('photo.png')).toBe('仅支持 pdf / docx / txt / md 文档');
  });

  it('尺寸先验：>50MB 拒绝；缺省不验尺寸；边界 50MB 放行', () => {
    expect(validateDocFile('big.pdf', DOC_MAX_BYTES + 1)).toBe('文件超过 50MB 上限');
    expect(validateDocFile('big.pdf', DOC_MAX_BYTES)).toBeNull();
    expect(validateDocFile('unknown.pdf')).toBeNull();
  });
});
