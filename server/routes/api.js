/**
 * Définition des routes de l'API FeCAWa 2026.
 */

const express = require('express');
const router = express.Router();
const DonationController = require('../controllers/donation.controller');
const WebhookController = require('../controllers/webhook.controller');
const ExportController = require('../controllers/export.controller');
const paymentService = require('../services/payment.service');
const { validateDonationInput } = require('../middleware/validation');

// Configuration publique nécessaire au frontend (aucune clé secrète n'est exposée !)
router.get('/config', (req, res) => {
  res.json({
    festival: {
      name: 'Festival Culturel et Artistique Waama (FeCAWa)',
      edition: '3ᵉ édition',
      dates: '19 au 21 novembre 2026',
      location: 'Natitingou, Bénin'
    },
    fedapay: {
      publicKey: process.env.FEDAPAY_PUBLIC_KEY || '',
      env: process.env.FEDAPAY_ENV || 'sandbox'
    },
    // Flux Moneroo = redirection vers checkout_url : aucune clé publique n'est
    // nécessaire côté frontend (et aucune clé secrète n'est jamais exposée).
    moneroo: {
      env: process.env.MONEROO_ENV || 'sandbox'
    },
    // Fournisseur actif, pour que le frontend sache quel flux afficher.
    payment: {
      provider: paymentService.name
    }
  });
});

// Création d'une transaction de don
router.post('/create-transaction', validateDonationInput, DonationController.createTransaction);

// Webhook FedaPay
router.post('/webhook/fedapay', WebhookController.handleFedaPayWebhook);

// Webhook Moneroo (signature HMAC-SHA256 sans timestamp : voir contrôleur)
router.post('/webhook/moneroo', WebhookController.handleMonerooWebhook);

// Vérification du statut d'un don
router.get('/verify-transaction/:id', DonationController.verifyTransaction);

// Liste publique des donateurs / souscripteurs
router.get('/subscribers', DonationController.getSubscribers);

// Statistiques globales de la collecte
router.get('/stats', DonationController.getStats);

// Relevé complet des souscriptions (organisation) — jeton secret obligatoire.
// L'endpoint est sensible : il contient nom, téléphone, e-mail et message de
// chaque donateur. Il est hors du rate-limit public et protégé par son propre
// plafond (voir server.js) ; le jeton ne passe jamais dans l'URL.
router.get('/admin/export.csv', ExportController.exportCsv);

module.exports = router;
