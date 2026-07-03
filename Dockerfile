# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=development
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=false

FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN yarn build

FROM node:20-alpine AS runner
# ffmpeg is required at runtime to transcode audio: outbound voice notes
# (WebM/Opus → OGG/Opus for WhatsApp) and the cross-browser playback rendition
# (OGG/Opus → AAC/M4A, since Safari/iOS can't decode Opus).
RUN apk add --no-cache openssl curl tini ffmpeg
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=true && yarn cache clean

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/uploads

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -sf http://localhost:3001/docs || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
