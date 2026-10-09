// Package nasmodels serves Studio's local NAS model picker inventory.
// Prefer docs/NAS_MODEL_PICKER.json when present; otherwise derive h3/ from
// docs/MODEL_SOURCES.json (status=ok). Does not dual-write Python apps/api.
package nasmodels

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	DefaultNASRootRel = "toiv/comfyui-models"
	DefaultH3Worker   = ":8264"
	DefaultChatAlias  = "deepseek-v4-flash-dspark"
	EnvModelsRoot     = "TOIV_NAS_MODELS_ROOT"
	EnvPickerPath     = "TOIV_NAS_PICKER_PATH"
	EnvSourcesPath    = "TOIV_MODEL_SOURCES_PATH"
)

type Entry struct {
	Basename string `json:"basename"`
	RelPath  string `json:"rel_path"`
	Purpose  string `json:"用途,omitempty"`
	Bytes    any    `json:"bytes,omitempty"`
	Group    string `json:"group,omitempty"` // h3 | main
}

type Inventory struct {
	H3             []Entry `json:"h3"`
	Main           []Entry `json:"main"`
	NASRootDefault string  `json:"nas_root_default"`
	H3Worker       string  `json:"h3_worker"`
	ChatAlias      string  `json:"chat_alias"`
	Source         string  `json:"source"`
	UpdatedAt      string  `json:"updated_at,omitempty"`
}

type Binding struct {
	RelPath  string `json:"rel_path"`
	Basename string `json:"basename"`
	Group    string `json:"group"`
	BoundAt  string `json:"bound_at"`
	Note     string `json:"note,omitempty"`
}

type BindingsFile struct {
	H3    *Binding `json:"h3,omitempty"`
	Image *Binding `json:"image,omitempty"` // slice2 placeholder
}

type BindJob struct {
	ID       string   `json:"id"`
	Status   string   `json:"status"` // running|done|error
	Stage    string   `json:"stage"`
	Progress int      `json:"progress"`
	Stages   []string `json:"stages"`
	Error    string   `json:"error,omitempty"`
	Binding  *Binding `json:"binding,omitempty"`
	Hint     string   `json:"hint,omitempty"`
}

type Store struct {
	mu       sync.Mutex
	dataDir  string
	jobs     map[string]*BindJob
	cache    *Inventory
	cacheAt  time.Time
	cacheTTL time.Duration
}

func NewStore(dataDir string) *Store {
	return &Store{dataDir: dataDir, jobs: map[string]*BindJob{}, cacheTTL: 30 * time.Second}
}

func (s *Store) Inventory(group string) (*Inventory, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache != nil && time.Since(s.cacheAt) < s.cacheTTL {
		return filterGroup(s.cache, group), nil
	}
	inv, err := loadInventory()
	if err != nil {
		return nil, err
	}
	s.cache = inv
	s.cacheAt = time.Now()
	return filterGroup(inv, group), nil
}

func filterGroup(inv *Inventory, group string) *Inventory {
	out := *inv
	g := strings.ToLower(strings.TrimSpace(group))
	switch g {
	case "h3":
		out.Main = nil
	case "main":
		out.H3 = nil
	}
	return &out
}

func loadInventory() (*Inventory, error) {
	for _, p := range pickerCandidates() {
		if inv, err := readPicker(p); err == nil {
			return inv, nil
		}
	}
	for _, p := range sourcesCandidates() {
		if inv, err := readSourcesAsPicker(p); err == nil {
			return inv, nil
		}
	}
	return nil, errors.New("NAS 选模清单未找到（docs/NAS_MODEL_PICKER.json 或 MODEL_SOURCES.json）")
}

func pickerCandidates() []string {
	var out []string
	if v := strings.TrimSpace(os.Getenv(EnvPickerPath)); v != "" {
		out = append(out, v)
	}
	out = append(out,
		filepath.Join("docs", "NAS_MODEL_PICKER.json"),
		filepath.Join("..", "..", "..", "..", "docs", "NAS_MODEL_PICKER.json"),
	)
	if root := strings.TrimSpace(os.Getenv(EnvModelsRoot)); root != "" {
		out = append(out, filepath.Join(root, "NAS_MODEL_PICKER.json"))
	}
	return out
}

func sourcesCandidates() []string {
	var out []string
	if v := strings.TrimSpace(os.Getenv(EnvSourcesPath)); v != "" {
		out = append(out, v)
	}
	out = append(out,
		filepath.Join("docs", "MODEL_SOURCES.json"),
		filepath.Join("..", "..", "..", "..", "docs", "MODEL_SOURCES.json"),
	)
	return out
}

