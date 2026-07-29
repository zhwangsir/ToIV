# ToIV 部署

> 2026-07-28 更新:Workstation Docker 已全清,ToIV 生产部署改为**真机 systemd** 方式。`docker-compose.yml` 仍保留,供其他有 Docker 的机器使用。

## 推荐部署目标

- **core** (`192.168.71.47`):真机业务服务器,PG18+Redis 已就位,待 ToIV/DRT 迁移(2026-07-28 设备说明)
- **workstation** (`192.168.71.127`):仍可作为临时运行目标,但 Docker 已禁用,需用真机方式

## 真机部署(推荐)

### 首次部署

```bash
# 1. 确保本机可 ssh 到 core(ssh 别名 core 或 workstation)
# 2. 同步源码并执行远端安装脚本
./deploy/deploy.sh --install
```

`install.sh` 会完成:
- 创建/更新 `apps/api/.venv` 并安装依赖
- `npm install && npm run build`
- 安装并启用 `toiv-api.service` + `toiv-web.service`
- 启动服务并验证 :8090/:3100

### 后续更新

```bash
./deploy/deploy.sh
```

只同步源码并 `systemctl restart toiv-api toiv-web`。

### 部署到 workstation

```bash
./deploy/deploy.sh workstation
# 首次:
./deploy/deploy.sh workstation --install
```

## 环境变量

复制并编辑:

```bash
scp deploy/.env.example core:/home/merlin/toiv/deploy/.env
ssh core
nano /home/merlin/toiv/deploy/.env
```

必填:
- `TOIV_JWT_SECRET`:高强度随机字符串
- `TOIV_ADMIN_PASSWORD`:管理员密码
- `TOIV_CORS_ORIGINS`:如 `https://toiv.dgmt.top`

关键默认已对齐 2026-07-28 设备说明:
- `TOIV_EMBED_BASE_URL=http://192.168.71.127:9302/v1`
- `TOIV_EMBED_MODEL=Qwen3-Embedding-4B`
- `TOIV_TTS_URL=http://192.168.71.127:9200`
- `TOIV_COMFY_WORKERS` 5 后端(workstation 8189-8191 + pc01:8188 + pc02:8193)

## Docker 部署(备选)

如果目标机仍有 Docker:

```bash
cd deploy
cp .env.example .env
# 编辑 .env 后
docker compose up -d --build
```

## cloud 反代(OpenResty)

域名站点:
- `location /api/  → http://<目标机>:8090;`
- `location /      → http://<目标机>:3100;`
- SSE 需 `proxy_buffering off; proxy_read_timeout 1h;`

当前目标机建议改为 core Tailscale IP `100.77.80.100` 或 LAN IP `192.168.71.47`(待 cloud 反切)。

## 管理

```bash
ssh core
sudo systemctl status toiv-api toiv-web
sudo journalctl -u toiv-api -f
sudo journalctl -u toiv-web -f
```
