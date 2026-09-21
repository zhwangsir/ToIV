/** deploy-admin.sh 口径契约(批 5 D7 固化):一律 core 本机构建,禁 Mac 构建前置回归。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../deploy/deploy-admin.sh", import.meta.url));

test("无 Mac 构建产物校验(apps/admin/.next/BUILD_ID)", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.equal(
    src.includes("apps/admin/.next/BUILD_ID"),
    false,
    "禁回退 Mac 构建+rsync .next 口径(.next 不可跨机传输)",
  );
});

test("含 core 远端 npm run build 步骤(ssh 内)", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const remoteBuild = src
    .split("\n")
    .some((line) => line.includes("ssh") && line.includes("npm run build"));
  assert.ok(remoteBuild, "缺少 ssh 远端 npm run build 步骤(core 本机构建口径)");
});
