/**
 * Serveur Express principal - Plateforme de souscription FeCAWa 2026.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Initialisation de la base SQLite
require('./config/database');

const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT : derrière Traefik (reverse proxy), toutes les requêtes arrivent
// avec l'IP du proxy. Sans 'trust proxy', req.ip = IP de Traefik pour tout le
// monde → le rate limiter devient global (50 req/15min partagées par tous).
// '1' = faire confiance au premier proxy (Traefik) de la chaîne X-Forwarded-For.
app.set('trust proxy', 1);

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
          "https://*.fedapay.com"
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

// Configuration CORS
app.use(cors());

// Parseurs JSON et URL-encoded
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Limiteur de débit pour l'API de création de dons (protection anti-spam)
const donationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limite à 50 créations de transactions par IP
  message: {
    success: false,
    message: 'Trop de requêtes de souscription depuis cette adresse. Veuillez réessayer dans quelques minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Montage des routes API
app.use('/api/create-transaction', donationLimiter);
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
