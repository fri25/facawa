/**
 * Contrôleur principal des souscriptions et dons FeCAWa 2026.
 */

const { DonationRepository } = require('../config/database');
const fedapayService = require('../services/fedapay.service');

/**
 * Vue "reçu" d'une donation en respectant les choix de confidentialité.
 * Évite toute fuite PII via l'énumération des identifiants de transaction.
 */
function privateReceiptView(donation) {
  if (!donation) return null;
  const isPublic = Boolean(donation.is_public);
  const hideAmount = Boolean(donation.hide_amount);
  return {
    reference: donation.reference,
    firstname: isPublic ? donation.firstname : 'Donateur bienveillant',
    lastname: isPublic ? donation.lastname : '',
    amount: hideAmount ? null : donation.amount,
    currency: donation.currency,
    date: donation.created_at || donation.date,
    message: donation.message
  };
}

// Cache mémoire anti-hammering (limite la fréquence des interrogations externes FedaPay par transaction)
const recentExternalChecks = new Map();
const CHECK_COOLDOWN_MS = 3000; // 3 secondes de délai minimal entre deux appels sortants FedaPay pour le même ID

function cleanupRecentChecks() {
  const now = Date.now();
  for (const [key, timestamp] of recentExternalChecks.entries()) {
    if (now - timestamp > 60000) {
      recentExternalChecks.delete(key);
    }
  }
}
setInterval(cleanupRecentChecks, 60000).unref();

const DonationController = {
  /**
   * Crée une transaction de don et prépare le paiement FedaPay
   */
  async createTransaction(req, res) {
    try {
      const data = req.cleanData;
      let appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
      appUrl = appUrl.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(appUrl)) {
        appUrl = `https://${appUrl}`;
      }
      const callbackUrl = `${appUrl}/confirmation.html`;

      // 1. Appel API FedaPay pour créer la transaction et obtenir le token
      const fedaResponse = await fedapayService.createTransaction({
        amount: data.amount,
        description: `Souscription FeCAWa 2026 - ${data.firstname} ${data.lastname}`,
        customer: {
          firstname: data.firstname,
          lastname: data.lastname,
          phone: data.phone,
          email: data.email
        },
        customMetadata: {
          message: data.message,
          is_public: data.isPublic,
          hide_amount: data.hideAmount
        },
        callbackUrl
      });

      // 2. Enregistrement en base de données SQLite en état "pending"
      const localDonation = DonationRepository.createPendingDonation({
        transactionId: fedaResponse.id,
        reference: fedaResponse.reference,
        firstname: data.firstname,
        lastname: data.lastname,
        phone: data.phone,
        email: data.email,
        amount: data.amount,
        currency: 'XOF',
        message: data.message,
        isPublic: data.isPublic,
        hideAmount: data.hideAmount,
        fedaToken: fedaResponse.token
      });

      console.log(`[Donation] Nouvelle souscription initiée: #${localDonation.id} (${data.amount} FCFA par ${data.firstname})`);

      // 3. Réponse au frontend pour déclencher le widget Checkout.js
      return res.status(201).json({
        success: true,
        transactionId: fedaResponse.id,
        reference: fedaResponse.reference,
        token: fedaResponse.token,
        checkoutUrl: fedaResponse.checkoutUrl,
        publicKey: process.env.FEDAPAY_PUBLIC_KEY || '',
        isSimulated: fedaResponse.isSimulated || false,
        amount: data.amount
      });
    } catch (error) {
      console.error('[Donation] Erreur création don:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Impossible d\'initialiser le paiement pour le moment.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  },

  /**
   * Vérifie le statut d'une transaction après le retour du donateur
   */
  async verifyTransaction(req, res) {
    try {
      const { id } = req.params;
      if (!id || id === 'demo' || id === 'null' || id === 'undefined') {
        return res.status(400).json({ success: false, message: 'ID de transaction valide requis.' });
      }

      // 1. Vérifier d'abord en base de données locale
      let donation = DonationRepository.getByTransactionId(id);

      // Si le don est déjà dans un statut terminal (approuvé, refusé, annulé), renvoyer immédiatement
      if (donation && ['approved', 'declined', 'canceled'].includes(donation.status)) {
        return res.json({
          success: true,
          status: donation.status,
          donation: privateReceiptView(donation)
        });
      }

      // Anti-énumération : si la transaction n'existe pas en base locale et n'est pas simulée
      if (!donation && !String(id).startsWith('sim_')) {
        return res.status(404).json({
          success: false,
          message: 'Transaction introuvable.'
        });
      }

      // 2. Anti-hammering : si une vérification externe a eu lieu il y a moins de 3 secondes pour cet ID
      const lastCheck = recentExternalChecks.get(id);
      const now = Date.now();
      if (lastCheck && (now - lastCheck) < CHECK_COOLDOWN_MS) {
        return res.json({
          success: true,
          status: donation?.status || 'pending',
          donation: privateReceiptView(donation)
        });
      }

      recentExternalChecks.set(id, now);

      // 3. Interroger FedaPay
      try {
        const fedaTx = await fedapayService.getTransaction(id);
        const status = fedaTx.status; // approved, pending, declined, etc.

        if (status === 'approved') {
          donation = DonationRepository.updateStatus(id, 'approved', fedaTx.mode || 'mobile_money');
          console.log(`[Donation] ✅ Transaction #${id} confirmée par FedaPay comme 100% effective. Somme créditée à la cagnotte.`);
        } else if (status === 'declined' || status === 'canceled') {
          donation = DonationRepository.updateStatus(id, status);
          console.log(`[Donation] ⚠️ Transaction #${id} non aboutie (${status}). Non comptabilisée dans la cagnotte.`);
        } else {
          donation = DonationRepository.updateStatus(id, 'pending', fedaTx.mode || 'mobile_money');
          console.log(`[Donation] ⏳ Transaction #${id} toujours en attente (${status}). La cagnotte reste inchangée.`);
        }

        return res.json({
          success: true,
          status: status || donation?.status || 'pending',
          donation: privateReceiptView(donation)
        });
      } catch (fedaErr) {
        // En cas d'erreur de contact FedaPay, retourner l'état local actuel
        return res.json({
          success: true,
          status: donation?.status || 'pending',
          donation: privateReceiptView(donation)
        });
      }
    } catch (error) {
      console.error('[Donation] Erreur verifyTransaction:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Erreur lors de la vérification de la transaction.'
      });
    }
  },

  /**
   * Récupère la liste publique des donateurs et les statistiques
   */
  async getSubscribers(req, res) {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
      const offset = parseInt(req.query.offset, 10) || 0;
      const search = req.query.search || '';

      const subscribers = DonationRepository.getPublicSubscribers({ limit, offset, search });
      const stats = DonationRepository.getStats();

      return res.json({
        success: true,
        stats,
        subscribers,
        pagination: {
          limit,
          offset,
          hasMore: subscribers.length === limit
        }
      });
    } catch (error) {
      console.error('[Donation] Erreur getSubscribers:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Impossible de récupérer la liste des donateurs.'
      });
    }
  },

  /**
   * Récupère les statistiques de la collecte
   */
  async getStats(req, res) {
    try {
      const stats = DonationRepository.getStats();
      return res.json({
        success: true,
        stats
      });
    } catch (error) {
      console.error('[Donation] Erreur getStats:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Impossible de récupérer les statistiques.'
      });
    }
  }
};

module.exports = DonationController;
