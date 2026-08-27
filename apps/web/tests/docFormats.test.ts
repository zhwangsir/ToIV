/**
 * 助手全格式文件识别(2026-08-28)单测(node:test):
 * ① lib/docs 格式矩阵:DOC_ACCEPT 覆盖 office/数据/代码/图片全扩展名
 * ② docKindIcon / docKindFromFilename 类型→图标映射
 * ③ AssistantView 接线:accept 走 DOC_ACCEPT、按钮文案、三处按类型图标
 * ④ ui/Icon:新增文件类型图标已注册(fileimage/filecode/sheet/filejson/filetype/slides)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DOC_ACCEPT,
  DOC_ALL_EXTS,
  docKindFromFilename,
  docKindIcon,
} from "../lib/docs";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/* ── ① 格式矩阵覆盖 ── */
test("DOC_ACCEPT:覆盖 office/数据/代码/图片全扩展名", () => {
  for (const ext of [
    "pdf", "docx", "xlsx", "pptx", // office
    "csv", "json", // 数据
    "txt", "md", "py", "js", "ts", "html", "css", "sql", "sh", "yaml", // 文本/代码
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", // 图片
  ]) {
    assert.ok(DOC_ACCEPT.includes(`.${ext}`), `DOC_ACCEPT 缺 .${ext}`);
  }
  // accept 串与 DOC_ALL_EXTS 一一对应,无遗漏
  assert.equal(DOC_ACCEPT.split(",").length, new Set(DOC_ALL_EXTS).size);
});

/* ── ② 类型→图标映射 ── */
test("docKindIcon:按类型分流图标", () => {
  assert.equal(docKindIcon("png"), "fileimage");
  assert.equal(docKindIcon("JPG"), "fileimage");
  assert.equal(docKindIcon("xlsx"), "sheet");
  assert.equal(docKindIcon("csv"), "sheet");
  assert.equal(docKindIcon("pptx"), "slides");
  assert.equal(docKindIcon("json"), "filejson");
  assert.equal(docKindIcon("pdf"), "file");
  assert.equal(docKindIcon("docx"), "file");
  assert.equal(docKindIcon("py"), "filecode");
  assert.equal(docKindIcon("tsx"), "filecode");
  // 未知类型回退通用文件图标(不炸)
  assert.equal(docKindIcon("exe"), "file");
  assert.equal(docKindIcon(""), "file");
});

test("docKindFromFilename:扩展名提取(历史 chip 推图标用)", () => {
  assert.equal(docKindFromFilename("报表.XLSX"), "xlsx");
  assert.equal(docKindFromFilename("a.tar.gz"), "gz");
  assert.equal(docKindFromFilename("无扩展名"), "");
  assert.equal(docKindIcon(docKindFromFilename("海报.png")), "fileimage");
});

/* ── ③ AssistantView 接线 ── */
test("AssistantView:accept 走 DOC_ACCEPT + 按钮全格式文案", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("accept={DOC_ACCEPT}"), "文件选择器未接 DOC_ACCEPT");
  assert.ok(!src.includes('accept=".pdf,.docx,.txt,.md"'), "旧四格式 accept 残留");
  assert.ok(src.includes("DOC_FORMAT_HINT"), "上传按钮未用全格式提示文案");
});

test("AssistantView:文档列表/挂载 chip/历史 chip 三处按类型图标", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("docKindIcon(doc.kind)"), "文档列表项未按类型图标");
  assert.ok(src.includes("docKindIcon(d.kind)"), "composer 挂载 chip 未按类型图标");
  assert.ok(
    src.includes("docKindIcon(docKindFromFilename(d.filename))"),
    "历史消息 chip 未按扩展名推图标",
  );
});

/* ── ④ Icon 注册 ── */
test("Icon:新增文件类型图标已注册", () => {
  const src = readSrc("components/ui/Icon.tsx");
  for (const name of ["fileimage", "filecode", "sheet", "filejson", "filetype", "slides"]) {
    assert.ok(src.includes(`${name}:`), `Icon 缺 ${name} 映射`);
  }
  for (const cmp of ["FileImage", "FileCode", "FileSpreadsheet", "FileJson", "FileType", "Presentation"]) {
    assert.ok(src.includes(cmp), `Icon 缺 lucide 组件 ${cmp}`);
  }
});
