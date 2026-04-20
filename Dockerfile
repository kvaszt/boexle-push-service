FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

RUN groupadd --system boexle && useradd --system --no-create-home -g boexle boexle

WORKDIR /app
ENV NODE_ENV=production
# Rate-Limiting braucht die echte Client-IP: hinter Reverse-Proxy mit X-Forwarded-For z. B.
#   docker run -e TRUST_PROXY=1 …
# oder hier aktivieren, wenn der Container immer hinter einem Proxy läuft:
# ENV TRUST_PROXY=1

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN chown -R boexle:boexle /app

USER boexle

EXPOSE 3000

CMD ["node", "dist/index.js"]
