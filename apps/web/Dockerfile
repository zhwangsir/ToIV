FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry https://registry.npmmirror.com
COPY . .
ARG NEXT_PUBLIC_API_BASE=""
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
# 构建时固化 /api rewrite 目标为 docker compose 网络内的 api 容器名
# (Next.js rewrites 在构建时评估 process.env,运行时改环境变量不会重新生效)
ENV INTERNAL_API_BASE=http://api:8080
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3100
CMD ["node", "server.js"]
