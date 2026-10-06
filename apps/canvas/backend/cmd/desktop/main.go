package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/desktopupdate"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

func main() {
	// The updater helper must run before defaultDataDir/prepareDesktopApp so a
	// replacement never opens the user database or data directory.
	if done, err := desktopupdate.HandleHelperCommand(os.Args); done {
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := validateDesktopArgs(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	dataDir, err := defaultDataDir()
	if err != nil {
		log.Fatal(err)
	}
	if out, ok := smokeReportPath(os.Args[1:]); ok {
		os.Exit(runToIVSmoke(dataDir, out)) // CI launch smoke: headless, see toiv_smoke.go
	}
	app := newDesktopApp(dataDir)
	gate := app.enableToIV(dataDir)
	toivAllowPrivateUpstream(gate.apiBase())
	toivAllowPrivateUpstream(gate.llmBase())
	if os.Getenv("ENABLE_PROVIDER_PLUGINS") == "" {
		_ = os.Setenv("ENABLE_PROVIDER_PLUGINS", "true") // bundled toiv-h3 is a provider plugin
	}
	startupErrorPath := filepath.Join(dataDir, "startup-error.log")
	if err := prepareDesktopApp(app); err != nil {
		_ = os.MkdirAll(dataDir, 0o755)
		_ = os.WriteFile(startupErrorPath, []byte(err.Error()+"\n"), 0o600)
		log.Fatalf("启动本地后端失败: %v", err)
	}
	_ = os.Remove(startupErrorPath)

	err = wails.Run(&options.App{
		Title:  "ToIV",
		Width:  1440,
		Height: 960,
		Mac:    &mac.Options{},
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Handler:    desktopAssetHandler{app: app},
			Middleware: toivGateMiddleware(app),
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind:       []interface{}{app},
	})
	if err != nil {
		log.Fatal(err)
	}
}

func prepareDesktopApp(app *DesktopApp) error {
	if g := app.gate(); g != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if s := g.loadSession(ctx); s != nil {
			if err := app.activateToIVUser(ctx, s); err != nil {
				log.Printf("ToIV 工作区启动失败（将回到登录页）: %v", err)
			}
		}
		return nil // signed out: the WebView shows the ToIV login page first
	}
	return app.start(context.Background())
}

func defaultDataDir() (string, error) {
	if override := strings.TrimSpace(os.Getenv("CANVAS_DESKTOP_DATA_DIR")); override != "" {
		return override, nil
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("定位用户应用数据目录: %w", err)
	}
	return filepath.Join(root, "ToIV"), nil
}
