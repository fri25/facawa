/**
 * Contrôleur Webhook FedaPay pour FeCAWa 2026.
 * Traite les événements transaction.approved et met à jour
 * la base de données automatiquement et en toute sécurité.
 */

const { DonationRepository } = require('../config/database');
const fedapayService = require('../services/fedapay.service');

const WebhookController = {
  /**
   * Endpoint POST /api/webhook/fedapay
   */
  async handleFedaPayWebhook(req, res) {
    try {
      console.log('[Webhook] Notification FedaPay reçue.');

      // 1. Vérification de la signature du webhook
      const isValid = fedapayService.verifyWebhook(req.headers, req.body);
      if (!isValid) {
        console.warn('[Webhook] ❌ Rejet : Signature ou origine non authentifiée.');
        return res.status(401).json({ error: 'Signature invalide.' });
      }

      const payload = req.body;
      const eventName = payload.name || payload.event || '';
      const entity = payload.entity || payload;

      console.log(`[Webhook] Événement: "${eventName}", Statut: "${entity?.status}"`);

      // 2. Traitement des transactions approuvées
      if (eventName === 'transaction.approved' || entity?.status === 'approved') {
        const transactionId = entity.id;

        let isConfirmedEffective = false;
        let verifiedTx = null;

        try {
          verifiedTx = await fedapayService.getTransaction(transactionId);
          if (verifiedTx && verifiedTx.status === 'approved') {
            isConfirmedEffective = true;
          } else {
            console.warn(`[Webhook] ⚠️ Transaction #${transactionId} vérifiée chez FedaPay mais statut = "${verifiedTx?.status || 'inconnu'}". La cagnotte reste inchangée.`);
          }
        } catch (apiErr) {
          console.warn(`[Webhook] Impossible de confirmer l’encaissement réel pour #${transactionId}:`, apiErr.message);
          isConfirmedEffective = false;
        }

        if (isConfirmedEffective) {
          const paymentMethod = verifiedTx?.mode || entity.mode || entity.payment_method || 'mobile_money';
          const amount = verifiedTx?.amount || entity.amount;
          const reference = verifiedTx?.reference || entity.reference;
          const customer = verifiedTx?.customer || entity.customer || {};
          const metadata = verifiedTx?.custom_metadata || entity.custom_metadata || {};

          console.log(`[Webhook] ✅ Paiement effectif certifié pour transaction #${transactionId} (${amount} XOF). Mise à jour de la cagnotte.`);

          DonationRepository.upsertApprovedFromWebhook({
            transactionId,
            reference,
            firstname: customer.firstname || 'Généreux',
            lastname: customer.lastname || 'Donateur',
            phone: customer.phone_number?.number || '',
            email: customer.email || null,
            amount,
            currency: entity.currency?.iso || 'XOF',
            message: metadata.message || null,
            isPublic: metadata.is_public !== undefined ? metadata.is_public : true,
            hideAmount: metadata.hide_amount !== undefined ? metadata.hide_amount : false,
            paymentMethod
          });

          console.log(`[Webhook] 🎉 Montant de ${amount} FCFA définitivement comptabilisé dans la cagnotte.`);
        } else {
          const currentDonation = DonationRepository.getByTransactionId(transactionId);
          if (currentDonation && currentDonation.status !== 'approved') {
            DonationRepository.updateStatus(transactionId, 'pending');
          }
          console.log(`[Webhook] 🚫 Transaction #${transactionId} non confirmée par FedaPay: la cagnotte n'a pas été mise à jour.`);
        }
      } else if (eventName === 'transaction.canceled' || eventName === 'transaction.declined') {
        const transactionId = entity.id;
        DonationRepository.updateStatus(transactionId, entity.status);
        console.log(`[Webhook] Statut de transaction #${transactionId} mis à jour: ${entity.status} (non comptabilisé).`);
      }

      // 3. Réponse 200 OK obligatoire pour FedaPay
      return res.status(200).json({ received: true, status: 'processed' });
    } catch (error) {
      console.error('[Webhook] ❌ Erreur lors du traitement:', error.message);
      // FedaPay réessaie si code != 200
      return res.status(500).json({ error: 'Erreur interne de traitement webhook.' });
    }
  }
};

module.exports = WebhookController;
