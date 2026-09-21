FROM node:20-alpine AS builder

WORKDIR /app

# 构建期统一走 npmmirror：直连 registry.npmjs.org 时常超时
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN echo "registry=https://registry.npmmirror.com" > /root/.npmrc

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages

# --ignore-scripts：跳过 ffmpeg-static 等安装脚本（其 postinstall 需从 github 下载
# 二进制，构建环境不可达也不需要——运行时使用系统 ffmpeg）。构建只需 tsc/vite。
RUN corepack enable && \
    pnpm install --ignore-scripts && \
    pnpm build

FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
RUN echo "registry=https://registry.npmmirror.com" > /root/.npmrc

RUN corepack enable

COPY --from=builder /app/packages/backend/package.json /app/package.json
# workspace 文件随拷：声明 ffmpeg-static 脚本忽略策略（配合下方 --ignore-scripts）
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-lock.yaml

# 运行时使用系统 ffmpeg（FFMPEG_PATH），无需 ffmpeg-static 的下载脚本
RUN pnpm install --prod --ignore-scripts

EXPOSE 3000

CMD ["pnpm", "start"]