package agentops_test

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

func TestStudioScopeRequiresExplicitProjectAndNeverAcceptsCanvasID(t *testing.T) {
	scope := &agentops.AssistantScope{CanvasID: "studio-p1", StudioProjectIDs: map[string]bool{"studio-p1": true}}
	for _, tc := range []struct {
		name, op, params string
		allowed          bool
	}{
		{name: "显式项目可读", op: "studio.project.get", params: `{"projectId":"studio-p1"}`, allowed: true},
		{name: "未授权项目拒绝", op: "studio.project.get", params: `{"projectId":"studio-p2"}`},
		{name: "画布字段不能代替项目授权", op: "studio.project.get", params: `{"canvasId":"studio-p1"}`},
		{name: "预估同 scope", op: "studio.estimate.preview", params: `{"projectId":"studio-p2","shotId":"shot-1"}`},
		{name: "提案同 scope", op: "studio.review.propose", params: `{"projectId":"studio-p1"}`, allowed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := scope.Allows(&agentops.Op{ID: tc.op}, json.RawMessage(tc.params))
			if tc.allowed && err != nil {
				t.Fatalf("范围内调用被拒绝: %v", err)
			}
			if !tc.allowed {
				if err == nil || agentops.AsError(err).Reason != "scope_denied" {
					t.Fatalf("越界必须 scope_denied: %v", err)
				}
			}
		})
	}
}

func TestStudioOpsVisibleOnlyWithExplicitProjectScope(t *testing.T) {
	scope := &agentops.AssistantScope{CanvasID: "canvas-1"}
	for _, id := range []string{"studio.project.get", "studio.estimate.preview", "studio.review.propose"} {
		if scope.Visible(&agentops.Op{ID: id}) {
			t.Fatalf("没有 Studio 授权时不应露出 %s", id)
		}
	}
	scope.StudioProjectIDs = map[string]bool{"studio-p1": true}
	for _, id := range []string{"studio.project.get", "studio.estimate.preview", "studio.review.propose"} {
		if !scope.Visible(&agentops.Op{ID: id}) {
			t.Fatalf("显式 Studio 授权后应露出 %s", id)
		}
	}
}
