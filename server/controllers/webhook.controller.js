/**
 * Contrôleur Webhook FedaPay pour FeCAWa 2026.
 * Traite les événements transaction.approved et met à jour
 * la base de données automatiquement et en toute sécurité.
 */

const { DonationRepository } = require('../config/database');
const fedapayService = require('../services/fedapay.service');
const monerooService = require('../services/moneroo.service');
const watchdogService = require('../services/watchdog.service');

const WebhookController = {
  /**
   * Endpoint POST /api/webhook/fedapay
   */
  async handleFedaPayWebhook(req, res) {
    try {
      // 1. Vérification de la signature du webhook
      const isValid = fedapayService.verifyWebhook(req.headers, req.body, req.rawBody);
      if (!isValid) {
        // Rejet COMPTÉ et SOURCE tracée. Un webhook rejeté n'est pas anodin :
        // soit un robot teste l'endpoint, soit — bien plus grave — FedaPay
        // livrait sa notification et que le secret du serveur ne correspond pas
        // à celui du point de terminaison. Dans ce second cas, tous les
        // paiements restent hors cagnotte sans le moindre signal : c'est
        // exactement la panne du 2026-09-27. Le compteur alimente la condition
        // `webhook_rejected` du watchdog, qui alerte sur Discord.
        const rejected = watchdogService.noteWebhookRejected({
          ip: req.ip,
          userAgent: req.get('user-agent'),
          reason: 'signature',
          provider: 'fedapay'
        });
        console.warn(
          `[Webhook] ❌ Rejet n°${rejected} : signature ou origine non authentifiée ` +
          `(IP ${req.ip || 'inconnue'}, UA ${String(req.get('user-agent') || 'inconnu').slice(0, 80)}).`
        );
        // 401 et non 403 : « je n'ai pas authentifié ta requête ». Un 403
        // poderia suggère un problème de configuration réseau côté FedaPay.
        return res.status(401).json({ error: 'Signature invalide.' });
      }

      // Le log n'est écrit qu'APRÈS validation : avant, il laissait croire
      // qu'une notification FedaPay avait été reçue alors qu'elle venait d'être
      // rejetée — exactement ce qui a masqué la panne du 2026-09-27.
      console.log('[Webhook] ✅ Notification FedaPay reçue et authentifiée.');

      const payload = req.body;
      const eventName = payload.name || payload.event || '';
      const entity = payload.entity || payload;

      // Horodatage de réception, APRÈS validation de la signature : c'est ce
      // marqueur qui permet au watchdog de détecter un canal de notification
      // mort. Sans lui, la panne du 2026-09-27 (webhook muet pendant des jours)
      // resterait invisible. On ne l'écrit qu'ici, jamais avant la
      // vérification : un tiers ne doit pas pouvoir « rafraîchir » le
      // marqueur en envoyant des requêtes arbitraires.
      watchdogService.noteWebhookReceived('fedapay');

      console.log(`[Webhook] Événement: "${eventName}", Statut: "${entity?.status}"`);

      // 2. Traitement des transactions approuvées
      if (eventName === 'transaction.approved' || entity?.status === 'approved') {
        const transactionId = entity.id;

        // Idempotence : si la transaction est déjà approuvée en base locale, acquitter sans recalcul
        const existingDonation = DonationRepository.getByTransactionId(transactionId);
        if (existingDonation && existingDonation.status === 'approved') {
          console.log(`[Webhook] ℹ️ Transaction #${transactionId} déjà validée en base (idempotence). Réponse 200 OK.`);
          return res.status(200).json({ received: true, status: 'already_processed' });
        }

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
            paymentMethod,
            provider: 'fedapay'
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
      } else if (eventName === 'transaction.deleted') {
        // Suppression de la transaction chez FedaPay : le donateur a abandonné
        // puis FedaPay a purgé la transaction (ou le paiement a été annulé à la
        // source). Elle ne peut plus jamais aboutir.
        //
        // Sans ce cas, la ligne locale restait 'pending' AD VITAM : elle ne se
        // comptabilisait pas (juste un parasite invisible), mais elle
        // déclenchait l'alerte « paiement encaissé mais non comptabilisé » —
        // un faux positif sur un paiement qui n'a jamais eu lieu. Constaté le
        // 2026-09-27 sur la transaction #113346747 (5 000 FCFA abandonnés).
        const transactionId = entity.id;
        DonationRepository.updateStatus(transactionId, 'canceled');
        console.log(`[Webhook] Transaction #${transactionId} supprimée chez FedaPay : marquée annulée (la cagnotte ne change pas).`);
      } else if (eventName.includes('refund')) {
        // Remboursement : l'argent est reparti, le don ne doit plus compter
        // dans la cagnotte (seuls les statuts 'approved' y figurent).
        const transactionId = entity.id;
        DonationRepository.updateStatus(transactionId, 'refunded');
        console.log(`[Webhook] Transaction #${transactionId} remboursée : retirée de la cagnotte.`);
      }

      // 3. Réponse 200 OK obligatoire pour FedaPay
      return res.status(200).json({ received: true, status: 'processed' });
    } catch (error) {
      console.error('[Webhook] ❌ Erreur lors du traitement:', error.message);
      // FedaPay réessaie si code != 200
      return res.status(500).json({ error: 'Erreur interne de traitement webhook.' });
    }
  },

  /**
   * Endpoint POST /api/webhook/moneroo
   *
   * ⚠️ SÉCURITÉ : la signature Moneroo (X-Moneroo-Signature) ne porte AUCUN
   * timestamp, donc AUCUNE protection anti-rejeu native. Un webhook intercepté
   * reste rejouable. Les protections réelles sont ailleurs :
   *   - l'idempotence en base (une transaction déjà approuvée est acquittée) ;
   *   - la RE-VÉRIFICATION systématique via l'API Moneroo avant toute mise à
   *     jour de la cagnotte (la doc Moneroo indique elle-même que le webhook
   *     est INCOMPLET et ne doit jamais être la source de vérité).
   * Le handler effectue cet appel réseau de façon SYNCHRONE : Moneroo exige
   * une réponse en moins de 3 s, sous peine de réessayer jusqu'à 3 fois.
   */
  async handleMonerooWebhook(req, res) {
    try {
      // 1. Vérification de la signature du webhook
      const isValid = monerooService.verifyWebhook(req.headers, req.body, req.rawBody);
      if (!isValid) {
        const rejected = watchdogService.noteWebhookRejected({
          ip: req.ip,
          userAgent: req.get('user-agent'),
          reason: 'signature-moneroo',
          provider: 'moneroo'
        });
        console.warn(
          `[Webhook] ❌ Rejet n°${rejected} (Moneroo) : signature ou origine non authentifiée ` +
          `(IP ${req.ip || 'inconnue'}, UA ${String(req.get('user-agent') || 'inconnu').slice(0, 80)}).`
        );
        // 403 (et non 401) : c'est le code attendu par Moneroo pour une
        // signature invalide.
        return res.status(403).json({ error: 'Signature invalide.' });
      }

      // Log écrit APRÈS validation de la signature (sinon il masque un rejet).
      console.log('[Webhook] ✅ Notification Moneroo reçue et authentifiée.');
      watchdogService.noteWebhookReceived('moneroo');

      const eventName = req.body.event;
      const data = req.body.data || req.body;

      console.log(`[Webhook] Événement Moneroo: "${eventName}", Statut: "${data?.status}"`);

      // 2. Traitement des paiements réussis
      if (eventName === 'payment.success' || data.status === 'success') {
        const transactionId = data.id;

        // Idempotence : déjà approuvée en base → acquitter sans recalcul
        const existingDonation = DonationRepository.getByTransactionId(transactionId);
        if (existingDonation && existingDonation.status === 'approved') {
          console.log(`[Webhook] ℹ️ Transaction #${transactionId} (Moneroo) déjà validée en base (idempotence). Réponse 200 OK.`);
          return res.status(200).json({ received: true, status: 'already_processed' });
        }

        // RE-VÉRIFICATION obligatoire : la notification Moneroo n'est jamais
        // fiable à elle seule (doc explicite). Timeout court (2,5 s) car
        // Moneroo abandonne la livraison à 3 s.
        let verifiedTx = null;
        try {
          verifiedTx = await monerooService.getTransaction(transactionId, { timeoutMs: 2500 });
        } catch (apiErr) {
          // L'appel ÉCHOUE (timeout, réseau, 401, quota) : on ne peut PAS
          // acquitter. Un 200 ferait considérer la notification comme livrée et
          // Moneroo ne réessaierait pas → on répond 500 pour forcer le retry.
          // La ligne locale reste 'pending'.
          console.error(`[Webhook] ❌ Vérification Moneroo impossible pour #${transactionId} (${apiErr.message}). Retry demandé.`);
          return res.status(500).json({ error: 'Vérification impossible, retry requis.' });
        }

        if (verifiedTx && verifiedTx.status === 'approved') {
          // On privilégie la réponse vérifiée (canonique) ; le payload webhook
          // sert de repli. Les métadonnées Moneroo étant des String, is_public
          // et hide_amount sont comparés à la chaîne "true".
          const paymentMethod = verifiedTx.mode || 'mobile_money';
          const amount = verifiedTx.amount || data.amount;
          const reference = verifiedTx.reference || data.reference || transactionId;
          const customer = verifiedTx.customer || data.customer || {};
          const metadata = verifiedTx.custom_metadata || data.metadata || {};

          // Parité de montant : on signale sans bloquer (le montant vérifié
          // fait foi, il reflète l'encaissement réel).
          const localDonation = DonationRepository.getByTransactionId(transactionId);
          if (verifiedTx.amount !== undefined && localDonation && Number(verifiedTx.amount) !== Number(localDonation.amount)) {
            console.warn(`[Webhook] ⚠️ Parité de montant (Moneroo) pour #${transactionId} : API=${verifiedTx.amount} vs local=${localDonation.amount}.`);
          }

          console.log(`[Webhook] ✅ Paiement effectif certifié (Moneroo) pour #${transactionId} (${amount} XOF). Mise à jour de la cagnotte.`);

          DonationRepository.upsertApprovedFromWebhook({
            transactionId,
            reference,
            firstname: customer.firstname || customer.first_name || 'Généreux',
            lastname: customer.lastname || customer.last_name || 'Donateur',
            phone: customer.phone_number?.number || customer.phone || '',
            email: customer.email || null,
            amount,
            currency: verifiedTx.currency || 'XOF',
            message: metadata.message || null,
            isPublic: metadata.is_public !== undefined ? String(metadata.is_public) === 'true' : true,
            hideAmount: metadata.hide_amount !== undefined ? String(metadata.hide_amount) === 'true' : false,
            paymentMethod,
            provider: 'moneroo'
          });

          console.log(`[Webhook] 🎉 Montant de ${amount} FCFA définitivement comptabilisé dans la cagnotte.`);
        } else {
          const currentDonation = DonationRepository.getByTransactionId(transactionId);
          if (currentDonation && currentDonation.status !== 'approved') {
            DonationRepository.updateStatus(transactionId, 'pending');
          }
          console.log(`[Webhook] 🚫 Transaction #${transactionId} non confirmée par Moneroo: la cagnotte n'a pas été mise à jour.`);
        }
      } else if (eventName === 'payment.cancelled' || eventName === 'payment.failed') {
        const id = data.id;

        // Idempotence d'ABORD : un paiement déjà approuvé ne doit JAMAIS être
        // rétrogradé, même si la livraison est désordonnée ou rejouée.
        const existingDonation = DonationRepository.getByTransactionId(id);
        if (existingDonation && existingDonation.status === 'approved') {
          console.log(`[Webhook] ℹ️ Transaction #${id} (Moneroo) déjà approuvée : ${eventName} ignoré (idempotence).`);
          return res.status(200).json({ received: true, status: 'already_processed' });
        }

        // Re-vérification : on ne rétrograde QUE si l'API confirme l'état final.
        let confirmed = null;
        try {
          confirmed = await monerooService.getTransaction(id, { timeoutMs: 2500 });
        } catch (e) {
          console.warn(`[Webhook] Vérification ${eventName} impossible pour #${id} (Moneroo):`, e.message);
        }

        const targetStatus = eventName === 'payment.failed' ? 'declined' : 'canceled';
        if (confirmed && (confirmed.status === 'declined' || confirmed.status === 'canceled')) {
          DonationRepository.updateStatus(id, targetStatus);
          console.log(`[Webhook] Statut de transaction #${id} mis à jour: ${targetStatus} (Moneroo, vérifié).`);
        } else {
          console.log(`[Webhook] Transaction #${id} (Moneroo) ${eventName} non confirmée par l'API : ligne laissée en l'état, la réconciliation reste le filet.`);
        }
      }

      // 3. Réponse 200 OK obligatoire pour Moneroo (sinon retry x3)
      return res.status(200).json({ received: true, status: 'processed' });
    } catch (error) {
      console.error('[Webhook] ❌ Erreur lors du traitement Moneroo:', error.message);
      return res.status(500).json({ error: 'Erreur interne de traitement webhook.' });
    }
  }
};

module.exports = WebhookController;
