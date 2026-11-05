/**
 * Serveur Express principal - Plateforme de souscription FeCAWa 2026.
 */

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Initialisation de la base SQLite
require('./config/database');

const { getClientIp } = require('./services/client-ip.service');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Portail anti-accès direct (CWE-441).
 *
 * Le conteneur n'est joignable que via Traefik. Sans ce garde-fou, tout
 * conteneur partageant le réseau Docker 'proxy' (~10 autres applications sur
 * cet hôte) pouvait interroger l'API directement, en contournant Traefik,
 * Cloudflare ET les rate-limits. Constaté : 3 conteneurs tiers ont pu lire
 * les PII des donateurs via http://fecawa:3000.
 *
 * Traefik applique un middleware 'headers' dont `customRequestHeaders`
 * *écrase* (et non n'ajoute) l'en-tête ci-dessous : la valeur reçue par
 * l'application est donc toujours celle de Traefik, jamais celle du client.
 * Le secret est partagé via .env → variable du compose (FECAWAY_GATE_SECRET).
 *
 * Le loopback est exempté : c'est le seul cas où un pair de confiance n'est
 * pas Traefik (healthcheck Docker interne, `docker exec` de débogage).
 *
 * Si le secret n'est pas configuré, le contrôle est désactivé (développement).
 */
const GATE_HEADER = 'x-fecawa-gate';
const GATE_SECRET = process.env.FECAWAY_GATE_SECRET || '';

function proxyGate(req, res, next) {
  if (!GATE_SECRET) return next();
  if (!GATE_SECRET.length || GATE_SECRET.length < 32) {
    console.error('[Portail] FECAWAY_GATE_SECRET trop court (<32 caractères) : contrôle ignoré.');
    return next();
  }

  const peer = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (peer === '127.0.0.1' || peer === '::1') return next();

  const presented = req.headers[GATE_HEADER];
  if (typeof presented !== 'string' || presented.length !== GATE_SECRET.length) {
    console.warn(`[Portail] Accès direct bloqué depuis ${peer || 'IP inconnue'} (en-tête ${GATE_HEADER} absent ou invalide).`);
    return res.status(403).json({ success: false, message: 'Accès direct non autorisé.' });
  }

  const expected = Buffer.from(GATE_SECRET, 'utf8');
  const given = Buffer.from(presented, 'utf8');
  if (!crypto.timingSafeEqual(expected, given)) {
    console.warn(`[Portail] Accès direct bloqué depuis ${peer} (secret ${GATE_HEADER} incorrect).`);
    return res.status(403).json({ success: false, message: 'Accès direct non autorisé.' });
  }

  next();
}

app.use(proxyGate);

// Configuration de la sécurité avec Helmet (adapté pour le widget FedaPay Checkout.js)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-eval' a été RETIRÉ : aucune évaluation de chaîne n'est utilisée
        // par le front (vérifié : 0 occurrence de eval/new Function), et
        // `eval()` transforme toute injection en exécution de code.
        // 'unsafe-inline' reste nécessaire : les pages HTML statiques portent
        // des scripts/styles inline et des handlers onclick. Le supprimer
        // exigera de passer par des nonces par requête (refonte).
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.fedapay.com",
          "https://checkout.fedapay.com",
          "https://*.fedapay.com",
          "https://static.cloudflareinsights.com"
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com"
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com",
          "data:"
        ],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.fedapay.com",
          "https://cdn.fedapay.com"
        ],
        connectSrc: [
          "'self'",
          "https://api.fedapay.com",
          "https://sandbox-api.fedapay.com",
          "https://checkout.fedapay.com",
          "https://*.fedapay.com",
          "https://api.moneroo.io",
          "https://static.cloudflareinsights.com",
          "https://cloudflareinsights.com"
        ],
        formAction: [
          "'self'",
          "https://checkout.fedapay.com",
          "https://sandbox-checkout.fedapay.com",
          "https://*.fedapay.com",
          "https://checkout.moneroo.io"
        ],
        frameSrc: [
          "'self'",
          "https://checkout.fedapay.com",
          "https://process.fedapay.com",
          "https://*.fedapay.com",
          "https://checkout.moneroo.io"
        ]
      }
    },
    crossOriginEmbedderPolicy: false,
    // HSTS : max-age allongé à 2 ans + preload. Le domaine sert déjà
    // l'intégralité de ses sous-domaines en HTTPS, et includeSubDomains
    // impose le HTTPS à fecawadb.* comme au reste.
    strictTransportSecurity: {
      maxAge: 63072000,
      includeSubDomains: true,
      preload: true
    },
    referrerPolicy: { policy: 'no-referrer' },
    // Verrouille les APIs navigateur que le site n'utilise pas.
    // 'payment' est laissé libre : le widget FedaPay peut l'utiliser.
    // (La config Traefik applique par ailleurs son propre Permissions-Policy.)
    xContentTypeOptions: true
  })
);

