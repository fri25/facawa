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
          "https://static.cloudflareinsights.com",
          "https://cloudflareinsights.com"
        ],
        formAction: [
          "'self'",
          "https://checkout.fedapay.com",
          "https://sandbox-checkout.fedapay.com",
          "https://*.fedapay.com"
        ],
        frameSrc: [
          "'self'",
          "https://checkout.fedapay.com",
          "https://process.fedapay.com",
          "https://*.fedapay.com"
        ]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

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
const allowedOrigins = new Set([SITE_ORIGIN, 'https://facawa.hashcode.cloud'].filter(Boolean));

function originGuard(req, res, next) {
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
  skip: (req) => req.path === '/webhook/fedapay' || req.path === '/api/webhook/fedapay'
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

// Montage des limiteurs sur les routes
app.use('/api', apiGlobalLimiter);
app.use('/api/create-transaction', donationLimiter);
app.use('/api/verify-transaction', verifyLimiter);
app.use('/api/subscribers', publicReadLimiter);
app.use('/api/stats', publicReadLimiter);

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

// Démarrage du serveur
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🎉 FeCAWa 2026 - Plateforme de Souscription Active !`);
  console.log(`📍 URL locale : http://localhost:${PORT}`);
  console.log(`📍 URL de production : https://${process.env.DOMAIN}`);
  console.log(`💳 FedaPay Mode : ${process.env.FEDAPAY_ENV || 'sandbox'}`);
  console.log('====================================================');
});
