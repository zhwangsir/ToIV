# ToIV 部署

公网架构:`公网 → cloud(OpenResty 80/443 + 证书)→ Tailscale → spark02(Docker:web+api)→ LAN → ComfyUI 4 卡`

## 在 spark02 部署

```bash
git clone https://github.com/zhwangsir/ToIV.git
cd ToIV/deploy
cp .env.example .env      # 填强 JWT 密钥、管理员密码
docker compose up -d --build
```

- web: `http://<spark02>:3100`
- api: `http://<spark02>:8090`(反代到 `/api`)

前端用相对 `/api` 路径(`NEXT_PUBLIC_API_BASE=""`),与 web 同源,由反代把 `/api/*` 路由到 api。

## cloud 反代(OpenResty)

域名(或 IP)站点:
- `location /api/  → http://100.86.42.89:8090;`
- `location /      → http://100.86.42.89:3100;`
- SSE 需 `proxy_buffering off; proxy_read_timeout 1h;`

## 管理 spark02 上的栈

```bash
docker compose -f ToIV/deploy/docker-compose.yml ps
docker compose -f ToIV/deploy/docker-compose.yml logs -f
docker compose -f ToIV/deploy/docker-compose.yml down
```
