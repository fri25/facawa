/**
 * Définition des routes de l'API FeCAWa 2026.
 */

const express = require('express');
const router = express.Router();
const DonationController = require('../controllers/donation.controller');
const WebhookController = require('../controllers/webhook.controller');
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
    }
  });
});

// Création d'une transaction de don
router.post('/create-transaction', validateDonationInput, DonationController.createTransaction);

// Webhook FedaPay
router.post('/webhook/fedapay', WebhookController.handleFedaPayWebhook);

// Vérification du statut d'un don
router.get('/verify-transaction/:id', DonationController.verifyTransaction);

// Liste publique des donateurs / souscripteurs
router.get('/subscribers', DonationController.getSubscribers);

// Statistiques globales de la collecte
router.get('/stats', DonationController.getStats);

module.exports = router;
