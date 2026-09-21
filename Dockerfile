FROM node:20-alpine AS builder

WORKDIR /app

# ffmpeg-static 的安装脚本从 github releases 下载二进制，国内网络易失败，
# 改用 npmmirror 镜像源（运行时实际使用系统 ffmpeg，此处仅保证构建成功）
ENV FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages

RUN corepack enable && \
    pnpm install && \
    pnpm build

FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

RUN corepack enable

ENV FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static

COPY --from=builder /app/packages/backend/package.json /app/package.json
COPY --from=builder /app/packages/backend/dist /app/dist
COPY --from=builder /app/packages/backend/public /app/public
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-lock.yaml

RUN pnpm install --prod

EXPOSE 3000

CMD ["pnpm", "start"]