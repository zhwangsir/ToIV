/**
 * Ordinary H3 duration honesty + i2v history label + extend parent tracker.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ParamField } from "../components/generate/ParamField";
import { ResultPanel, type HistoryEntry } from "../components/generate/ResultPanel";
import { groupEngineParam } from "../components/generate/paramGroups";
import type { EngineInfo, EngineParam } from "../lib/engines";
import {
  H3_EXTEND_DURATION_OPTIONS,
  H3_NATIVE_MAX_SEC,
  clampH3ValuesOnExtendToggle,
  h3HistoryPresentation,
  h3PayloadWentI2v,
  h3TrackerParentPromptId,
  isH3ExtendChildKind,
  overlayOrdinaryH3DurationParams,
} from "../lib/h3VideoUx";

const h = React.createElement;
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

function h3Engine(): EngineInfo {
  return {
    id: "h3-t2v",
    label: "MiniMax H3 文生视频",
    kind: "video",
    available: true,
    nsfw: false,
    ordinary_default: true,
    params: [
      { key: "segment_extend", label: "分段续写", type: "switch", default: false, hint: "开启后可选 20-60 秒" },
      {
        key: "duration", label: "时长", type: "select", default: "5",
        options: [
          { value: "4", label: "4 秒" }, { value: "5", label: "5 秒" },
          { value: "6", label: "6 秒" }, { value: "8", label: "8 秒" },
          { value: "10", label: "10 秒" }, { value: "15", label: "15 秒" },
        ],
      },
    ],
  };
}

test("ordinary H3 default duration options are 4-15 only", () => {
  const dur = overlayOrdinaryH3DurationParams(h3Engine(), { segment_extend: false }).find((p) => p.key === "duration")!;
  assert.deepEqual((dur.options ?? []).map((o) => o.value), ["4", "5", "6", "8", "10", "15"]);
  assert.equal((dur.options ?? []).some((o) => Number(o.value) > H3_NATIVE_MAX_SEC), false);
});

test("ordinary H3 extend switch adds 20/30/45/60 stitch labels", () => {
  const dur = overlayOrdinaryH3DurationParams(h3Engine(), { segment_extend: true }).find((p) => p.key === "duration")!;
  assert.deepEqual((dur.options ?? []).map((o) => o.value).slice(-4), H3_EXTEND_DURATION_OPTIONS.map((o) => o.value));
  assert.match((dur.options ?? []).find((o) => o.value === "20")!.label, /分段续写/);
});

test("turning extend off clamps duration above 15 back to 15", () => {
  const patch = clampH3ValuesOnExtendToggle({ duration: "30", segment_extend: true }, false);
  assert.equal(patch.segment_extend, false);
  assert.equal(patch.duration, "15");
  assert.equal("duration" in clampH3ValuesOnExtendToggle({ duration: "8" }, false), false);
});

test("segment_extend groups with frame/duration, not advanced", () => {
  const p: EngineParam = { key: "segment_extend", label: "分段续写", type: "switch", default: false };
  assert.equal(groupEngineParam(p), "frame");
});

test("ParamField renders 分段续写 switch", () => {
  const html = renderToStaticMarkup(h(ParamField, {
    param: { key: "segment_extend", label: "分段续写", type: "switch", default: false, hint: "开启后可选 20-60 秒" },
    value: false, onChange: () => undefined,
  }));
  assert.match(html, /分段续写/);
});

test("entity-cover i2v: history label is 图生视频, engineId stays h3-t2v", () => {
  const engine = h3Engine();
  assert.equal(h3PayloadWentI2v({ engineId: engine.id, hasRefImage: true }), true);
  assert.equal(h3PayloadWentI2v({ engineId: engine.id, backendKind: "h3_i2v" }), true);
  assert.equal(h3PayloadWentI2v({ engineId: engine.id, hasRefImage: false }), false);
  const shown = h3HistoryPresentation(engine, { wentI2v: true });
  assert.equal(shown.engineId, "h3-t2v");
  assert.match(shown.engineLabel, /图生视频/);
  assert.equal(shown.engineLabel.includes("文生视频"), false);
});

test("ResultPanel shows i2v engine label, not t2v", () => {
  const entry: HistoryEntry = {
    id: "e1", engineId: "h3-t2v", engineLabel: "MiniMax H3 图生视频", kind: "video",
    prompt: "雨中行走", status: "running", paths: [], notice: null, createdAt: Date.now(),
  };
  const html = renderToStaticMarkup(h(ResultPanel, {
    entries: [entry], selectedId: "e1", onSelect: () => undefined,
    liveProgress: { value: 1, max: 8 }, onCancel: () => undefined,
  }));
  assert.match(html, /stage-engine/);
  assert.match(html, /图生视频/);
  assert.equal(html.includes("文生视频"), false);
});

test("duration>15 tracker stays on submit parent prompt_id", () => {
  assert.equal(isH3ExtendChildKind("h3_extend_i2v"), true);
  assert.equal(isH3ExtendChildKind("h3_i2v"), false);
  assert.equal(h3TrackerParentPromptId("parent-1", "h3_i2v"), "parent-1");
  assert.equal(h3TrackerParentPromptId("parent-1", "h3_extend_i2v"), "parent-1");
});

test("GenerateView wires toast, i2v presentation, parent prompt_id poll", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("toast.info(res.duration_notice)"));
  assert.ok(src.includes("h3HistoryPresentation"));
  assert.ok(src.includes("h3PayloadWentI2v"));
  assert.ok(src.includes("overlayOrdinaryH3DurationParams"));
  assert.ok(src.includes("h3TrackerParentPromptId"));
  assert.ok(src.includes("jobs.find((j) => j.prompt_id === promptId)"));
});
