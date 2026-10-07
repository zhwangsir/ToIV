package app

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync"

	"infinite-canvas/backend/internal/workspace"
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

type platformChannel struct {
	ID        string
	BaseURL   string
	APIKey    string
	SecretKey string
	Headers   any
}

type platformProviderSnapshot struct {
	Channels   []platformChannel
	RunningHub struct {
		BaseURL string
		APIKey  string
	}
}

func (s *Service) platformProviderSnapshot() (platformProviderSnapshot, bool) {
	var out platformProviderSnapshot
	body, err := s.ReadLocalModelConfig()
	if err != nil || len(body) == 0 {
		return out, false
	}
	var raw struct {
		Channels []struct {
			ID        string `json:"id"`
			BaseURL   string `json:"baseUrl"`
			APIKey    string `json:"apiKey"`
			SecretKey string `json:"secretKey"`
			Headers   any    `json:"headers"`
		} `json:"channels"`
		RunningHub struct {
			BaseURL string `json:"baseUrl"`
			APIKey  string `json:"apiKey"`
		} `json:"runningHub"`
	}
	if json.Unmarshal(body, &raw) != nil {
		return out, false
	}
	for _, channel := range raw.Channels {
		out.Channels = append(out.Channels, platformChannel{ID: strings.TrimSpace(channel.ID), BaseURL: strings.TrimSpace(channel.BaseURL),
			APIKey: channel.APIKey, SecretKey: channel.SecretKey, Headers: channel.Headers})
	}
	out.RunningHub.BaseURL = strings.TrimSpace(raw.RunningHub.BaseURL)
	out.RunningHub.APIKey = raw.RunningHub.APIKey
	return out, true
}

func originOf(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return ""
	}
	return strings.ToLower(parsed.Scheme + "://" + parsed.Host)
}

func blankOrRedacted(value any) bool {
	if value == nil {
		return true
	}
	text, ok := value.(string)
	return ok && (strings.TrimSpace(text) == "" || text == workspace.RedactedSecret)
}

func headersCarryRedaction(value any) bool {
	items, _ := value.([]any)
	for _, item := range items {
		if header, ok := item.(map[string]any); ok && workspace.IsRedactedSecret(header["value"]) {
			return true
		}
	}
	return false
}

// resolvePlatformChannelSecrets injects the stored credential of a platform channel into a
// task input whose browser-side copy only carried the redaction marker (or nothing). The
// base URL is pinned to the stored one so a tenant cannot redirect a platform credential to
// a host of their choosing. A tenant's own (non-redacted) key is left untouched.
func (s *Service) resolvePlatformChannelSecrets(input map[string]any) map[string]any {
	if input == nil {
		return input
	}
	config, ok := input["config"].(map[string]any)
	if !ok {
		return input
	}
	needsKey := blankOrRedacted(config["apiKey"])
	needsHeaders := headersCarryRedaction(config["headers"])
	needsSecret := workspace.IsRedactedSecret(config["secretKey"])
	if !needsKey && !needsHeaders && !needsSecret {
		return input
	}
	snapshot, found := s.platformProviderSnapshot()
	if !found {
		return input
	}
	interfaceType := strings.ToLower(strings.TrimSpace(stringValue(config["interfaceType"])))
	if strings.Contains(interfaceType, "runninghub") && strings.TrimSpace(stringValue(config["channelId"])) == "" {
		if snapshot.RunningHub.APIKey != "" && needsKey {
			config["apiKey"] = snapshot.RunningHub.APIKey
			if snapshot.RunningHub.BaseURL != "" {
				config["baseUrl"] = snapshot.RunningHub.BaseURL
			}
		}
		return input
	}
	channelID := strings.TrimSpace(stringValue(config["channelId"]))
	if channelID == "" {
		return input
	}
	for _, channel := range snapshot.Channels {
		if channel.ID != channelID {
			continue
		}
		if needsKey && channel.APIKey != "" {
			config["apiKey"] = channel.APIKey
		}
		if needsSecret {
			config["secretKey"] = channel.SecretKey
		}
		if needsHeaders && channel.Headers != nil {
			config["headers"] = channel.Headers
		}
		if channel.BaseURL != "" && originOf(stringValue(config["baseUrl"])) != originOf(channel.BaseURL) {
			config["baseUrl"] = channel.BaseURL
		}
		return input
	}
	return input
}

// platformRelayKey resolves a redacted/blank relay key from the platform channel whose
// stored base URL has the same origin as the relay target.
func (s *Service) platformRelayKey(targetURL, incoming string) string {
	if !blankOrRedacted(incoming) {
		return incoming
	}
	target := originOf(targetURL)
	if target == "" {
		return incoming
	}
	snapshot, found := s.platformProviderSnapshot()
	if !found {
		return incoming
	}
	for _, channel := range snapshot.Channels {
		if channel.APIKey != "" && originOf(channel.BaseURL) == target {
			return channel.APIKey
		}
	}
	if snapshot.RunningHub.APIKey != "" && originOf(snapshot.RunningHub.BaseURL) == target {
		return snapshot.RunningHub.APIKey
	}
	if incoming == workspace.RedactedSecret {
		return ""
	}
	return incoming
}
