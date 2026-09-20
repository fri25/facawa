#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Déploiement automatisé FeCAWa 2026 (Docker + Traefik)
#
# Usage :
#   ./deploy.sh            # déploie (build + up -d) et affiche l'état
#   ./deploy.sh status     # état des conteneurs
#   ./deploy.sh logs       # logs du service fecawa (suivi)
#   ./deploy.sh restart    # redémarre le service
#   ./deploy.sh stop       # arrête le service (données conservées)
#   ./deploy.sh update     # rebuild + redéploiement (après un git pull)
#   ./deploy.sh check      # vérifie les prérequis (docker, réseau, .env)
#
# Le fichier de composition utilisé est compose.yml (standard moderne).
# Toutes les variables (domaine, clés FedaPay, port…) viennent de .env.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Couleurs (désactivées si non-TTY)
# -----------------------------------------------------------------------------
if [ -t 1 ]; then
  C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[0;31m'
  C_CYAN=$'\033[0;36m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_BOLD=""; C_RESET=""
fi

ok()   { echo "${C_GREEN}✔${C_RESET} $*"; }
warn() { echo "${C_YELLOW}⚠${C_RESET} $*"; }
err()  { echo "${C_RED}✘${C_RESET} $*" >&2; }
info() { echo "${C_CYAN}›${C_RESET} $*"; }

# -----------------------------------------------------------------------------
# Constantes
# -----------------------------------------------------------------------------
COMPOSE_FILE="compose.yml"
NETWORK_NAME="proxy"
SERVICE_NAME="fecawa"
ENV_FILE=".env"

# -----------------------------------------------------------------------------
# Prérequis : docker + plugin compose
# -----------------------------------------------------------------------------
check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker n'est pas installé."
    err "Installe-le d'abord : https://docs.docker.com/engine/install/"
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "Le plugin 'docker compose' (v2) n'est pas disponible."
    err "Installe docker-compose-plugin ou mets à jour Docker."
    exit 1
  fi
  ok "Docker + plugin compose disponibles ($(docker compose version --short))"
}

# -----------------------------------------------------------------------------
# Prérequis : fichier .env
# -----------------------------------------------------------------------------
check_env() {
  if [ ! -f "$ENV_FILE" ]; then
    err "Fichier $ENV_FILE introuvable."
    err "Crée-le depuis le modèle :  cp .env.example .env"
    exit 1
  fi
  ok "Fichier $ENV_FILE présent"

  # DOMAIN est obligatoire pour le routing Traefik
  if ! grep -qE '^DOMAIN=.+' "$ENV_FILE"; then
    err "La variable DOMAIN est absente ou vide dans $ENV_FILE."
    err "Ajoute une ligne :  DOMAIN=don.fecawa-waama.org"
    exit 1
  fi
  ok "Variable DOMAIN définie dans $ENV_FILE"
}

# -----------------------------------------------------------------------------
# Prérequis : réseau externe Traefik
# -----------------------------------------------------------------------------
check_network() {
  if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    ok "Réseau externe '$NETWORK_NAME' trouvé"
  else
    warn "Réseau externe '$NETWORK_NAME' introuvable."
    warn "Il doit être créé par ta stack Traefik (ex: docker network create proxy)."
    warn "Je le crée maintenant pour éviter un échec au démarrage…"
    docker network create "$NETWORK_NAME" >/dev/null
    ok "Réseau '$NETWORK_NAME' créé"
  fi
}

# -----------------------------------------------------------------------------
# Déploiement principal
# -----------------------------------------------------------------------------
deploy() {
  info "Déploiement de FeCAWa 2026…"
  docker compose -f "$COMPOSE_FILE" up -d --build
  ok "Conteneurs démarrés"
  echo
  status
  echo
  info "Logs du service (Ctrl+C pour quitter) :"
  docker compose -f "$COMPOSE_FILE" logs -f "$SERVICE_NAME"
}

status() {
  docker compose -f "$COMPOSE_FILE" ps
}

logs() {
  docker compose -f "$COMPOSE_FILE" logs -f "$SERVICE_NAME"
}

restart() {
  info "Redémarrage du service…"
  docker compose -f "$COMPOSE_FILE" restart "$SERVICE_NAME"
  ok "Service redémarré"
  status
}

stop() {
  info "Arrêt du service (les données SQLite sont conservées dans le volume)…"
  docker compose -f "$COMPOSE_FILE" stop
  ok "Service arrêté"
}

update() {
  info "Mise à jour : pull du code + rebuild + redéploiement…"
  git pull --ff-only 2>/dev/null || warn "git pull ignoré (pas de dépôt ou conflit)"
  docker compose -f "$COMPOSE_FILE" up -d --build --force-recreate
  ok "Mise à jour appliquée"
  status
}

check() {
  info "Vérification des prérequis…"
  check_docker
  check_env
  check_network
  ok "Tout est prêt pour le déploiement."
}

# -----------------------------------------------------------------------------
# Dispatch des commandes
# -----------------------------------------------------------------------------
case "${1:-deploy}" in
  deploy)  check_docker; check_env; check_network; deploy ;;
  status)  check_docker; status ;;
  logs)    check_docker; logs ;;
  restart) check_docker; restart ;;
  stop)    check_docker; stop ;;
  update)  check_docker; check_env; check_network; update ;;
  check)   check ;;
  *)
    err "Commande inconnue : $1"
    echo "Usage : $0 [deploy|status|logs|restart|stop|update|check]"
    exit 1
    ;;
esac