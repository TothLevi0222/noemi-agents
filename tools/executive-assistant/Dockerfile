# Dockerfile
# Project NoéMI - Executive Assistant
#
# Self-contained image: production Node deps + Vite admin UI built in-image
# so ui/dist does not need to be committed.

FROM node:24-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY ui/package.json ./ui/
RUN cd ui && npm install
COPY ui ./ui
RUN cd ui && npm run build

COPY server.js ./
COPY delta-sync.js ./
COPY state-manager.js ./
COPY triage-router.js ./
COPY oauth-manager.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
