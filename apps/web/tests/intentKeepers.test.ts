import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTENT_ENTRIES,
  intentMarketPath,
  intentMarketQuery,
  resolveIntentAppId,
} from "../lib/intentKeepers.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("resolveIntentAppId prefers local altAppId over RH appId", () => {
  assert.equal(resolveIntentAppId({ appId: "rh-acc-x", altAppId: "ovi-i2v" }), "ovi-i2v");
  assert.equal(resolveIntentAppId({ appId: "rh-acc-x", altAppId: "h3-i2v" }), "h3-i2v");
  // alt 是 RH、appId 本地 → 保留本地
  assert.equal(resolveIntentAppId({ appId: "upscale", altAppId: "rh-acc-3722891266-720f7b" }), "upscale");
  assert.equal(resolveIntentAppId({ appId: "removebg" }), "removebg");
});

test("intent keepers: lipsync→ovi-i2v, avatar→avatar-talk (分轨)", () => {
  const lipsync = INTENT_ENTRIES.find((e) => e.id === "lipsync");
  const avatar = INTENT_ENTRIES.find((e) => e.id === "avatar");
  assert.ok(lipsync && avatar);
  assert.equal(resolveIntentAppId(lipsync), "ovi-i2v");
  assert.equal(resolveIntentAppId(avatar), "avatar-talk");
  assert.notEqual(resolveIntentAppId(lipsync), resolveIntentAppId(avatar));
  assert.equal(intentMarketPath(lipsync), "/toiv/market?app=ovi-i2v");
  assert.equal(intentMarketQuery(avatar), "market?app=avatar-talk");
});

test("PortalEmpty uses intentMarketQuery (local-first)", () => {
  const src = readFileSync(join(root, "components/assistant/PortalEmpty.tsx"), "utf8");
  assert.ok(src.includes("intentMarketQuery"));
  assert.ok(!src.includes("market?app=${e.appId}"));
});

test("AvatarTalkView gen deep-links avatar-talk", () => {
  const src = readFileSync(join(root, "components/avatartalk/AvatarTalkView.tsx"), "utf8");
  assert.ok(src.includes("market?app=avatar-talk"));
  assert.ok(src.includes("与对口型分轨"));
});
