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
│   │   └── fedapay.service.js       # Client API FedaPay (transactions, tokens, vérification)
│   ├── controllers/
│   │   ├── donation.controller.js   # Création de don, vérification, flux souscripteurs
│   │   └── webhook.controller.js    # Réception et validation du Webhook transaction.approved
│   ├── routes/
│   │   └── api.js                   # Routes REST (/api/create-transaction, /api/webhook/..., etc.)
│   └── middleware/
│       └── validation.js            # Validation stricte et nettoyage anti-XSS
│
├── data/
│   └── fecawa.db                    # Base de données SQLite persistante (auto-générée)
│
└── public/                          # Frontend moderne (Mobile-First)
    ├── index.html                   # Page d'accueil : Hero, formulaire de don, FedaPay Checkout
    ├── souscripteurs.html           # Page publique : Tableau d'honneur des donateurs & recherche
    ├── confirmation.html            # Page de confirmation, bénédiction et reçu imprimable
    ├── css/
    │   └── style.css                # Styles culturels Waama (terracotta, ocre, responsive)
    ├── js/
    │   ├── app.js                   # Logique du formulaire et déclenchement Checkout.js
    │   └── subscribers.js           # Gestion dynamique de la liste des donateurs
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
