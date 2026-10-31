package protocol

// ToIV patch: declarative "prepare" steps.
//
// Some upstreams need a two-step submission: reference media is uploaded first
// and the create request then refers to the returned handle (ToIV H3 i2v/fl2v/r2v:
// POST /api/upload -> {filename, worker} -> POST /api/h3/i2v {image, worker}).
// A provider may declare ordered prepare steps. The host executes them with the
// same outbound policy, credentials and audit as create; the plugin still only
// describes requests. Each step result is exposed to later steps and to create
// as "prepared.<id>":
//   - value step:     {"id": "mode", "value": <expr>}          -> evaluated value
//   - request step:   {"id": "first", "when": <expr>, "operation": {...}}
//                     -> decoded JSON response (object)
//   - forEach step:   {"id": "refs", "forEach": <expr>, "as": "ref", "operation": {...}}
//                     -> array of decoded JSON responses, one per item
// A step whose "when" is falsy (or whose forEach list is empty) is skipped and
// leaves prepared.<id> unset. Prepare runs only for a new submission; resumed
// tasks go straight to poll.

import (
	"context"
	"fmt"
	"strings"
)

type ManifestPrepareStep struct {
	ID        string             `json:"id"`
	When      any                `json:"when,omitempty"`
	Value     any                `json:"value,omitempty"`
	ForEach   any                `json:"forEach,omitempty"`
	As        string             `json:"as,omitempty"`
	Operation *ManifestOperation `json:"operation,omitempty"`
}

// PrepareStepSpec is one evaluated prepare step. Exactly one of Value (when
// HasValue) or Specs is meaningful. Each=true means the step result is the
// array of all Specs responses, in order.
type PrepareStepSpec struct {
	ID       string
	Skip     bool
	HasValue bool
	Value    any
	Each     bool
	Specs    []RequestSpec
}

// PrepareAdapter is the optional surface for adapters with prepare steps.
type PrepareAdapter interface {
	PrepareStepCount() int
	BuildPrepare(ctx context.Context, c RequestContext, index int, prepared map[string]any) (PrepareStepSpec, error)
	BuildCreatePrepared(ctx context.Context, c RequestContext, prepared map[string]any) (RequestSpec, error)
}

func validateManifestPrepare(steps []ManifestPrepareStep) error {
	seen := make(map[string]struct{}, len(steps))
	for index, step := range steps {
		id := strings.TrimSpace(step.ID)
		if !validPrepareStepID(id) {
			return fmt.Errorf("step %d requires a valid id", index)
		}
		if _, ok := seen[id]; ok {
			return fmt.Errorf("duplicate step id %q", id)
		}
		seen[id] = struct{}{}
		if (step.Operation == nil) == (step.Value == nil) {
			return fmt.Errorf("step %q requires exactly one of operation or value", id)
		}
		if step.Operation != nil {
			if err := validateManifestOperation(*step.Operation); err != nil {
				return fmt.Errorf("step %q operation: %w", id, err)
			}
		} else if step.ForEach != nil {
			return fmt.Errorf("step %q: forEach requires an operation", id)
		}
	}
	return nil
}

// validPrepareStepID keeps ids usable as one "prepared.<id>" path segment.
func validPrepareStepID(id string) bool {
	if id == "" || len(id) > 64 || id[0] < 'a' || id[0] > 'z' {
		return false
	}
	for _, char := range id {
		if !((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_') {
			return false
		}
	}
	return true
}

func (a manifestAdapter) PrepareStepCount() int { return len(a.manifest.Prepare) }

func (a manifestAdapter) BuildPrepare(_ context.Context, c RequestContext, index int, prepared map[string]any) (PrepareStepSpec, error) {
	if index < 0 || index >= len(a.manifest.Prepare) {
		return PrepareStepSpec{}, fmt.Errorf("prepare step %d out of range", index)
	}
	if index == 0 {
		// Reject invalid requests before any upload leaves the host.
		if err := validateManifestRequest(a.manifest.Validations, c.Request); err != nil {
			return PrepareStepSpec{}, err
		}
	}
	step := a.manifest.Prepare[index]
	result := PrepareStepSpec{ID: step.ID}
	if prepared == nil {
		prepared = map[string]any{}
	}
	env := map[string]any{"request": manifestRequestValues(c.Request), "taskId": "", "prepared": prepared}
	if step.When != nil {
		condition, err := evaluateManifestValue(step.When, env)
		if err != nil {
			return result, fmt.Errorf("prepare step %q when: %w", step.ID, err)
		}
		if !manifestTruthy(condition) {
			result.Skip = true
			return result, nil
		}
	}
	if step.Value != nil {
		value, err := evaluateManifestValue(step.Value, env)
		if err != nil {
			return result, fmt.Errorf("prepare step %q value: %w", step.ID, err)
		}
		result.HasValue = true
		result.Value = normalizeManifestValue(value)
		return result, nil
	}
	if step.ForEach == nil {
		spec, err := buildManifestOperationWithEnv(*step.Operation, a.manifest.Auth, c.Request, "", map[string]any{"prepared": prepared})
		if err != nil {
			return result, fmt.Errorf("prepare step %q: %w", step.ID, err)
		}
		result.Specs = []RequestSpec{spec}
		return result, nil
	}
	items, err := evaluateManifestValue(step.ForEach, env)
	if err != nil {
		return result, fmt.Errorf("prepare step %q forEach: %w", step.ID, err)
	}
	alias := strings.TrimSpace(step.As)
	if alias == "" {
		alias = "item"
	}
	result.Each = true
	for itemIndex, item := range manifestArray(items) {
		spec, err := buildManifestOperationWithEnv(*step.Operation, a.manifest.Auth, c.Request, "", map[string]any{"prepared": prepared, alias: item, alias + "Index": itemIndex})
		if err != nil {
			return result, fmt.Errorf("prepare step %q item %d: %w", step.ID, itemIndex, err)
		}
		result.Specs = append(result.Specs, spec)
	}
	if len(result.Specs) == 0 {
		result.Skip = true
	}
	return result, nil
}

func (a manifestAdapter) BuildCreatePrepared(_ context.Context, c RequestContext, prepared map[string]any) (RequestSpec, error) {
	if prepared == nil {
		prepared = map[string]any{}
	}
	return a.buildCreate(c, map[string]any{"prepared": prepared})
}
