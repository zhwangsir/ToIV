package operations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type StudioGateway interface {
	Project(ctx context.Context, userID, projectID string) (map[string]any, error)
	Estimate(ctx context.Context, userID, projectID, shotID string) (map[string]any, error)
}

func RegisterStudioOps(r *Registry, gateway StudioGateway) {
	if r == nil || gateway == nil {
		return
	}
	r.Register(Op{ID: "studio.project.get", Summary: "读取显式授权 Studio 项目的真实生产详情（只读，不修改项目）", ReadOnly: true, Scope: ScopeStudio,
		Params: json.RawMessage(`{"type":"object","properties":{"projectId":{"type":"string"}},"required":["projectId"],"additionalProperties":false}`),
		Handler: func(ctx *Context, params json.RawMessage) (any, error) {
			args, err := studioOperationArgs(params, false)
			if err != nil {
				return nil, err
			}
			detail, err := gateway.Project(operationContext(ctx), ctx.UserID, args.ProjectID)
			if err != nil {
				return nil, AsError(err)
			}
			return map[string]any{"projectId": args.ProjectID, "project": sanitizeForClient(detail)}, nil
		}})
	r.Register(Op{ID: "studio.estimate.preview", Summary: "预览显式授权 Studio 项目或镜头的渲染成本（只读预估，不渲染、不扣费）", ReadOnly: true, Scope: ScopeStudio,
		Params: json.RawMessage(`{"type":"object","properties":{"projectId":{"type":"string"},"shotId":{"type":"string"}},"required":["projectId"],"additionalProperties":false}`),
		Handler: func(ctx *Context, params json.RawMessage) (any, error) {
			args, err := studioOperationArgs(params, true)
			if err != nil {
				return nil, err
			}
			estimate, err := gateway.Estimate(operationContext(ctx), ctx.UserID, args.ProjectID, args.ShotID)
			if err != nil {
				return nil, AsError(err)
			}
			return map[string]any{"projectId": args.ProjectID, "shotId": args.ShotID, "estimate": sanitizeForClient(estimate)}, nil
		}})
	r.Register(Op{ID: "studio.review.propose", Summary: "根据真实 Studio 详情提出人工阶段复核、成本预估与候选比较动作（不确认、不渲染、不选候选）", ReadOnly: true, Scope: ScopeStudio,
		Params: json.RawMessage(`{"type":"object","properties":{"projectId":{"type":"string"}},"required":["projectId"],"additionalProperties":false}`),
		Handler: func(ctx *Context, params json.RawMessage) (any, error) {
			return opStudioReviewPropose(ctx, params, gateway)
		}})
}

type studioArgs struct {
	ProjectID string `json:"projectId"`
	ShotID    string `json:"shotId"`
}

func studioOperationArgs(params json.RawMessage, allowShot bool) (studioArgs, error) {
	var args studioArgs
	if err := decodeParams(params, &args); err != nil {
		return args, err
	}
	args.ProjectID = strings.TrimSpace(args.ProjectID)
	args.ShotID = strings.TrimSpace(args.ShotID)
	if args.ProjectID == "" {
		return args, InvalidArg("invalid_params", "projectId 必填")
	}
	if !allowShot && args.ShotID != "" {
		return args, InvalidArg("unknown_field", "该操作不接受 shotId")
	}
	return args, nil
}

func operationContext(ctx *Context) context.Context {
	if ctx != nil && ctx.Context != nil {
		return ctx.Context
	}
	return context.Background()
}

func opStudioReviewPropose(ctx *Context, params json.RawMessage, gateway StudioGateway) (any, error) {
	args, err := studioOperationArgs(params, false)
	if err != nil {
		return nil, err
	}
	if gateway == nil {
		return nil, PermissionDenied("studio_delegation_required", "Studio 只读委托不可用")
	}
	detail, err := gateway.Project(operationContext(ctx), ctx.UserID, args.ProjectID)
	if err != nil {
		return nil, AsError(err)
	}
	return studioProductionProposal(args.ProjectID, detail), nil
}

