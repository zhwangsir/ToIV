/**
 * 文档挂载纯函数（MP20，语义逐条对齐 Web lib/docs.ts 与 Mobile lib/doc-utils.ts）
 * - 状态文案 / 尺寸格式化与两端同文案，回归测试锁定
 * - validateDocFile 为选文档处客户端先验（扩展名 + 50MB），后端 400/413/422 兜底
 */

/** 支持扩展名（services/docs.py _KINDS；chooseMessageFile/chooseFile extension 同源） */
export const DOC_EXTS = ['pdf', 'docx', 'txt', 'md'];

/** 单文件上限（services/docs.py MAX_FILE_BYTES = 50MB） */
export const DOC_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 文档索引状态 → 人话标签
 * ready→已索引 / partial→部分索引(超长截断) / no_embed→未索引(向量服务不可用)；未知状态原样透传
 */
export function docStatusLabel(status: string): string {
  switch (status) {
    case 'ready':
      return '已索引';
    case 'partial':
      return '部分索引(超长截断)';
    case 'no_embed':
      return '未索引(向量服务不可用)';
    default:
      return status;
  }
}

/** 文档尺寸格式化：<1024 → `{n}B`；<1MB → `{x.x}KB`；否则 `{x.x}MB` */
export function formatDocSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 文档文件客户端先验（扩展名按原始文件名判定：H5 chooseFile 返回 blob: URL 无扩展名，
 * wx 临时路径不保证带扩展名，调用方必须传原始 name；size 可缺省——缺省不验尺寸）
 */
export function validateDocFile(name: string, sizeBytes?: number): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (!DOC_EXTS.includes(ext)) {
    return '仅支持 pdf / docx / txt / md 文档';
  }
  if (sizeBytes !== undefined && sizeBytes > DOC_MAX_BYTES) {
    return '文件超过 50MB 上限';
  }
  return null;
}
