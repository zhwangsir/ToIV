import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPlanSteps,
  planStepPhases,
} from "../components/assistant/MessageList";

test("extractPlanSteps: prefers structured steps", () => {
  const steps = extractPlanSteps(["设计分镜", "出图", "剪辑"], "ignore");
  assert.deepEqual(steps, ["设计分镜", "出图", "剪辑"]);
});

test("extractPlanSteps: infers from numbered body", () => {
  const steps = extractPlanSteps(undefined, "1. 出底图\n2. H3 出三段\n3. 拼接");
  assert.deepEqual(steps, ["出底图", "H3 出三段", "拼接"]);
});

test("extractPlanSteps: fewer than 2 → AvPlanSteps hidden", () => {
  // 结构化不足 2 且 body 推不出列表时，仍返回短数组；UI 侧 length<2 不渲染
  assert.deepEqual(extractPlanSteps(["only"], "no list"), ["only"]);
  assert.deepEqual(extractPlanSteps(undefined, "1. alone"), []);
});

test("planStepPhases: pending / busy / done / reject", () => {
  const s = ["a", "b", "c"];
  assert.deepEqual(planStepPhases(s, undefined, false), ["planned", "planned", "planned"]);
  assert.deepEqual(planStepPhases(s, "approve", true), ["active", "planned", "planned"]);
  assert.deepEqual(planStepPhases(s, "approve", false), ["done", "done", "done"]);
  assert.deepEqual(planStepPhases(s, "reject", false), ["idle", "idle", "idle"]);
});
