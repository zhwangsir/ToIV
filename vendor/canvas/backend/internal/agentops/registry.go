package agentops

import "infinite-canvas/backend/internal/operations"

type (
	Scope         = operations.Scope
	Context       = operations.Context
	Handler       = operations.Handler
	Op            = operations.Op
	Descriptor    = operations.Descriptor
	Caller        = operations.Caller
	CallerKind    = operations.CallerKind
	Request       = operations.Request
	Result        = operations.Result
	Receipt       = operations.Receipt
	Registry      = operations.Registry
	StudioGateway = operations.StudioGateway
)

const (
	ScopeCanvas        = operations.ScopeCanvas
	ScopeWorkspaceRead = operations.ScopeWorkspaceRead
	ScopeStudio        = operations.ScopeStudio
	CallerManual       = operations.CallerManual
	CallerAssistant    = operations.CallerAssistant
	CallerExternal     = operations.CallerExternal
)

func NewRegistry(binder operations.DomainBinder, store *Store) *Registry {
	return operations.NewRegistry(binder, store)
}

func RegisterDefaultOps(r *Registry) { operations.RegisterDefaultOps(r) }

func RegisterStudioOps(r *Registry, gateway StudioGateway) { operations.RegisterStudioOps(r, gateway) }

func ManualCaller(readOnly bool) Caller { return operations.ManualCaller(readOnly) }

func AssistantCaller(scope *AssistantScope, readOnly bool) Caller {
	return operations.AssistantCaller(scope, readOnly)
}

func ExternalCaller(readOnly bool) Caller { return operations.ExternalCaller(readOnly) }
