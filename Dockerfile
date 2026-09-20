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
# Attribution des droits sur /app à l'utilisateur non-root 'node' (UID/GID 1000 standard Alpine)
RUN mkdir -p /app/data && chown -R node:node /app

# Port écouté par l'application (3000 par défaut, surchargeable par PORT)
EXPOSE 3000

ENV NODE_ENV=production
ENV DB_FILE=/app/data/fecawa.db

# Exécution sous l'utilisateur non privilégié 'node' (Durcissement sécurité Issue #8)
USER node

CMD ["node", "server/server.js"]