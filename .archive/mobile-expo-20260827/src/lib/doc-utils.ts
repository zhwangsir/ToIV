/**
 * 文档挂载纯函数（M20.1）：状态文案与尺寸格式化
 * 对齐 Web lib/docs.ts 语义基准（apps/web/components/assistant/AssistantView.tsx 展示同源）
 */

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
export function formatDocSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}