// Permissions-Policy explicite (absent de la config Helmet par défaut).
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(self "https://*.fedapay.com"), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()'
  );
  next();
});


// Configuration CORS : l'API est destinée au site lui-même (même origine) et au
// webhook FedaPay. Les requêtes cross-site sont rejetées (anti-abus / anti-CSRF) :
// on ne se contente pas de refuser les en-têtes, on répond 403 en présence d'une
// origine étrangère pour empêcher tout site tiers de piloter le paiement.
const SITE_ORIGIN = (() => {
  try {
    return new URL(process.env.APP_URL || 'http://localhost').origin;
  } catch {
    return '';
  }
})();
// L'unique origine autorisée est celle déclarée par APP_URL (.env) : le site
// et l'API sont servis par le même conteneur, donc toute autre origine est
// étrangère. Ne pas coder un domaine en dur ici, sinon il devient obsolète
// à chaque changement de nom de domaine.
const allowedOrigins = new Set([SITE_ORIGIN].filter(Boolean));

function originGuard(req, res, next) {
  // Les endpoints de webhook sont EXEMPTÉS : certains fournisseurs envoient un
  // en-tête Origin sur leurs notifications, qui serait rejeté à tort ici. La
  // signature HMAC reste LA barrière de sécurité de ces endpoints.
  if (req.path.startsWith('/api/webhook/')) return next();

  const origin = req.headers.origin;
  if (origin) {
    const isFedaPay = origin.endsWith('.fedapay.com');
    if (!allowedOrigins.has(origin) && !isFedaPay) {
      return res.status(403).json({ success: false, message: 'Origine non autorisée.' });
    }
  }
  next();
}
app.use(originGuard);

// Parseurs JSON et URL-encoded (avec conservation du corps brut pour vérification HMAC)
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// -----------------------------------------------------------------------------
// Rate Limiters - Protection Anti-Abus / Anti-Scraping / Anti-Spam (Issues #7 & #13)
// -----------------------------------------------------------------------------
//
// `keyGenerator` s'appuie sur getClientIp() (voir services/client-ip.service.js)
// qui ne fait confiance qu'aux en-têtes AJOUTÉS par le proxy. Auparavant, la
// clé venait de `trust proxy` (fonction « toute IP privée est un proxy de
// confiance ») alors que CF-Connecting-IP était lu en priorité absolue : une
// IP forgée suffisait à obtenir un compteur neuf à chaque requête.
//
// `validate.trustProxy` est aligned sur le nombre de sauts de confiance réel
// (Cloudflare → Traefik → app) uniquement pour que la validation interne
// d'express-rate-limit ne rejette pas la configuration ; la clé elle-même est
// calculée par getClientIp(). `xForwardedForHeader: false` désactive la
// vérification d'en-tête superflue.
const RATE_LIMIT_VALIDATE = {
  trustProxy: parseInt(process.env.TRUSTED_PROXY_HOPS || '2', 10) || 0,
  xForwardedForHeader: false
};

