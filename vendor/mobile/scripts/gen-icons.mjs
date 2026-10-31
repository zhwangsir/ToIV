#!/usr/bin/env node
/**
 * Lucide 图标白名单生成器
 * 从 lucide-static 提取所需图标的 SVG 内部内容，生成 icons.generated.ts
 * 用法：npm run gen:icons
 * 规则：全项目只允许 Lucide（用户硬性约束），新增图标在 ICONS 白名单登记后重跑本脚本
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LUCIDE_DIR = join(ROOT, 'node_modules/lucide-static/icons');
const OUT = join(ROOT, 'src/components/ui/icons.generated.ts');

/** 白名单：kebab-case lucide 名 → camelCase 导出名 */
const ICONS = [
  'sparkles',
  'layers',
  'image',
  'user',
  'send',
  'plus',
  'x',
  'check',
  'chevron-down',
  'chevron-right',
  'chevron-up',
  'circle-alert',
  'refresh-cw',
  'trash-2',
  'upload',
  'copy',
  'download',
  'eye',
  'eye-off',
  'settings',
  'palette',
  'moon',
  'sun',
  'log-out',
  'info',
  'search',
  'film',
  'play',
  'clock',
  'zap',
  'sliders-horizontal',
  'image-plus',
  'arrow-left',
  'ellipsis',
  'heart',
  'share-2',
  'wand-sparkles',
  'history',
  'layout-grid',
  'loader-circle',
  'music',
  'box',
  'sun-moon',
  'folder',
  'pencil',
  'square',
  'message-square',
  'paperclip',
  'file-text',
];

function toCamel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function extractInner(svg) {
  const match = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  if (!match) throw new Error('无法解析 SVG 内部内容');
  // 压缩空白，减小包体积
  return match[1].replace(/\s+/g, ' ').trim();
}

const entries = [];
for (const name of ICONS) {
  const file = join(LUCIDE_DIR, `${name}.svg`);
  const svg = readFileSync(file, 'utf8');
  entries.push(`  '${name}': '${extractInner(svg).replace(/'/g, "\\'")}',`);
}

const header = `/**
 * ⚠️ 自动生成文件，请勿手改（npm run gen:icons）
 * 图标源：lucide-static（ISC License, https://lucide.dev）
 * 白名单维护：scripts/gen-icons.mjs ICONS
 */
export const ICON_PATHS: Record<string, string> = {
`;

writeFileSync(OUT, `${header}${entries.join('\n')}\n};\n`, 'utf8');
console.log(`[gen:icons] 生成 ${entries.length} 个图标 → ${OUT}`);
void toCamel; // 预留：如需 camelCase 别名导出在此扩展
