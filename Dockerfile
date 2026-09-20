# syntax=docker/dockerfile:1
# FeCAWa 2026 — Image Node.js / Express (SQLite)
# Les variables de configuration (.env) sont injectées par docker-compose,
# elles ne sont pas bakes dans l'image (pas de secrets dans l'image).

FROM node:22-alpine

WORKDIR /app

# Dépendances en premier (cache de couche)
COPY package.json package-lock.json ./
RUN npm ci --only=production --ignore-scripts

# Code applicatif
COPY server ./server
COPY public ./public

# Dossier de données pour la base SQLite (monté en volume persistant)
RUN mkdir -p /app/data

# Port écouté par l'application (3000 par défaut, surchargeable par PORT)
EXPOSE 3000

ENV NODE_ENV=production
ENV DB_FILE=/app/data/fecawa.db

CMD ["node", "server/server.js"]