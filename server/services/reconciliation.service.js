/**
 * Service de réconciliation des transactions en attente pour FeCAWa 2026.
 * Permet de rattraper et synchroniser les transactions dont le webhook a été manqué
 * ou dont l'utilisateur a fermé la page de confirmation prématurément.
 */

const { DonationRepository } = require('../config/database');
// Façade de paiement : interroge FedaPay ou Moneroo selon PAYMENT_PROVIDER.
const paymentService = require('./payment.service');

class ReconciliationService {
  /**
   * Lance un cycle de réconciliation pour les transactions en attente
   * @param {Object} [options]
   * @param {number} [options.limit=25] Nombre maximum de transactions à analyser
   * @param {number} [options.minAgeMinutes=2] Âge minimum avant réconciliation
   * @param {number} [options.maxAgeHours=24] Âge maximal avant abandon
   *   (au-delà, la transaction est laissée en l'état : la rattacher coûterait
   *   un appel FedaPay pour une opération qui ne peut plus aboutir)
   * @returns {Promise<{ checked: number, updated: number, errors: number }>}
   */
  async reconcilePending({ limit = 25, minAgeMinutes = 2, maxAgeHours = 24 } = {}) {
    // `maxAgeHours` DOIT être transmis : sans cela le repository retombait sur
    // sa fenêtre par défaut de 24 h et la réconciliation ne voyait QUE les
    // transactions de la journée — les plus anciennes, celles justement qu'il
    // faut purger, restaient 'pending' ad vitam.
    const pendingList = DonationRepository.getPendingDonations({ limit, minAgeMinutes, maxAgeHours });
    let updated = 0;
    let errors = 0;

    if (!pendingList || pendingList.length === 0) {
      return { checked: 0, updated: 0, errors: 0 };
    }

    console.log(`[Reconciliation] 🔍 Analyse de ${pendingList.length} transaction(s) en attente...`);

    for (const donation of pendingList) {
      try {
        const txId = donation.transaction_id;
        // Une ligne est toujours vérifiée chez le fournisseur qui l'a créée —
        // jamais de 404 inter-fournisseur après une bascule FedaPay↔Moneroo.
        const provider = paymentService.getProvider(donation.provider);
        const providerTx = await provider.getTransaction(txId);

        if (providerTx && providerTx.status && providerTx.status !== donation.status) {
          console.log(`[Reconciliation] 🔄 Synchronisation transaction #${txId} : "${donation.status}" -> "${providerTx.status}"`);
          DonationRepository.updateStatus(txId, providerTx.status, providerTx.mode || donation.payment_method);
          updated++;
        }
      } catch (err) {
        // 404 = le fournisseur de paiement ne connaît PLUS cette transaction :
        // elle a été supprimée (donateur ayant abandonné, puis purge côté
        // fournisseur) ou n'a jamais existé. Ce n'est PAS une panne : c'est un
        // état définitif. La compter comme une erreur aurait, après trois
        // cycles, déclenché l'alerte « fournisseur injoignable » alors que tout
        // allait bien — et la ligne locale serait restée 'pending'
        // indéfiniment, donc invisible sur le site mais signalée à tort comme
        // un encaissement non comptabilisé. Constaté le 2026-09-27 sur la
        // transaction #113346747.
        const status = err.response?.status;
        // `txId` est déclaré dans le bloc try : inaccessible ici. On repasse par
        // la ligne courante de la boucle.
        const orphanId = donation.transaction_id;
        if (status === 404) {
          DonationRepository.updateStatus(orphanId, 'canceled');
          console.log(`[Reconciliation] Transaction #${orphanId} supprimée chez le fournisseur (404) : marquée annulée, la cagnotte ne change pas.`);
          updated++;
        } else {
          console.warn(`[Reconciliation] Impossible de vérifier transaction #${donation.transaction_id}:`, err.message);
          errors++;
        }
      }
    }

    console.log(`[Reconciliation] ✅ Bilan: ${pendingList.length} analysées, ${updated} mises à jour, ${errors} erreurs.`);
    return { checked: pendingList.length, updated, errors };
  }
}

module.exports = new ReconciliationService();
