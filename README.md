# FeCAWa 2026 — Plateforme de Souscription & Don en Ligne
**Festival Culturel et Artistique Waama (3ᵉ édition) — 19 au 21 novembre 2026 (Natitingou, Bénin)**

---

Application web moderne, fluide et responsive (mobile-first) dédiée à la collecte de dons et de souscriptions citoyennes pour la 3ᵉ édition du **Festival FeCAWa**. Elle intègre le paiement sécurisé **FedaPay** (Mobile Money MTN, Moov, Celtis et cartes bancaires), un backend **Node.js / Express**, une base de données **SQLite**, et un tableau public des souscripteurs en temps réel.

---

## 📁 Arborescence du Projet

```text
fecawa/
├── package.json                     # Dépendances du projet et scripts
├── .env.example                     # Modèle des variables d'environnement
├── .env                             # Variables locales (clés FedaPay, port, etc.)
├── .gitignore                       # Fichiers ignorés par git
├── README.md                        # Documentation complète et guide de déploiement
│
├── Dockerfile                       # Image Node.js 22 Alpine (déploiement Docker)
├── compose.yml                      # Composition Docker + Traefik (réseau externe "proxy")
├── deploy.sh                        # Script d'automatisation du déploiement
├── .dockerignore                    # Exclusion des fichiers sensibles du build Docker
│
├── server/                          # Backend Node.js + Express
│   ├── server.js                    # Point d'entrée, sécurité Helmet/CSP, CORS, rate-limiting
│   ├── config/
│   │   └── database.js              # Initialisation SQLite, schémas, index et repository (DAO)
│   ├── services/
│   │   ├── fedapay.service.js       # Client API FedaPay (transactions, tokens, vérification)
│   │   ├── reconciliation.service.js # Rattrapage des transactions en attente (cyclique)
│   │   ├── watchdog.service.js      # Détecte les encaissements non comptabilisés
│   │   ├── alert.service.js         # Alertes Discord (embeds, anti-spam, secret jamais loggé)
│   │   ├── client-ip.service.js      # IP client non falsifiable (Cloudflare → Traefik → app)
│   │   └── phone.service.js          # Normalisation du numéro de téléphone par pays
│   ├── controllers/
│   │   ├── donation.controller.js   # Création de don, vérification, flux souscripteurs
│   │   ├── webhook.controller.js    # Réception et validation du Webhook transaction.approved
│   │   └── export.controller.js     # Relevé CSV complet protégé par jeton secret
│   ├── routes/
│   │   └── api.js                   # Routes REST (/api/create-transaction, /api/webhook/..., etc.)
│   └── middleware/
│       └── validation.js            # Validation stricte et nettoyage anti-XSS
│
├── data/
│   └── fecawa.db                    # Base de données SQLite persistante (auto-générée)
│
└── public/                          # Frontend moderne (Mobile-First)
    ├── index.html                   # Page d'accueil : Hero, participants, formulaire modal de don, Checkout
    ├── confirmation.html            # Page de confirmation, bénédiction et reçu imprimable
    ├── css/
    │   └── style.css                # Styles culturels Waama (terracotta, ocre, responsive)
    ├── js/
    │   └── app.js                   # Formulaire de souscription, focus-trap modal et feed des participants
    └── assets/
        ├── logo.jpeg                # Logo officiel du festival FeCAWa
        ├── pattern.svg              # Motif géométrique inspiré de l'architecture Tata Somba
        └── favicon.svg              # Favicon au symbole traditionnel
```

---

## 🎨 Identité Visuelle Waama & Fonctionnalités

