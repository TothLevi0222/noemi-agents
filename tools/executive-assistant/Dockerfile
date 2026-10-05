# Dockerfile
# Project NoéMI - Executive Assistant
#
# The builder stage installs the UI toolchain and emits ui/dist.
# The runtime image keeps production server dependencies and that dist.
# ui/node_modules (Vite) stay in the builder.

FROM node:24-alpine AS builder

WORKDIR /usr/src/app

COPY ui/package.json ui/package-lock.json ./ui/
RUN cd ui && npm ci
COPY ui ./ui
RUN cd ui && npm run build

FROM node:24-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /usr/src/app/ui/dist ./ui/dist
# There is no index.js in this tree. package.json "main" / "start" and CMD
# are node server.js. Develop copied a missing index.js from the builder.
COPY server.js ./
COPY delta-sync.js ./
COPY state-manager.js ./
COPY triage-router.js ./
COPY oauth-manager.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