func readPicker(path string) (*Inventory, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		UpdatedAt      string  `json:"updated_at"`
		NASRootDefault string  `json:"nas_root_default"`
		H3             []Entry `json:"h3"`
		Main           []Entry `json:"main"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	for i := range doc.H3 {
		doc.H3[i].Group = "h3"
	}
	for i := range doc.Main {
		doc.Main[i].Group = "main"
	}
	root := doc.NASRootDefault
	if root == "" {
		root = DefaultNASRootRel
	}
	if env := strings.TrimSpace(os.Getenv(EnvModelsRoot)); env != "" {
		root = env
	}
	return &Inventory{
		H3: doc.H3, Main: doc.Main, NASRootDefault: root,
		H3Worker: DefaultH3Worker, ChatAlias: DefaultChatAlias,
		Source: path, UpdatedAt: doc.UpdatedAt,
	}, nil
}

func readSourcesAsPicker(path string) (*Inventory, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		UpdatedAt string `json:"updated_at"`
		Items     []struct {
			Basename string `json:"basename"`
			RelPath  string `json:"rel_path"`
			Status   string `json:"status"`
			Bytes    any    `json:"bytes"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	inv := &Inventory{
		NASRootDefault: DefaultNASRootRel,
		H3Worker:       DefaultH3Worker,
		ChatAlias:      DefaultChatAlias,
		Source:         path + "#h3/",
		UpdatedAt:      doc.UpdatedAt,
	}
	if env := strings.TrimSpace(os.Getenv(EnvModelsRoot)); env != "" {
		inv.NASRootDefault = env
	}
	for _, it := range doc.Items {
		if it.Status != "ok" || it.RelPath == "" {
			continue
		}
		e := Entry{Basename: it.Basename, RelPath: it.RelPath, Bytes: it.Bytes}
		if e.Basename == "" {
			e.Basename = filepath.Base(it.RelPath)
		}
		if strings.HasPrefix(it.RelPath, "h3/") {
			e.Group = "h3"
			e.Purpose = "H3"
			inv.H3 = append(inv.H3, e)
		} else {
			e.Group = "main"
			inv.Main = append(inv.Main, e)
		}
	}
	return inv, nil
}

func (s *Store) bindingsPath() string {
	return filepath.Join(s.dataDir, "local-nas-bindings.json")
}

func (s *Store) ReadBindings() (*BindingsFile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.bindingsPath())
	if err != nil {
		if os.IsNotExist(err) {
			return &BindingsFile{}, nil
		}
		return nil, err
	}
	var b BindingsFile
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, err
	}
	return &b, nil
}

func (s *Store) writeBindingsLocked(b *BindingsFile) error {
	if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.bindingsPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.bindingsPath())
}

func (s *Store) StartBind(relPath, group string) (*BindJob, error) {
	relPath = strings.TrimSpace(relPath)
	group = strings.ToLower(strings.TrimSpace(group))
	if group == "" {
		if strings.HasPrefix(relPath, "h3/") {
			group = "h3"
		} else {
			group = "main"
		}
	}
	if group == "h3" && !strings.HasPrefix(relPath, "h3/") {
		return nil, errors.New("H3 绑定仅允许 h3/ 前缀")
	}
	inv, err := s.Inventory(group)
	if err != nil {
		return nil, err
	}
	var match *Entry
	list := inv.H3
	if group != "h3" {
		list = inv.Main
	}
	for i := range list {
		if list[i].RelPath == relPath {
			match = &list[i]
			break
		}
	}
	if match == nil {
		return nil, errors.New("选模清单中未找到该 rel_path（或 status 非 ok）")
	}

	stages := []string{"validate", "refresh/bind", "done"}
	job := &BindJob{
		ID:       strings.ReplaceAll(time.Now().Format("20060102150405.000"), ".", ""),
		Status:   "running",
		Stage:    stages[0],
		Progress: 10,
		Stages:   stages,
		Hint:     "落盘后 refresh 列表；仍不见再重启该 worker（生产 H3=:8264）",
	}
	s.mu.Lock()
	s.jobs[job.ID] = job
	s.mu.Unlock()

	go s.runBind(job.ID, match, group)
	return job, nil
}

func (s *Store) runBind(id string, match *Entry, group string) {
	update := func(stage string, progress int, status string, bind *Binding, errMsg string) {
		s.mu.Lock()
		defer s.mu.Unlock()
		j := s.jobs[id]
		if j == nil {
			return
		}
		j.Stage = stage
		j.Progress = progress
		j.Status = status
		j.Binding = bind
		j.Error = errMsg
	}

	time.Sleep(80 * time.Millisecond)
	update("validate", 35, "running", nil, "")
	time.Sleep(80 * time.Millisecond)
	update("refresh/bind", 70, "running", nil, "")

	bind := &Binding{
		RelPath:  match.RelPath,
		Basename: match.Basename,
		Group:    group,
		BoundAt:  time.Now().UTC().Format(time.RFC3339),
		Note:     "config bind + object_info refresh hook (stub)",
	}
	s.mu.Lock()
	cur, _ := func() (*BindingsFile, error) {
		raw, err := os.ReadFile(s.bindingsPath())
		if err != nil {
			if os.IsNotExist(err) {
				return &BindingsFile{}, nil
			}
			return nil, err
		}
		var b BindingsFile
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		return &b, nil
	}()
	if cur == nil {
		cur = &BindingsFile{}
	}
	if group == "h3" {
		cur.H3 = bind
	} else {
		cur.Image = bind
	}
	err := s.writeBindingsLocked(cur)
	s.mu.Unlock()
	if err != nil {
		update("refresh/bind", 70, "error", nil, err.Error())
		return
	}
	time.Sleep(60 * time.Millisecond)
	update("done", 100, "done", bind, "")
}

func (s *Store) Job(id string) (*BindJob, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, ok := s.jobs[id]
	if !ok {
		return nil, false
	}
	cp := *j
	return &cp, true
}

// LocalDefaults returns the slice-1 local-first preset metadata for UI/tests.
func LocalDefaults() map[string]any {
	return map[string]any{
		"video_channel_name": "本地·H3视频",
		"video_protocol":     "toiv-h3",
		"h3_worker":          DefaultH3Worker,
		"chat_channel_id":    "toiv-llm",
		"chat_channel_name":  "本地·Spark对话",
		"chat_alias":         DefaultChatAlias,
		"nas_root_default":   DefaultNASRootRel,
		"cloud_presets_default_open": false,
		"image_worker_placeholder":   ":8196",
	}
}
