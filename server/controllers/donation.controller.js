/**
 * Contrôleur principal des souscriptions et dons FeCAWa 2026.
 */

const { DonationRepository } = require('../config/database');
const fedapayService = require('../services/fedapay.service');

/**
 * Construit la réponse "reçu" d'une donation.
 *
 * SÉCURITÉ : la preuve de propriété (`ownsReceipt`) est exigée pour TOUTE donnée
 * identifiante. Sans jeton, la réponse ne contient que le statut : ni nom, ni
 * montant, ni référence, ni message. Avant cette correction,
 * `/api/verify-transaction/:id` ne demandait rien et fuitait le nom, le
 * montant, la référence et le message de tous les donateurs — y compris ceux
 * dont le paiement a expiré, qui n'apparaissent pourtant dans aucune liste
 * publique (getPublicSubscribers filtre sur status='approved').
 *
 * Le `message` (texte libre écrit par le donataire) n'est renvoyé qu'au
 * donataire lui-même, preuve de propriété à l'appui : il ne circule jamais
 * vers un tiers. Les choix d'anonymat (is_public) et de masquage de montant
 * (hide_amount) continuent de s'appliquer intégralement.
 *
 * @param {Object} donation Ligne SQLite
 * @param {boolean} ownsReceipt Le client a-t-il prouvé être le donataire ?
 */
function privateReceiptView(donation, ownsReceipt = false) {
  if (!donation) return null;
  if (!ownsReceipt) {
    // Vue réduite : prouve l'existence et l'état du paiement, rien de plus.
    return {
      reference: null,
      firstname: null,
      lastname: null,
      amount: null,
      currency: donation.currency,
      date: null,
      message: null
    };
  }

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

      // 2. Enregistrement en base de données SQLite en état "pending".
      //    Le repository renvoie aussi le jeton de reçu : c'est la preuve de
      //    propriété de la transaction, sans laquelle l'API ne divulguera
      //    aucune donnée personnelle sur cette donation.
      const { donation: localDonation, receiptToken } = DonationRepository.createPendingDonation({
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
        amount: data.amount,
        // Jeton de reçu : à conserver côté navigateur (sessionStorage) puis à
        // renvoyer dans l'en-tête X-Receipt-Token lors des vérifications de
        // statut, faute de quoi le reçu reste volontairement anonyme.
        receiptToken
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
   *
   * La preuve de propriété est lue dans l'en-tête `X-Receipt-Token` (le token
   * FedaPay ne convient pas : il est public et présent dans l'URL de checkout).
   * Sans jeton valide, seuls le statut et l'existence de la transaction sont
   * révélés — ce qui suffit au frontend pour afficher "en cours de validation"
   * sans exposer la PII du donataire à quiconque devine un ID.
   */
  async verifyTransaction(req, res) {
    try {
      const { id } = req.params;
      if (!id || id === 'demo' || id === 'null' || id === 'undefined') {
        return res.status(400).json({ success: false, message: 'ID de transaction valide requis.' });
      }

      const receiptToken = req.get('x-receipt-token') || '';
      // Anti-énumération : la preuve est vérifiée avant tout appel sortant.
      // Un attaquant qui parcours les ID ne déclenche donc aucun appel FedaPay.
      const ownsReceipt = DonationRepository.ownsTransaction(id, receiptToken);

      // 1. Vérifier d'abord en base de données locale
      let donation = DonationRepository.getByTransactionId(id);

      // Si le don est déjà dans un statut terminal (approuvé, refusé, annulé), renvoyer immédiatement
      if (donation && ['approved', 'declined', 'canceled'].includes(donation.status)) {
        return res.json({
          success: true,
          status: donation.status,
          owned: ownsReceipt,
          donation: privateReceiptView(donation, ownsReceipt)
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
          owned: ownsReceipt,
          donation: privateReceiptView(donation, ownsReceipt)
        });
      }

      // Un client sans jeton ne déclenche pas d'appel sortant : le rate-limit
      // reste contournable en théorie, on refuse donc de consommer le quota
      // FedaPay pour une simple reconnaissance d'ID.
      if (!ownsReceipt) {
        return res.json({
          success: true,
          status: donation?.status || 'pending',
          owned: false,
          donation: privateReceiptView(donation, false)
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
          owned: true,
          donation: privateReceiptView(donation, true)
        });
      } catch (fedaErr) {
        // En cas d'erreur de contact FedaPay, retourner l'état local actuel
        return res.json({
          success: true,
          status: donation?.status || 'pending',
          owned: true,
          donation: privateReceiptView(donation, true)
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
