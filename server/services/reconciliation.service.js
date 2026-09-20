/**
 * Service de réconciliation des transactions en attente pour FeCAWa 2026.
 * Permet de rattraper et synchroniser les transactions dont le webhook a été manqué
 * ou dont l'utilisateur a fermé la page de confirmation prématurément.
 */

const { DonationRepository } = require('../config/database');
const fedapayService = require('./fedapay.service');

class ReconciliationService {
  /**
   * Lance un cycle de réconciliation pour les transactions en attente
   * @param {Object} [options]
   * @param {number} [options.limit=25] Nombre maximum de transactions à analyser
   * @param {number} [options.minAgeMinutes=2] Âge minimum avant réconciliation
   * @returns {Promise<{ checked: number, updated: number, errors: number }>}
   */
  async reconcilePending({ limit = 25, minAgeMinutes = 2 } = {}) {
    const pendingList = DonationRepository.getPendingDonations({ limit, minAgeMinutes });
    let updated = 0;
    let errors = 0;

    if (!pendingList || pendingList.length === 0) {
      return { checked: 0, updated: 0, errors: 0 };
    }

    console.log(`[Reconciliation] 🔍 Analyse de ${pendingList.length} transaction(s) en attente...`);

    for (const donation of pendingList) {
      try {
        const txId = donation.transaction_id;
        const fedaTx = await fedapayService.getTransaction(txId);

        if (fedaTx && fedaTx.status && fedaTx.status !== donation.status) {
          console.log(`[Reconciliation] 🔄 Synchronisation transaction #${txId} : "${donation.status}" -> "${fedaTx.status}"`);
          DonationRepository.updateStatus(txId, fedaTx.status, fedaTx.mode || donation.payment_method);
          updated++;
        }
      } catch (err) {
        console.warn(`[Reconciliation] Impossible de vérifier transaction #${donation.transaction_id}:`, err.message);
        errors++;
      }
    }

    console.log(`[Reconciliation] ✅ Bilan: ${pendingList.length} analysées, ${updated} mises à jour, ${errors} erreurs.`);
    return { checked: pendingList.length, updated, errors };
  }
}

module.exports = new ReconciliationService();