var studioStageOrder = []struct {
	id      string
	label   string
	section string
}{
	{id: "script", label: "剧本", section: "script"},
	{id: "assets", label: "资产", section: "assets"},
	{id: "storyboard", label: "分镜", section: "storyboard"},
	{id: "generate", label: "生成", section: "shots"},
	{id: "voice", label: "配音", section: "shots"},
	{id: "timeline", label: "合成", section: "timeline"},
}

func studioProductionProposal(projectID string, detail map[string]any) map[string]any {
	actions := make([]map[string]any, 0, 3)
	warnings := make([]string, 0)
	states, _ := detail["stage_states"].(map[string]any)
	if studioStageStatesComplete(states) {
		for _, stage := range studioStageOrder {
			value, _ := states[stage.id].(map[string]any)
			state, _ := value["state"].(string)
			if state == "confirmed" || state == "skipped" {
				continue
			}
			actions = append(actions, map[string]any{
				"kind": "stage_review", "stage": stage.id, "label": "人工复核" + stage.label + "阶段",
				"section": stage.section, "requiresHuman": true,
			})
			for _, blocker := range studioArray(value["blockers"]) {
				if text, ok := blocker.(string); ok && strings.TrimSpace(text) != "" {
					warnings = append(warnings, strings.TrimSpace(text))
				}
			}
			break
		}
	}

	pendingShot := ""
	candidateShot := ""
	candidateID := ""
	candidatesDigest := ""
	shotCount := 0
	for _, rawShot := range studioArray(detail["shots"]) {
		shot, _ := rawShot.(map[string]any)
		shotCount++
		shotID, _ := shot["id"].(string)
		shotID = strings.TrimSpace(shotID)
		status, _ := shot["status"].(string)
		if pendingShot == "" && shotID != "" && !studioTerminalShot(status) {
			pendingShot = shotID
		}
		if candidateShot == "" && shotID != "" {
			for _, rawCandidate := range studioArray(shot["candidates"]) {
				candidate, _ := rawCandidate.(map[string]any)
				id, _ := candidate["id"].(string)
				if strings.TrimSpace(id) != "" {
					candidateShot = shotID
					candidateID = strings.TrimSpace(id)
					candidatesDigest, _ = shot["candidates_digest"].(string)
					break
				}
			}
		}
	}
	if pendingShot != "" {
		actions = append(actions, map[string]any{
			"kind": "render_estimate", "stage": "generate", "shotId": pendingShot,
			"label": "人工查看待渲染镜头的成本预估", "section": "shots", "requiresHuman": true,
		})
	}
	if candidateShot != "" {
		actions = append(actions, map[string]any{
			"kind": "take_compare", "shotId": candidateShot, "candidateId": candidateID,
			"label": "人工比较真实候选并自行决定", "section": "shots", "requiresHuman": true,
		})
	}
	source := map[string]any{"projectId": projectID, "stageRevision": detail["stage_revision"]}
	if candidateShot != "" {
		source["shotId"] = candidateShot
		source["candidatesDigest"] = candidatesDigest
	}
	return map[string]any{
		"proposalId": "sp-" + strings.TrimPrefix(newProposalID(), "gp-"),
		"kind":       "studio_production", "projectId": projectID,
		"summary":  fmt.Sprintf("基于项目详情：%d 个镜头，提出 %d 项人工后续动作", shotCount, len(actions)),
		"warnings": warnings, "source": source, "nextActions": actions,
	}
}

func studioStageStatesComplete(states map[string]any) bool {
	for _, stage := range studioStageOrder {
		value, _ := states[stage.id].(map[string]any)
		state, _ := value["state"].(string)
		if strings.TrimSpace(state) == "" {
			return false
		}
	}
	return true
}

func studioArray(value any) []any {
	items, _ := value.([]any)
	return items
}

func studioTerminalShot(status string) bool {
	switch strings.TrimSpace(status) {
	case "rendered", "voiced", "lipsynced", "done":
		return true
	default:
		return false
	}
}
