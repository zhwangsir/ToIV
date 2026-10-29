package assistantruntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const hostConfigFile = "agent_config.json"

// HostConfig 记录当前使用的文本模型与宿主启动命令；由本机用户在设置里配置。
type HostConfig struct {
	Model       string   `json:"model"`
	HostCommand string   `json:"hostCommand"`
	HostArgs    []string `json:"hostArgs,omitempty"`
	UpdatedAt   string   `json:"updatedAt,omitempty"`
}

func (h *Host) EffectiveConfig() (HostConfig, bool) {
	config, configured := readHostConfig(h.dataDir())
	if strings.TrimSpace(config.HostCommand) == "" {
		if bundled := BundledConfig(h.executablePath(), h.goos()); bundled.HostCommand != "" {
			config.HostCommand = bundled.HostCommand
			config.HostArgs = bundled.HostArgs
			configured = true
		} else if sibling := SiblingAgentHost(h.executablePath(), workingDir(), h.goos()); sibling.HostCommand != "" {
			// 源码/自托管布局没有应用包:agent-host 就在检出的 apps/canvas 下,
			// 不发现它的话本地面板只会得到 host_start_failed,功能静默缺失。
			config.HostCommand = sibling.HostCommand
			config.HostArgs = sibling.HostArgs
			configured = true
		}
	}
	return config, configured
}

func (h *Host) WriteConfig(config HostConfig) error {
	return writeHostConfig(h.dataDir(), config)
}

func readHostConfig(dataDir string) (HostConfig, bool) {
	raw, err := os.ReadFile(filepath.Join(dataDir, hostConfigFile))
	if err != nil {
		return HostConfig{}, false
	}
	var config HostConfig
	if json.Unmarshal(raw, &config) != nil {
		return HostConfig{}, false
	}
	return config, true
}

func writeHostConfig(dataDir string, config HostConfig) error {
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dataDir, ".agent-config-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(encoded); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(dataDir, hostConfigFile))
}

// BundledConfig 从可执行文件布局解析随包 Node 运行时。
// 桌面两种布局都直接执行 Node；Windows 不能依赖 POSIX shell。
func BundledConfig(executable, goos string) HostConfig {
	if strings.TrimSpace(executable) == "" {
		return HostConfig{}
	}
	root := filepath.Join(filepath.Dir(executable), "..", "Resources", "agent-host")
	node := filepath.Join(root, "runtime", "bin", "node")
	if goos == "windows" {
		root = filepath.Join(filepath.Dir(executable), "agent-host")
		node = filepath.Join(root, "runtime", "node.exe")
	}
	return bundledHostConfig(root, node)
}

func bundledHostConfig(root, node string) HostConfig {
	entry := filepath.Join(root, "server.mjs")
	for _, file := range []string{node, entry} {
		if info, err := os.Stat(file); err != nil || info.IsDir() {
			return HostConfig{}
		}
	}
	return HostConfig{HostCommand: node, HostArgs: []string{entry}}
}

// SiblingAgentHost 解析源码/自托管布局：agent-host 目录在可执行文件旁（bin/ 的上跳）
// 或工作目录旁（go run ./cmd/server 从 backend/ 启动）。
//
// 与 BundledConfig 的区别：随包运行时缺失时允许用 run-agent-host.sh，
// 由它在机器上没有 Node 时明确报错——这层回退只属于开发者自己的机器，
// 应用包布局仍然只认 runtime/ 里的固定 Node。
func SiblingAgentHost(executable, cwd, goos string) HostConfig {
	for _, dir := range siblingHostDirs(executable, cwd) {
		node := filepath.Join(dir, "runtime", "bin", "node")
		if goos == "windows" {
			node = filepath.Join(dir, "runtime", "node.exe")
		}
		if config := bundledHostConfig(dir, node); config.HostCommand != "" {
			return config
		}
		if goos == "windows" {
			continue // run-agent-host.sh 是 POSIX 脚本
		}
		runner := filepath.Join(dir, "run-agent-host.sh")
		if runnerExecutable(runner) && fileExists(filepath.Join(dir, "server.mjs")) {
			return HostConfig{HostCommand: runner}
		}
	}
	return HostConfig{}
}

func siblingHostDirs(executable, cwd string) []string {
	roots := make([]string, 0, 5)
	if strings.TrimSpace(executable) != "" {
		dir := filepath.Dir(executable)
		roots = append(roots, dir, filepath.Dir(dir), filepath.Dir(filepath.Dir(dir)))
	}
	if strings.TrimSpace(cwd) != "" {
		roots = append(roots, cwd, filepath.Dir(cwd))
	}
	dirs := make([]string, 0, len(roots))
	seen := make(map[string]bool, len(roots))
	for _, root := range roots {
		if root == "." || root == string(filepath.Separator) || root == "" {
			continue
		}
		dir := filepath.Join(root, "agent-host")
		if seen[dir] {
			continue
		}
		seen[dir] = true
		dirs = append(dirs, dir)
	}
	return dirs
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func runnerExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

func workingDir() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	return dir
}
