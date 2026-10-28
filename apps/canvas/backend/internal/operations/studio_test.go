package operations

import (
	"context"
	"encoding/json"
	"testing"
)

type studioGatewayProbe struct {
	detail        map[string]any
	estimate      map[string]any
	projectCalls  int
	estimateCalls int
}

func (p *studioGatewayProbe) Project(context.Context, string, string) (map[string]any, error) {
	p.projectCalls++
	return p.detail, nil
}

func (p *studioGatewayProbe) Estimate(context.Context, string, string, string) (map[string]any, error) {
	p.estimateCalls++
	return p.estimate, nil
}

func TestStudioReviewProposalUsesRealDetailAndOnlyHumanActions(t *testing.T) {
	probe := &studioGatewayProbe{detail: map[string]any{
		"id": "studio-p1", "stage_revision": float64(7),
		"stage_states": map[string]any{
			"script":     map[string]any{"state": "confirmed"},
			"assets":     map[string]any{"state": "skipped"},
			"storyboard": map[string]any{"state": "needs_review", "blockers": []any{"镜头已变化"}},
			"generate":   map[string]any{"state": "confirmed"}, "voice": map[string]any{"state": "confirmed"}, "timeline": map[string]any{"state": "confirmed"},
		},
		"shots": []any{
			map[string]any{"id": "shot-pending", "status": "draft", "candidates": []any{}},
			map[string]any{"id": "shot-candidates", "status": "rendered", "candidates_digest": "digest-1", "candidates": []any{
				map[string]any{"id": "candidate-1"}, map[string]any{"id": "candidate-2"},
			}},
		},
	}}
	registry := NewRegistry(nil, nil)
	RegisterStudioOps(registry, probe)
	descriptor, ok := registry.Descriptor("studio.review.propose")
	if !ok || !descriptor.ReadOnly || descriptor.Scope != ScopeStudio {
		t.Fatalf("review 必须是 ScopeStudio 只读操作: %+v %v", descriptor, ok)
	}
	for _, id := range []string{"studio.project.get", "studio.estimate.preview"} {
		descriptor, ok := registry.Descriptor(id)
		if !ok || !descriptor.ReadOnly || descriptor.Scope != ScopeStudio {
			t.Fatalf("%s 必须是 ScopeStudio 只读操作: %+v %v", id, descriptor, ok)
		}
	}

	result, err := opStudioReviewPropose(&Context{Context: context.Background(), UserID: "user-1", Caller: Caller{Kind: CallerAssistant}}, json.RawMessage(`{"projectId":"studio-p1"}`), probe)
	if err != nil {
		t.Fatal(err)
	}
	proposal := result.(map[string]any)
	if proposal["kind"] != "studio_production" || proposal["projectId"] != "studio-p1" || proposal["proposalId"] == "" {
		t.Fatalf("提案身份不完整: %#v", proposal)
	}
	source := proposal["source"].(map[string]any)
	if source["projectId"] != "studio-p1" || source["stageRevision"] != float64(7) || source["shotId"] != "shot-candidates" || source["candidatesDigest"] != "digest-1" {
		t.Fatalf("提案必须绑定真实 detail 版本和候选: %#v", source)
	}
	actions := proposal["nextActions"].([]map[string]any)
	if len(actions) != 3 {
		t.Fatalf("待确认阶段、待渲染镜头、真实候选应产生三类动作: %#v", actions)
	}
	want := []struct{ kind, stage, section, shotID, candidateID string }{
		{kind: "stage_review", stage: "storyboard", section: "storyboard"},
		{kind: "render_estimate", stage: "generate", section: "shots", shotID: "shot-pending"},
		{kind: "take_compare", section: "shots", shotID: "shot-candidates", candidateID: "candidate-1"},
	}
	for i, expected := range want {
		action := actions[i]
		if action["kind"] != expected.kind || action["requiresHuman"] != true || action["section"] != expected.section {
			t.Fatalf("动作 %d 不是人工只读导航: %#v", i, action)
		}
		if expected.stage != "" && action["stage"] != expected.stage {
			t.Fatalf("动作 %d 阶段错误: %#v", i, action)
		}
		if expected.shotID != "" && action["shotId"] != expected.shotID {
			t.Fatalf("动作 %d 镜头错误: %#v", i, action)
		}
		if expected.candidateID != "" && action["candidateId"] != expected.candidateID {
			t.Fatalf("动作 %d 候选错误: %#v", i, action)
		}
		for _, forbidden := range []string{"execute", "autoExecute", "confirm", "render", "pick", "operationId"} {
			if _, found := action[forbidden]; found {
				t.Fatalf("动作不得包含自动执行字段 %s: %#v", forbidden, action)
			}
		}
	}
	if probe.projectCalls != 1 || probe.estimateCalls != 0 {
		t.Fatalf("review 只能读取 detail，不得创建任务或隐式执行其他调用: %#v", probe)
	}
}

func TestStudioOpsRequireExplicitAssistantScope(t *testing.T) {
	registry := NewRegistry(nil, nil)
	RegisterStudioOps(registry, &studioGatewayProbe{detail: map[string]any{}})
	if descriptors := registry.List(ExternalCaller(false)); len(descriptors) != 0 {
		t.Fatalf("外部调用方不得发现 Studio 操作: %#v", descriptors)
	}
	_, err := registry.Execute(Request{Op: "studio.project.get", UserID: "user-1", Caller: ExternalCaller(false), Params: json.RawMessage(`{"projectId":"studio-p1"}`)})
	if err == nil || AsError(err).Reason != "scope_denied" {
		t.Fatalf("缺少显式回合 scope 必须 scope_denied: %v", err)
	}
}

func TestStudioReviewOmitsActionsWithoutRealEvidence(t *testing.T) {
	probe := &studioGatewayProbe{detail: map[string]any{
		"id": "studio-p2", "stage_revision": float64(2),
		"stage_states": map[string]any{"script": map[string]any{"state": "confirmed"}},
		"shots":        []any{map[string]any{"id": "done", "status": "done", "candidates": []any{map[string]any{"url": "missing-id"}}}},
	}}
	result, err := opStudioReviewPropose(&Context{UserID: "user-1"}, json.RawMessage(`{"projectId":"studio-p2"}`), probe)
	if err != nil {
		t.Fatal(err)
	}
	actions := result.(map[string]any)["nextActions"].([]map[string]any)
	if len(actions) != 0 {
		t.Fatalf("缺 id 的候选和已完成镜头不能编造动作: %#v", actions)
	}
}
