/** AuditLogView 的 ACTION_LABELS 键契约:全点号命名空间格式(批 1 点号化,防下划线分隔回归)。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const VIEW = fileURLToPath(new URL("../components/admin/AuditLogView.tsx", import.meta.url));

test("ACTION_LABELS 全部键为点号格式(段内下划线合法,分隔符必须是 .)", () => {
  const src = fs.readFileSync(VIEW, "utf8");
  const m = src.match(/ACTION_LABELS:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, "未找到 ACTION_LABELS 字面量");
  const keys = [...m[1].matchAll(/"([^"]+)"\s*:/g)].map((x) => x[1]);
  assert.ok(keys.length >= 10, `键数异常少(${keys.length}),可能解析错对象`);
  for (const k of keys) {
    assert.match(
      k,
      /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/,
      `键「${k}」不是点号格式(批 1 已点号化,禁回退下划线分隔)`,
    );
  }
});