- **Palette culturelle** : Teintes chaleureuses de l'Atacora (Terracotta `#C85A32`, Ocre doré `#D9822B`, Brun Terre `#24160E`, Crème douce `#FBF8F4`).
- **Mobile-first** : Optimisé pour les smartphones (90%+ des donateurs Mobile Money).
- **Montants suggérés & champ libre** : Boutons rapides (1 000 F, 2 000 F, 5 000 F, 10 000 F CFA) ou montant sur mesure.
- **Confidentialité maîtrisée** : Chaque donateur peut choisir de publier son nom, de rester anonyme ou de masquer le montant.
- **Reçu & Bénédiction** : *"Que Dieu bénisse ces généreux donateurs"* avec reçu imprimable et partage WhatsApp en 1 clic.
- **Tableau d'honneur en direct** : Recherche instantanée et compteurs actualisés (total collecté, donateurs mobilisés).

---

## 🚀 Installation & Démarrage Rapide

### 1. Prérequis
- [Node.js](https://nodejs.org/) v18 ou supérieur (testé et validé sur Node.js v22).
- npm (fourni avec Node.js).

### 2. Cloner et installer les dépendances
```bash
# Se placer dans le dossier du projet
cd fecawa

# Installer les packages
npm install
```

### 3. Configurer l'environnement
Copiez le fichier d'exemple pour créer votre fichier `.env` :
```bash
cp .env.example .env
```

Par défaut, l'application démarre immédiatement avec un simulateur intégré si aucune clé n'est configurée, ce qui permet de tester l'interface locale en toute simplicité.

### 4. Lancer le serveur
```bash
# Mode production
npm start

# Mode développement avec rechargement automatique
npm run dev
```

Accédez ensuite à l'application sur : **`http://localhost:3000`**

---

## 🔑 Configuration FedaPay (Sandbox & Live)

FedaPay permet d'encaisser les dons via **MTN Mobile Money**, **Moov Money**, **Celtis Cash** et **Cartes bancaires (Visa / Mastercard)** avec un seul compte unifié.

### A. Obtenir vos clés Sandbox (Phase de Test)
1. Rendez-vous sur [https://sandbox.fedapay.com](https://sandbox.fedapay.com) et créez un compte.
2. Allez dans le menu **Paramètres** > **Clés d'API**.
3. Copiez votre **Clé Publique** (`pk_sandbox_...`) et votre **Clé Secrète** (`sk_sandbox_...`).
4. Dans votre fichier `.env` :
   ```env
   FEDAPAY_ENV=sandbox
   FEDAPAY_PUBLIC_KEY=pk_sandbox_votre_cle_ici
   FEDAPAY_SECRET_KEY=sk_sandbox_votre_cle_ici
   ```

### B. Numéros de Test FedaPay en Sandbox
Pour simuler un paiement en mode Sandbox :
- **MTN Bénin** : Utilisez n'importe quel numéro commençant par `61`, `62`, `66`, `67`, `69` (ex: `61000000`). Code OTP de test : `1234` ou validez directement dans le simulateur FedaPay.
- **Moov Bénin** : Utilisez un numéro commençant par `94`, `95`, `96`, `97` (ex: `95000000`).
- **Carte bancaire** : Utilisez les numéros de cartes de test fournis dans la documentation FedaPay.

### C. Passer en Production (Live)
1. Créez votre compte sur [https://fedapay.com](https://fedapay.com) et soumettez vos pièces administratives (KYC / enregistrement de l'association ou du comité FeCAWa).
2. Récupérez vos clés de production : `pk_live_...` et `sk_live_...`.
3. Dans votre fichier `.env` sur le serveur de production :
   ```env
   FEDAPAY_ENV=live
   FEDAPAY_PUBLIC_KEY=pk_live_votre_cle_reelle
   FEDAPAY_SECRET_KEY=sk_live_votre_cle_reelle
   APP_URL=https://votre-domaine-fecawa.org
   ```

---

## ⚡ Configuration du Webhook FedaPay

Le webhook permet à votre serveur de recevoir automatiquement la notification instantanée de FedaPay dès qu'un donateur a validé son paiement sur son téléphone.

### A. URL du Webhook
Votre endpoint webhook est :
```
POST https://votre-domaine.org/api/webhook/fedapay
```

### B. Configuration dans le Dashboard FedaPay
1. Dans le tableau de bord FedaPay (Sandbox ou Live), allez dans **Développeurs** > **Webhooks**.
2. Cliquez sur **Ajouter un endpoint**.
3. Saisissez l'URL de votre endpoint : `https://votre-domaine.org/api/webhook/fedapay`.
4. Sélectionnez les événements : cochez au minimum `transaction.approved`, `transaction.declined`, `transaction.canceled`.
5. FedaPay génère un **Secret de signature**. Copiez-le et ajoutez-le dans votre `.env` :
   ```env
   FEDAPAY_WEBHOOK_SECRET=whsec_votre_secret_ici
   ```

### C. Tester le Webhook en Local avec Ngrok
Si vous testez en local sur votre machine, utilisez [ngrok](https://ngrok.com/) pour exposer votre port 3000 :
```bash
ngrok http 3000
```
Copiez l'URL HTTPS fournie par ngrok (ex: `https://abcd-123.ngrok-free.app`) et configurez `https://abcd-123.ngrok-free.app/api/webhook/fedapay` dans le dashboard FedaPay.

### D. ⚠️ Trois pièges qui bloquent la cagnotte (incident du 27/09/2026)

Le 27 septembre 2026, des paiements étaient réellement encaissés par FedaPay tandis que le compteur du site restait bloqué à 0. Les trois causes se cumulaient, et **aucune ne venait du code applicatif** :

1. **L'URL du webhook pointait vers la racine du site** (`https://fecawa.com/`) au lieu de `/api/webhook/fedapay`. Les notifications partaient sur la page d'accueil.
2. **Le webhook avait été auto-désactivé** par FedaPay après ces erreurs (`disable_on_error`). Résultat : plus aucune notification, et rien sur le site pour le signaler.
3. **Le routeur Cloudflare-only rejetait FedaPay en amont** : le middleware Traefik `fecawa-cfonly` (voir `compose.yml`) refuse toute requête dont l'IP source n'est pas une IP Cloudflare, or les serveurs FedaPay ne passent pas par Cloudflare. Vérification : `curl --resolve votre-domaine:443:<IP_DU_SERVEUR> -X POST https://votre-domaine/api/webhook/fedapay` → `403`.

Le correctif appliqué :
- un routeur Traefik dédié `fecawa-webhook`, restreint par `PathPrefix(/api/webhook)` et **sans** l'ipwhitelist Cloudflare — le reste du site reste accessible uniquement via Cloudflare. L'endpoint reste protégé par l'en-tête secret `X-Fecawa-Gate` (anti-accès des autres conteneurs du réseau partagé), par la **signature HMAC-SHA256 obligatoire avec timestamp frais** et par son propre rate-limit ;
- `disable_on_error` désactivé chez FedaPay, pour qu'une erreur réseau n'arrête plus silencieusement la collecte ;
- une **réconciliation automatique** (`RECONCILIATION_*`, voir `.env.example`) qui interroge FedaPay toutes les 10 minutes pour les transactions restées `pending` : c'est le second filet de sécurité, indispensable quand la notification est perdue, quand le donataire ferme l'onglet, ou quand le webhook est mal configuré.

**Vérification rapide après toute modification du webhook :**
```bash
# Test de bout en bout, une seule commande : FedaPay envoie un événement officiel
# signé avec le VRAI secret de l'endpoint, et le script dit si le serveur l'accepte.
./verifier-webhook.sh
#   « le canal de notification fonctionne »  → exit 0
#   « FedaPay livre, le serveur refuse »     → exit 2 (secret à corriger)

# Pour les diagnostics manuels :
# 1. Le webhook FedaPay est-il actif et sur la bonne URL ?
curl -s -H "Authorization: Bearer $FEDAPAY_SECRET_KEY" https://api.fedapay.com/v1/webhooks
#    → "url":"https://votre-domaine.org/api/webhook/fedapay", "enabled":true

# 2. L'endpoint répond-il hors Cloudflare (comme FedaPay) ?
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://votre-domaine.org/api/webhook/fedapay
#    → 401 Signature invalide = REÇU par l'application. 403 = bloqué par Traefik.
```
Et dans les logs du conteneur, toute notification donne une ligne `[Webhook] Notification FedaPay reçue.` En cas de paiement encaissé mais non compté, cette ligne est le point de départ.

---

## 🚨 Surveillance de la cagnotte (watchdog) et alertes

Deux filets (webhook, réconciliation) ne suffisent pas : ils peuvent tomber en même temps, silencieusement. Le watchdog est le troisième — il **détecte qu'un encaissement n'a pas été comptabilisé et prévient un humain sur Discord**.

Il tourne à la fin de chaque cycle de réconciliation (toutes les 10 min) et surveille quatre conditions :

| Condition | Sévérité | Déclencheur | Sens |
|---|---|---|---|
| `pending_stale` | 🚨 critique | un don `pending` depuis plus de `ALERT_PENDING_MINUTES` (30 min) | paiement encaissé non comptabilisé |
| `webhook_silent` | 🚨 critique | aucune notification depuis `ALERT_WEBHOOK_SILENT_HOURS` (2 h) **alors que des dons arrivent** | canal de notification cassé |
| `webhook_rejected` | 🚨 critique | `ALERT_WEBHOOK_REJECTED` (3) notifications rejetées pour signature invalide | **FedaPay livre, le serveur refuse** |
| `feda_unreachable` | 🚨 critique | `ALERT_RECONCILIATION_ERRORS` (3) cycles de réconciliation ratés d'affilée | filet de sécurité aveugle |
| `quota_low` | ⚠️ avertissement | budget d'appels FedaPay à 90 % | la réconciliation va échouer en bloc |

### ⚠️ `webhook_rejected` : le piège du secret par point de terminaison

**Chaque point de terminaison FedaPay a son PROPRE secret** (unique, et différent entre le mode test et le mode live). Si `FEDAPAY_WEBHOOK_SECRET` ne correspond pas à l'endpoint configuré, FedaPay livre normalement ses notifications et le serveur les refuse **toutes** : la cagnotte reste figée, silencieusement, et le tableau de bord FedaPay affiche un webhook actif et une URL qui répond.

C'est exactement ce qui est arrivé le 2026-09-27. Le watchdog compte désormais les refus et trace leur source (IP + User-Agent) : l'alerte part sur Discord dès le 3ᵉ refus, avec l'action à faire :

> Workbench → Webhooks → ton endpoint → « Click to reveal » → remplacer `FEDAPAY_WEBHOOK_SECRET` dans le `.env` → recréer le conteneur.

Le compteur ne se remet à zéro que sur une notification **valide** : la levée de l'alerte est donc la preuve que le canal est rétabli.

Chaque condition n'est annoncée **qu'à son apparition**, jamais à chaque cycle (anti-spam, `ALERT_COOLDOWN_MINUTES`), et sa disparition déclenche une alerte **« Résolu »** : sans cela, impossible de savoir si la panne est finie.

**Configurer Discord** : dans Discord, *Paramètres du salon → Intégrations → Webhooks → Nouveau webhook*, puis copier l'URL dans `.env` :
```env
ALERT_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
```
Sans cette variable, le watchdog fonctionne en **mode sec** : les alertes apparaissent uniquement dans les logs (`docker logs fecawa | grep "\[Alerte\]"`). L'URL du webhook est un secret : elle n'est **jamais** journalisée, et seule une URL de `discord.com` / `discordapp.com` est acceptée (pas de SSRF possible par configuration).

Aucune donnée nominative ne part sur Discord : uniquement identifiant de transaction, montant et ancienneté. Le nom du donataire se retrouve dans l'export ou Adminer.

---

## 📊 Export CSV des souscriptions (réservé à l'organisation)

Page : **`https://fecawa.com/export.html`** — non liée depuis le site, `noindex` + `X-Robots-Tag: noindex`, `Cache-Control: no-store`.

Le relevé est **complet** : tous les statuts (encaissé, expiré, refusé, en attente), avec nom, prénom, téléphone, e-mail, message, référence FedaPay et moyen de paiement. C'est la vue du rapprochement comptable et de l'émission des reçus — pas la liste publique, anonymisée.

### Générer le jeton d'accès
```bash
openssl rand -hex 24      # 48 caractères
```
puis dans `.env` :
```env
FECAWAY_EXPORT_TOKEN=<le jeton généré>
```

Le jeton n'est **jamais accepté en URL** (ni logs d'accès, ni historique, ni `Referer`) : la page le place dans l'en-tête `X-Export-Token`, et le téléchargement se fait en un clic.

### Sécurité de l'export

| Protection | Mise en œuvre |
|---|---|
| Jeton secret | comparaison **en temps constant**, jamais journalisé |
| Longueur minimale | 32 caractères minimum : un jeton faible renvoie `503` et n'ouvre **rien** (pas d'acceptation silencieuse) |
| Absent | `503` — l'export est fermé par défaut, jamais ouvert par oubli de configuration |
| Déni de service | rate-limit dédié : 20 tentatives / 15 min / IP |
| Réseau | routeur Traefik du site, accessible **uniquement via Cloudflare** ; les autres conteneurs du réseau partagé sont bloqués (`fecawa-gate`) |
| Fuite en cache | `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` |
| Données minimisées | ni `feda_token` ni empreinte du jeton de reçu dans le fichier |
| Indexation | page non liée, `noindex` (HTML + en-tête HTTP) |

**Risques résiduels assumés** : le jeton est mémorisé dans le `sessionStorage` de l'onglet (comme le jeton de reçu des dons) ; si le site était un jour compromis par une XSS, ce jeton serait exposé — il suffit alors de le régénérer et de redémarrer le conteneur. Le CSV contient des données personnelles : à supprimer après usage.

---

## 🛡️ Sécurité & Bonnes Pratiques

- **Clé secrète protégée** : `FEDAPAY_SECRET_KEY` ne réside qu'au niveau du serveur Express et n'est **JAMAIS** renvoyée ou exposée au navigateur client.
- **Politique de Sécurité du Contenu (CSP)** : Configurée avec `Helmet` pour n'autoriser les scripts et iframes que depuis le domaine officiel `*.fedapay.com`.
- **Protection Anti-Spam** : `express-rate-limit` plafonne les tentatives de création de transactions pour parer aux attaques automatisées.
- **Protection par requêtes préparées** : Toutes les écritures SQLite utilisent des requêtes paramétrées avec placeholders `?`, immunisant le système contre les injections SQL.
- **Nettoyage XSS** : Tous les noms, prénoms et messages sont nettoyés et désinfectés avant enregistrement et échappés côté frontend.

---

## 🗄️ Migration vers PostgreSQL (Optionnel pour Fort Trafic)

L'architecture actuelle s'appuie sur le repository modulaire [`server/config/database.js`](file:///c:/Users/hp%20EliteBook%20840%20G6/Desktop/fecawa/server/config/database.js). Pour migrer vers PostgreSQL :
1. Installez `pg` : `npm install pg`.
2. Remplacez l'instance SQLite dans `database.js` par un pool `new pg.Pool({ connectionString: process.env.DATABASE_URL })`.
3. Le schéma SQL reste identique (la structure standardisée des colonnes est 100% compatible SQL standard).

---

## 🌐 Guide de Déploiement

### Option 0 : Déploiement Docker + Traefik (recommandé)

Le projet est conteneurisé (`Dockerfile` + `compose.yml`) et conçu pour être déployé derrière un **Traefik** déjà présent sur votre VPS, via le réseau externe `proxy`.

**Fichiers de déploiement :**
- `Dockerfile` — image Node.js 22 Alpine (Express + SQLite)
- `compose.yml` — composition standard moderne (réseau `proxy`, volume persistant, labels Traefik)
- `deploy.sh` — script d'automatisation complet (déploiement, logs, restart, update, check)
- `.dockerignore` — exclusion des fichiers sensibles du contexte de build

**1. Prérequis sur le VPS :**
- Docker + plugin `docker compose` (v2)
- Un réseau Docker externe nommé `proxy` (celui de votre stack Traefik) :
  ```bash
  docker network create proxy   # si pas déjà créé par Traefik
  ```

**2. Configuration (tout passe par `.env`, jamais par le compose) :**
```env
DOMAIN=don.fecawa-waama.org        # domaine public routé par Traefik
PORT=3000                          # port interne (défaut)
FEDAPAY_ENV=sandbox                # ou live
FEDAPAY_PUBLIC_KEY=pk_sandbox_...
FEDAPAY_SECRET_KEY=sk_sandbox_...
FEDAPAY_WEBHOOK_SECRET=whsec_...
APP_URL=https://don.fecawa-waama.org
```

**3. Déploiement en une commande :**
```bash
chmod +x deploy.sh
./deploy.sh
```

**Commandes du script :**
```bash
./deploy.sh            # déploie (build + up -d) puis suit les logs
./deploy.sh status     # état des conteneurs
./deploy.sh logs       # logs du service fecawa
./deploy.sh restart    # redémarre le service
./deploy.sh stop       # arrête (données SQLite conservées)
./deploy.sh update     # git pull + rebuild + redéploiement
./deploy.sh check      # vérifie docker, .env, réseau proxy
```

**4. DNS :** votre domaine doit pointer vers l'IP du VPS (record **A**). Traefik obtient automatiquement le certificat HTTPS (LetsEncrypt).

**5. Webhook FedaPay :** configurez `https://votre-domaine.org/api/webhook/fedapay` dans le dashboard FedaPay (voir section Webhook ci-dessous).

> **Changer de domaine ou de clés ?** Modifiez uniquement `.env`, puis relancez `./deploy.sh` — aucune modification du `compose.yml` n'est nécessaire.

### Option 1 : Déploiement sur Render.com (Simple & Gratuit / Économique)
1. Poussez votre code sur GitHub / GitLab.
2. Sur [Render](https://render.com/), créez un nouveau **Web Service**.
3. Connectez votre dépôt.
4. Paramètres :
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
5. Dans la section **Environment Variables**, ajoutez les variables de votre `.env` (`FEDAPAY_ENV`, `FEDAPAY_PUBLIC_KEY`, `FEDAPAY_SECRET_KEY`, `APP_URL`).
6. Ajoutez un disque persistant (Persistent Disk) monté sur `/data` si vous souhaitez conserver le fichier SQLite `fecawa.db` entre les redémarrages.

### Option 2 : Déploiement sur VPS Linux (Ubuntu / Debian avec PM2 & Nginx)
```bash
# 1. Cloner et installer
git clone <votre-depot> /var/www/fecawa
cd /var/www/fecawa
npm install --production

# 2. Configurer le .env de production
nano .env

# 3. Démarrer avec PM2
pm2 start server/server.js --name "fecawa-2026"
pm2 save
pm2 startup

# 4. Configurer Nginx comme reverse proxy
sudo nano /etc/nginx/sites-available/fecawa
```

Exemple de bloc Nginx :
```nginx
server {
    server_name don.fecawa-waama.org;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
Activez le SSL gratuit avec Certbot :
```bash
sudo certbot --nginx -d don.fecawa-waama.org
```

---

## 🤝 Contact & Organisation FeCAWa

- **Événement** : Festival Culturel et Artistique Waama (3ᵉ édition)
- **Dates** : 19 au 21 novembre 2026
- **Lieu** : Natitingou, Département de l'Atacora, République du Bénin
- **Message** : *« Que Dieu bénisse nos généreux donateurs ! »*
