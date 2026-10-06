#!/usr/bin/env bash
set -euo pipefail
export PATH=/home/merlin/.local/beeftv-tools/go1.25.0/bin:/home/merlin/.local/beeftv-tools/bun/package/bin:$PATH GOTOOLCHAIN=local GOPROXY=https://goproxy.cn,direct GOFLAGS=-mod=mod
export BUN_CONFIG_REGISTRY=https://registry.npmmirror.com NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
cd /home/merlin/beeftv/backend && CGO_ENABLED=1 go build -o /home/merlin/beeftv-staging/beeftv-server ./cmd/server && echo GO_OK
cd /home/merlin/beeftv/web && bun install --frozen-lockfile && echo INSTALL_OK && bun --bun ./node_modules/vite/bin/vite.js build && echo WEB_OK
rm -rf /home/merlin/beeftv-staging/dist && cp -r /home/merlin/beeftv/web/dist /home/merlin/beeftv-staging/dist && echo COPY_OK
