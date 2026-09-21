/**
 * Serveur Express principal - Plateforme de souscription FeCAWa 2026.
 */

const net = require('net');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Initialisation de la base SQLite
require('./config/database');

const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration 'trust proxy' robuste (Issues #6 & #13)
// Fait confiance aux requêtes transitant par les réseaux privés Docker (Traefik).
// Ne fait PAS confiance au loopback par défaut afin d'empêcher le spoofing XFF direct en local.
app.set('trust proxy', (ip) => isTrustedProxy(ip));

/**
 * Vérifie si une adresse IP correspond à notre reverse proxy de confiance (Traefik sur réseau Docker)
 */
function isTrustedProxy(ip) {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, '').trim();

  // Autorisé en test ou configuration explicite
  if (process.env.TRUST_LOOPBACK_PROXY === 'true') {
    if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  }

  // Sous-réseaux privés Docker (RFC 1918) où opère Traefik
  if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true;
  const m172 = clean.match(/^172\.(\d+)\./);
  if (m172) {
    const octet = parseInt(m172[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

/**
 * Vérifie si une adresse IP appartient aux sous-réseaux privés RFC 1918 ou loopback
 */
function isPrivateOrLoopback(ip) {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, '').trim();
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true;
  const m172 = clean.match(/^172\.(\d+)\./);
  if (m172) {
    const octet = parseInt(m172[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (/^(fc|fd|fe80)/i.test(clean)) return true;
  return false;
}

/**
 * Résolution déterministe et anti-spoofing de l'adresse IP cliente.
 * Résout #6 (cohérence Cloudflare + Traefik) et #13 (anti-contournement rate limit par X-Forwarded-For).
 */
function getClientIp(req) {
  const remoteSocket = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
  const isFromProxy = isTrustedProxy(remoteSocket);

  // 1. Si la requête transite par notre reverse-proxy de confiance (Traefik / Docker network) :
  if (isFromProxy) {
    // A. Priorité absolue : header Cloudflare CF-Connecting-IP (inviolable derrière Cloudflare)
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp && typeof cfIp === 'string') {
      const cleanCf = cfIp.replace(/^::ffff:/, '').trim();
      if (net.isIP(cleanCf)) {
        return cleanCf;
      }
    }

    // B. Chaîne X-Forwarded-For : extraire la première IP non privée depuis la droite
    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
      const parts = xff.split(',').map(p => p.replace(/^::ffff:/, '').trim()).filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        const candidate = parts[i];
        if (net.isIP(candidate) && !isPrivateOrLoopback(candidate)) {
          return candidate;
        }
      }
      if (parts.length > 0 && net.isIP(parts[0])) {
        return parts[0];
      }
    }
  }

  // 2. Connexion directe sans proxy de confiance :
  // Tout header XFF ou CF envoyé directement depuis l'extérieur est ignoré (anti-spoofing #13)
  return remoteSocket || '127.0.0.1';
}

// Configuration de la sécurité avec Helmet (adapté pour le widget FedaPay Checkout.js)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
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
  validate: { trustProxy: false, xForwardedForHeader: false },
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
  validate: { trustProxy: false, xForwardedForHeader: false }
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
  validate: { trustProxy: false, xForwardedForHeader: false }
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
  validate: { trustProxy: false, xForwardedForHeader: false }
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
