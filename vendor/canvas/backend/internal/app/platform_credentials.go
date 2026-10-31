package app

import (
	"encoding/json"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/workspace"
)

// Server-side channel credentials (M7, H3 service token).
//
// Workspace (model-config) channel secrets such as the toiv-h3 service token are stored only on
// the server. Browser-facing reads of the model config carry the redaction marker instead
// (handler.redactModelConfig), so the browser submits tasks with a blank or redacted key and the
// server injects the stored credential here, right before the task input is encrypted at rest.
// The base URL is pinned to the stored channel so a credential can never be redirected to a host
// the caller chose.

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
		if needsKey && workspace.IsRedactedSecret(config["apiKey"]) {
			config["apiKey"] = ""
		}
		return input
	}
	return applyPlatformChannelSecrets(input, config, snapshot, needsKey, needsSecret, needsHeaders)
}

func applyPlatformChannelSecrets(input, config map[string]any, snapshot platformProviderSnapshot, needsKey, needsSecret, needsHeaders bool) map[string]any {
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
	// The browser sends channelId only for DB system channels (admission rebuilds those from the
	// server record). Workspace (model-config) channels arrive with an empty channelId and the
	// channel's baseUrl, so match those by id when given, otherwise by base URL origin.
	var match *platformChannel
	if channelID != "" {
		for i := range snapshot.Channels {
			if snapshot.Channels[i].ID == channelID {
				match = &snapshot.Channels[i]
				break
			}
		}
	} else if target := originOf(stringValue(config["baseUrl"])); target != "" {
		for i := range snapshot.Channels {
			if originOf(snapshot.Channels[i].BaseURL) == target && snapshot.Channels[i].APIKey != "" {
				match = &snapshot.Channels[i]
				break
			}
		}
	}
	if match == nil {
		if needsKey && workspace.IsRedactedSecret(config["apiKey"]) {
			// Never forward the redaction marker upstream as if it were a key.
			config["apiKey"] = ""
		}
		return input
	}
	if needsKey && match.APIKey != "" {
		config["apiKey"] = match.APIKey
	}
	if needsSecret {
		config["secretKey"] = match.SecretKey
	}
	if needsHeaders && match.Headers != nil {
		config["headers"] = match.Headers
	}
	if match.BaseURL != "" && originOf(stringValue(config["baseUrl"])) != originOf(match.BaseURL) {
		config["baseUrl"] = match.BaseURL
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