// Limiteur global sur l'ensemble de l'API (sauf webhook FedaPay signé par HMAC)
const apiGlobalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requêtes / 15 minutes
  keyGenerator: (req) => getClientIp(req),
  message: {
    success: false,
    message: 'Trop de requêtes vers l\'API depuis cette adresse. Veuillez patienter un instant.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: RATE_LIMIT_VALIDATE,
  skip: (req) =>
    req.path === '/webhook/fedapay' || req.path === '/api/webhook/fedapay' ||
    req.path === '/webhook/moneroo' || req.path === '/api/webhook/moneroo'
});

// Limiteur strict pour la création de dons (anti-spam de transactions FedaPay)
const donationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 créations de transactions par IP
  keyGenerator: (req) => getClientIp(req),
  message: {
    success: false,
    message: 'Trop de requêtes de souscription depuis cette adresse. Veuillez réessayer dans quelques minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: RATE_LIMIT_VALIDATE
});

// Limiteur pour la vérification de transaction (anti-énumération & quotas FedaPay sortants)
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // 60 vérifications / 15 minutes (suffisant pour le polling du front-end)
  keyGenerator: (req) => getClientIp(req),
  message: {
    success: false,
    message: 'Trop de vérifications demandées depuis cette adresse. Veuillez patienter.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: RATE_LIMIT_VALIDATE
});

// Limiteur pour les lectures publiques (/api/subscribers et /api/stats)
const publicReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 120, // 120 requêtes / 15 minutes
  keyGenerator: (req) => getClientIp(req),
  message: {
    success: false,
    message: 'Trop de requêtes de consultation. Veuillez patienter un instant.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: RATE_LIMIT_VALIDATE
});

// Limiteur du webhook FedaPay.
//
// Ce endpoint est le SEUL de l'API à ne pas être derrière Cloudflare : les
// serveurs FedaPay n'y passent pas (cf. routeur `fecawa-webhook` dans
// compose.yml, et le 403 que renvoyait `fecawa-cfonly` le 2026-09-27 — la
// cause de la cagnotte bloquée à 0 malgré des paiements encaissés). Il est
// donc exposé à Internet et DOIT avoir son propre plafond, sinon n'importe
// qui peut le saturer. Plafond volontairement large : FedaPay n'envoie que
// quelques notifications, et un 429 répété ferait auto-désactiver le webhook
// chez eux (`disable_on_error`), ce qui reproduirait exactement la panne du
// 2026-09-26. La barrière de sécurité réelle reste la signature HMAC, vérifiée
// dans le contrôleur avant tout traitement.
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 notifications / 15 minutes et par IP
  keyGenerator: (req) => getClientIp(req),
  message: {
    success: false,
    message: 'Trop de notifications reçues.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: RATE_LIMIT_VALIDATE
});

// Limiteur de l'export CSV.
// L'export est protégé par un jeton secret long (32 caractères minimum exigé
// par le contrôleur), donc un throttle est inutile sur le fond ; ce plafond existe
// seulement pour rendre l'énumération de jetons coûteuse et pour éviter qu'un
// script maladroit ne télécharge le fichier toutes les secondes.
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 exports / 15 minutes et par IP
  keyGenerator: (req) => getClientIp(req),
  message: {
    success: false,
    message: 'Trop de tentatives d\'export. Veuillez patienter.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: RATE_LIMIT_VALIDATE
});

// Montage des limiteurs sur les routes
app.use('/api', apiGlobalLimiter);
app.use('/api/create-transaction', donationLimiter);
app.use('/api/verify-transaction', verifyLimiter);
app.use('/api/subscribers', publicReadLimiter);
app.use('/api/stats', publicReadLimiter);
app.use('/api/webhook/fedapay', webhookLimiter);
// Même protection pour Moneroo : le endpoint est public et la signature seule
// ne protège pas d'une saturation. (Ajout au-delà de la spec, pour parité.)
app.use('/api/webhook/moneroo', webhookLimiter);
app.use('/api/admin/export.csv', exportLimiter);

