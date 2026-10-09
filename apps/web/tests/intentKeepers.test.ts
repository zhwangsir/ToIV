import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTENT_ENTRIES,
  INTENT_RH_DISPLAY_DEMOTE_IDS,
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

test("similar-merge P1 Slice A: upscale no RH alt; t2i→txt2img-basic; contracts", () => {
  const upscale = INTENT_ENTRIES.find((e) => e.id === "upscale");
  const t2i = INTENT_ENTRIES.find((e) => e.id === "t2i");
  const i2v = INTENT_ENTRIES.find((e) => e.id === "i2v");
  const t2v = INTENT_ENTRIES.find((e) => e.id === "t2v");
  const music = INTENT_ENTRIES.find((e) => e.id === "music");
  const edit = INTENT_ENTRIES.find((e) => e.id === "edit");
  assert.ok(upscale && t2i && i2v && t2v && music && edit);
  assert.equal(upscale.altAppId, undefined);
  assert.equal(resolveIntentAppId(upscale), "upscale");
  assert.equal(resolveIntentAppId(t2i), "txt2img-basic");
  assert.equal(t2i.altAppId, "txt2img-basic");
  assert.equal(t2i.appId, "rh-acc-4888229889-d922f7"); // RH 备选保留
  assert.equal(resolveIntentAppId(i2v), "h3-i2v");
  assert.equal(resolveIntentAppId(t2v), "h3-t2v");
  assert.equal(resolveIntentAppId(music), "ace-music");
  // edit 仍用该 RH id（upscale 摘掉的 alt）
  assert.equal(edit.appId, "rh-acc-3722891266-720f7b");
});

test("similar-merge P1 optional: RH i2v/t2v display demote ids only", () => {
  assert.deepEqual(
    [...INTENT_RH_DISPLAY_DEMOTE_IDS].sort(),
    ["rh-acc-1833790465-924e7f", "rh-acc-8490907650-9066b5"].sort(),
  );
  const i2v = INTENT_ENTRIES.find((e) => e.id === "i2v");
  const t2v = INTENT_ENTRIES.find((e) => e.id === "t2v");
  assert.ok(i2v && t2v);
  assert.ok(INTENT_RH_DISPLAY_DEMOTE_IDS.includes(i2v.appId));
  assert.ok(INTENT_RH_DISPLAY_DEMOTE_IDS.includes(t2v.appId));
  // resolve 仍本地
  assert.equal(resolveIntentAppId(i2v), "h3-i2v");
  assert.equal(resolveIntentAppId(t2v), "h3-t2v");
});
