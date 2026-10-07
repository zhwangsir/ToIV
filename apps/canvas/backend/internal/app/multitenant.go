package app

import (
	"errors"
	"strings"
	"sync"

)

// identityWorkspaceCache: bindings are immutable once created, so a process-local cache
// saves one DB round trip per request.
var identityWorkspaceCache sync.Map // subject -> workspace id

// EnsureIdentityWorkspace returns the workspace owned by a verified external identity,
// creating an empty one on first sight (M7 multi-tenant).
func (s *Service) EnsureIdentityWorkspace(subject string) (string, error) {
	subject = strings.TrimSpace(subject)
	if subject == "" || len(subject) > 36 {
		return "", errors.New("身份标识无效")
	}
	if cached, ok := identityWorkspaceCache.Load(subject); ok {
		return cached.(string), nil
	}
	if s == nil || s.repo == nil {
		return "", errors.New("工作区存储未初始化")
	}
	name := "ToIV 用户 " + subject
	if len(subject) > 8 {
		name = "ToIV 用户 " + subject[:8]
	}
	ws, _, err := s.repo.EnsureWorkspaceIdentity(subject, name, "toiv")
	if err != nil {
		return "", err
	}
	identityWorkspaceCache.Store(subject, ws.ID)
	return ws.ID, nil
}

// AssistantTurnWorkspace returns the workspace that opened an assistant turn.
func (s *Service) AssistantTurnWorkspace(turnID string) (string, error) {
	if s == nil || s.repo == nil {
		return "", errors.New("工作区存储未初始化")
	}
	return s.repo.AssistantTurnOwner(strings.TrimSpace(turnID))
}

// DefaultWorkspaceID is the oldest (pre-multi-tenant) workspace.
func (s *Service) DefaultWorkspaceID() (string, error) {
	owner, err := s.LocalWorkspaceOwner()
	if err != nil {
		return "", err
	}
	return owner.ID, nil
}
