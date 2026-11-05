#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# FeCAWa 2026 — Test du canal de notification FedaPay, de bout en bout.
#
#   ./verifier-webhook.sh
#
# QUE FAIT-IL ?
#   1. Demande à FedaPay d'envoyer un événement de test officiel
#      (POST /v1/webhooks/stub_event)-signé par FedaPay avec le VRAI secret du
#      point de terminaison configuré.
#   2. Observe ce que notre serveur en fait (docker logs).
#   3. Verdict : accepté (le canal fonctionne) ou refusé (le secret du .env ne
#      correspond pas à l'endpoint).
#
# POURQUOI CE TEST EST INDISPENSABLE ?
#   Un webhook peut être « actif » chez FedaPay, pointer sur la bonne URL, et
#   répondre 401 à toutes les notifications : le tableau de bord FedaPay et le
#   site web donnent alors l'impression que tout va bien, alors que plus aucun
#   paiement n'entre en base. C'est exactement ce qui s'est passé le
#   2026-09-27. Chaque point de terminaison FedaPay possede son PROPRE secret :
#   changer, supprimer ou recréer l'endpoint en change le secret.
#
# SORTIE ATTENDUE EN CAS DE SUCCÈS :
#   [Webhook] ✅ Notification FedaPay reçue et authentifiée.
#   [Webhook] Événement: "transaction.approved", Statut: "approved"
#   [Webhook] 🚫 Transaction #… non confirmée par FedaPay   (normal : l'ID du
#                                                            stub n'existe pas)
#   → VERDICT : le canal de notification fonctionne.
# -----------------------------------------------------------------------------
set -uo pipefail

SERVICE="${SERVICE_NAME:-fecawa}"
ENV_FILE="${ENV_FILE:-.env}"

err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

cd "$(dirname "$0")" || exit 1

if [ ! -f "$ENV_FILE" ]; then
  err "Fichier $ENV_FILE introuvable. Lance ce script depuis la racine du projet."
  exit 1
fi

# Charge le .env sans l'exporter en clair dans l'environnement du shell parent.
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

if [ -z "${FEDAPAY_SECRET_KEY:-}" ]; then
  err "FEDAPAY_SECRET_KEY absent de $ENV_FILE."
  exit 1
fi

# Mémorise l'heure de départ pour ne lire que les logs produits par CE test.
START_MARK="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
info "1/3  Envoi d'un événement de test à FedaPay (stub_event)…"

RESPONSE="$(curl -s -m 30 -X POST \
  -H "Authorization: Bearer ${FEDAPAY_SECRET_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"event":"transaction.approved"}' \
  'https://api.fedapay.com/v1/webhooks/stub_event')"

if ! printf '%s' "$RESPONSE" | grep -q '"name"'; then
  err "2/3  FedaPay n'a pas renvoyé d'événement :"
  printf '     %s\n' "$(printf '%s' "$RESPONSE" | head -c 300)"
  err "     Vérifie FEDAPAY_SECRET_KEY et que le compte est bien en mode live."
  exit 1
fi

ok "     FedaPay a envoyé l'événement. Observation des logs…"
info "2/3  Attente de la réception par le conteneur $SERVICE (jusqu'à 60 s)…"

# FedaPay livre de façon ASYNCHRONE : l'événement arrive généralement 15 à 40 s
# après l'appel. On scrute donc les logs jusqu'à apparition d'une trace, au
# lieu d'attendre une durée fixe — sinon le test conclut à tort « indétérminé ».
CURRENT=''
VERDICT=''
for _ in $(seq 1 20); do
  sleep 3
  CURRENT="$(docker logs --since "$START_MARK" "$SERVICE" 2>&1 | grep -E '\[Webhook\]|\[FedaPay Webhook\]' || true)"
  if printf '%s' "$CURRENT" | grep -q 'Notification FedaPay reçue et authentifiée'; then
    VERDICT='accepted'
    break
  fi
  if printf '%s' "$CURRENT" | grep -q 'Signature invalide'; then
    VERDICT='rejected'
    break
  fi
done

LOGS="$CURRENT"

if [ "$VERDICT" = 'accepted' ]; then
  ok "3/3  VERDICT : le canal de notification fonctionne."
  printf '%s\n' "$LOGS" | sed 's/^/     /'
  info ""
  info "Les paiements seront comptabilisés instantanément, sans passer par la"
  info "réconciliation. Tu peux le laisser tourner."
  exit 0
fi

if [ "$VERDICT" = 'rejected' ]; then
  err "3/3  VERDICT : FedaPay livre bien les notifications, mais le serveur les refuse."
  printf '%s\n' "$LOGS" | sed 's/^/     /'
  info ""
  warn "ACTION : le secret FEDAPAY_WEBHOOK_SECRET du serveur ne correspond pas"
  warn "         au point de terminaison FedaPay (chaque endpoint a son propre"
  warn "         secret, différent entre le mode test et le mode live)."
  warn ""
  warn "   1. FedaPay > Workbench > Webhooks"
  warn "   2. Sélectionne l'endpoint https://fecawa.com/api/webhook/fedapay"
  warn "   3. Clique sur « Click to reveal » et copie le secret"
  warn "   4. Remplace FEDAPAY_WEBHOOK_SECRET= dans .env"
  warn "   5. docker compose -f compose.yml up -d --build $SERVICE"
  warn "   6. Relance ce script : le verdict doit devenir « fonctionne »"
  info ""
  info "En attendant, AUCUN paiement n'est perdu : la réconciliation automatique"
  info "(toutes les 10 minutes) interroge FedaPay et crédite la cagnotte."
  exit 2
fi

warn "3/3  VERDICT INDÉTERMINÉ : aucune trace de réception dans les logs."
printf '%s\n' "$LOGS" | sed 's/^/     /'
info ""
warn "Causes possibles :"
warn "  - le conteneur a été recréé pendant le test (relance dans 30 s) ;"
warn "  - l'endpoint FedaPay est désactivé (Workbench > Webhooks) ;"
warn "  - l'URL configurée chez FedaPay n'est pas /api/webhook/fedapay ;"
warn "  - Traefik bloque la requête (routeur fecawa-webhook absent du compose)."
exit 3