// Montage des routes API
app.use('/api', apiRoutes);

// Redirection de l'ancienne page souscripteurs vers l'accueil
app.get(['/souscripteurs', '/souscripteurs.html'], (req, res) => {
  res.redirect(301, '/');
});

// Facture et reçu de paiement officiel
app.get(['/confirmation', '/confirmation.html', '/facture'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/confirmation.html'));
});

// Page d'export des souscriptions (réservée à l'organisation).
// Servie explicitement (et non par express.static) pour deux raisons :
//   - `X-Robots-Tag` : défense en profondeur. La page contient déjà un
//     `<meta name="robots">`, mais un robot qui n'analyse que les en-têtes HTTP
//     ne le verrait pas. Une page d'accès à des données personnelles n'a rien à
//     faire dans un index de moteur de recherche.
//   - aucune donnée n'y figure : le jeton d'export est saisi par
//     l'utilisateur et n'est jamais servi par le serveur.
app.get('/export.html', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../public/export.html'));
});

// Servir les fichiers statiques du frontend
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// Gestionnaire 404
app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(publicDir, 'index.html'));
  } else {
    res.status(404).json({ success: false, message: 'Ressource non trouvée.' });
  }
});

// Gestionnaire global des erreurs
app.use((err, req, res, next) => {
  console.error('[Serveur] Erreur non gérée:', err);
  res.status(500).json({
    success: false,
    message: 'Une erreur interne est survenue sur le serveur.',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// -----------------------------------------------------------------------------
// Réconciliation automatique des transactions en attente
// -----------------------------------------------------------------------------
//
// Pourquoi c'est indispensable : le compteur de la cagnotte n'est mis à jour
// que sur un statut 'approved' en base, obtenu soit par le webhook FedaPay,
// soit par la vérification faite depuis la page de confirmation. Si les deux
// échouent (notification perdue, donataire qui ferme l'onglet, webhook mal
// configuré ou bloqué par le proxy comme le 2026-09-27), la transaction reste
// indéfiniment 'pending' : le paiement est encaissé mais la cagnotte, elle,
// n'avance pas. Le 2026-09-27, 2 000 FCFA étaient 'approved' côté FedaPay et
// 'pending' en base, sans aucun mécanisme de rattrapage : ce service existait
// mais n'était appelé QUE par test-platform.js, jamais en production.
//
// Le rattrapage est donc double :
//   - un cycle peu après le démarrage (récupère tout ce qui est resté en
//     attente pendant une coupure, un redéploiement ou une panne du webhook) ;
//   - un cycle périodique ensuite, qui garantit qu'aucun paiement ne peut
//     rester invisible plus de RECONCILIATION_INTERVAL_MINUTES.
//
// Chaque appel sortant est soumis au budget horaire de fedapay.service.js :
// le budget reste le filet de sécurité ultime si FedaPay devient injoignable.
const reconciliationService = require('./services/reconciliation.service');
const watchdogService = require('./services/watchdog.service');
const { WATCHDOG_ENABLED } = require('./services/watchdog.service');

const RECONCILIATION_ENABLED = (process.env.RECONCILIATION_ENABLED || 'true').toLowerCase() !== 'false';
const RECONCILIATION_INTERVAL_MIN = Math.max(parseInt(process.env.RECONCILIATION_INTERVAL_MINUTES || '10', 10) || 10, 1);
const RECONCILIATION_BATCH = Math.max(parseInt(process.env.RECONCILIATION_BATCH_SIZE || '25', 10) || 25, 1);
// 30 jours par défaut : au-delà, une transaction non résolue est presque
// toujours une transaction expirée chez FedaPay, qu'il faut tout de même purger
// pour qu'elle ne reste pas 'pending' ad vitam.
const RECONCILIATION_MAX_AGE_H = Math.max(parseInt(process.env.RECONCILIATION_MAX_AGE_HOURS || '720', 10) || 720, 1);

let reconciliationRunning = false;

async function runReconciliationCycle(trigger) {
  if (reconciliationRunning) {
    console.warn('[Reconciliation] Cycle déjà en cours, celui-ci est ignoré.');
    return;
  }
  reconciliationRunning = true;
  try {
    console.log(`[Reconciliation] Cycle ${trigger} : rapprochement des transactions en attente...`);
    const result = await reconciliationService.reconcilePending({
      limit: RECONCILIATION_BATCH,
      // 1 min : on laisse le temps au push Mobile Money d'aboutir avant de
      // consommer un appel FedaPay sur une transaction qui vient d'être créée.
      minAgeMinutes: 1,
      maxAgeHours: RECONCILIATION_MAX_AGE_H
    });
    if (result.checked > 0) {
      console.log(`[Reconciliation] Cycle ${trigger} terminé : ${result.updated} transaction(s) synchronisée(s), ${result.errors} erreur(s).`);
    } else {
      // Tracé même en cycle vide : c'est la seule preuve, en exploitation, que
      // la boucle tourne encore. Un cycle muet est indiscernable d'une boucle
      // morte — et c'est exactement le type de panne silencieuse qui a laissé
      // 2 000 FCFA hors cagnotte le 2026-09-27.
      console.log(`[Reconciliation] Cycle ${trigger} terminé : aucune transaction en attente.`);
    }
    // Le compteur d'échecs consécutifs alimente la condition « FedaPay
    // injoignable » du watchdog.
    watchdogService.noteReconciliationResult(result);
  } catch (error) {
    // Une réconciliation ratée ne doit jamais faire tomber le serveur : le
    // cycle suivant réessaiera. Le watchdog est prévenu dans tous les cas.
    console.error('[Reconciliation] Échec du cycle :', error.message);
    watchdogService.noteReconciliationResult({ errors: 1 });
  } finally {
    reconciliationRunning = false;
    // Le watchdog tourne après la réconciliation : il doit analyser un état
    // déjà à jour, sinon il signalerait comme « non comptabilisé » un paiement
    // que le cycle vient de rattraper.
    if (WATCHDOG_ENABLED) {
      try {
        await watchdogService.check();
      } catch (watchdogErr) {
        console.error('[Watchdog] Échec du contrôle :', watchdogErr.message);
      }
    }
  }
}

function startReconciliationLoop() {
  if (!RECONCILIATION_ENABLED) {
    console.warn('[Reconciliation] Désactivée par RECONCILIATION_ENABLED=false.');
    return;
  }

  console.log(`[Reconciliation] Automatique : 1 cycle au démarrage puis toutes les ${RECONCILIATION_INTERVAL_MIN} min (lot de ${RECONCILIATION_BATCH}, plus de ${RECONCILIATION_MAX_AGE_H} h ignorées).`);

  // Premier cycle légèrement différé : le temps que le serveur soit
  // opérationnel et que les appels sortants vers FedaPay aboutissent.
  const bootDelay = setTimeout(() => runReconciliationCycle('démarrage'), 15000);
  bootDelay.unref();

  const timer = setInterval(() => runReconciliationCycle('périodique'), RECONCILIATION_INTERVAL_MIN * 60 * 1000);
  timer.unref();
}

// Démarrage du serveur
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🎉 FeCAWa 2026 - Plateforme de Souscription Active !`);
  console.log(`📍 URL locale : http://localhost:${PORT}`);
  console.log(`📍 URL de production : https://${process.env.DOMAIN}`);
  console.log(`💳 FedaPay Mode : ${process.env.FEDAPAY_ENV || 'sandbox'}`);
  console.log('====================================================');
  startReconciliationLoop();
});
