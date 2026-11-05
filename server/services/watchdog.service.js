/**
 * Watchdog de la cagnotte FeCAWa 2026.
 *
 * Le webhook du fournisseur de paiement et la réconciliation sont deux filets.
 * Ce service est le troisième : il regarde en permanence si l'un des deux vient
 * de lâcher, et prévient un humain sur Discord. Sans lui, une panne de
 * notification est totalement silencieuse — c'est exactement ce qui s'est passé
 * le 2026-09-27 (paiements encaissés, cagnotte figée, aucune alerte, découverte
 * fortuite).
 *
 * LES CONDITIONS SONT NAMESPACÉES PAR FOURNISSEUR. FedaPay et Moneroo peuvent
 * coexister : les états et alertes de l'un ne doivent JAMAIS masquer ceux de
 * l'autre. FedaPay conserve les clés historiques non suffixées (compatibilité
 * `test-platform.js` et des états déjà persistés) ; tout autre fournisseur est
 * suffixé (`...:moneroo`). Les conditions webhook/quota sont évaluées pour le
 * fournisseur ACTIF (`PAYMENT_PROVIDER`), sauf le quota qui est surveillé pour
 * les deux.
 *
 * Conditions surveillées, du plus grave au moins grave :
 *
 *  1. `pending_stale` — CRITIQUE. Au moins un don est 'pending' depuis plus de
 *     ALERT_PENDING_MINUTES (30 min par défaut). C'est la signature d'un
 *     paiement encaissé par le fournisseur que personne n'a comptabilisé. Le
 *     détail des transactions concernées est envoyé dans l'alerte.
 *
 *  2. `webhook_silent` (fedapay) / `webhook_silent:<provider>` — CRITIQUE. Aucune
 *     notification reçue depuis plus de ALERT_WEBHOOK_SILENT_HOURS (2 h) ALORS
 *     QUE des dons ont été créés dans l'intervalle. Sans cette condition, un
 *     festival tranquille déclencherait une alerte par jour ; avec elle, on
 *     n'alerte que si le canal est cassé pendant qu'il sert.
 *
 *  3. `feda_unreachable` — CRITIQUE (clé conservée pour compatibilité, mais le
 *     texte parle désormais du « fournisseur de paiement »). Les derniers cycles
 *     de réconciliation ont échoué en boucle : le filet de sécurité est aveugle,
 *     et le webhook seul ne suffit plus.
 *
 *  4. `quota_low` (fedapay) / `quota_low:<provider>` — AVERTISSEMENT. Le budget
 *     d'appels sortants d'un fournisseur est presque épuisé : la réconciliation
 *     va bientôt échouer en bloc, et avec elle la détection des paiements.
 *
 *  5. `webhook_rejected` (fedapay) / `webhook_rejected:<provider>` — CRITIQUE.
 *     Le fournisseur livre ses notifications mais le serveur les refuse
 *     (secret webhook erroné) : panne totalement muette.
 *
 * Chaque condition a un cooldown (ALERT_COOLDOWN_MINUTES, 6 h par défaut) et
 * déclenche une alerte de RÉSOLUTION quand elle disparaît : sans cela, on ne
 * sait pas si le problème est réglé ou si l'alerte est simplement partie dans
 * le vide.
 */

const { DonationRepository, StateRepository } = require('../config/database');
const fedapayService = require('./fedapay.service');
const monerooService = require('./moneroo.service');
const alertService = require('./alert.service');

const WATCHDOG_ENABLED = (process.env.WATCHDOG_ENABLED || 'true').toLowerCase() !== 'false';
const PENDING_ALERT_MINUTES = Math.max(parseInt(process.env.ALERT_PENDING_MINUTES || '30', 10) || 30, 5);
const WEBHOOK_SILENT_HOURS = Math.max(parseFloat(process.env.ALERT_WEBHOOK_SILENT_HOURS || '2') || 2, 0.25);
const RECONCILIATION_ERROR_THRESHOLD = Math.max(parseInt(process.env.ALERT_RECONCILIATION_ERRORS || '3', 10) || 3, 1);
// Rejets de signature : seuil bas et fenêtre courte. FedaPay réessaie 9 fois en
// exponentiel court : sans fenêtre, 3 rejets couvrent l'essentiel d'une livraison,
// et le compteur ne retombe jamais à zéro (il ne se remet qu'à la réception
// d'une notification VALIDE).
const WEBHOOK_REJECTED_THRESHOLD = Math.max(parseInt(process.env.ALERT_WEBHOOK_REJECTED || '3', 10) || 3, 1);
const WEBHOOK_REJECTED_WINDOW_HOURS = Math.max(parseFloat(process.env.ALERT_WEBHOOK_REJECTED_WINDOW_HOURS || '2') || 2, 0.25);
const COOLDOWN_MINUTES = Math.max(parseFloat(process.env.ALERT_COOLDOWN_MINUTES || '360') || 360, 1);
const QUOTA_ALERT_RATIO = 0.9;

/** Clé d'état applicatif : horodatage du dernier webhook VALIDE reçu. */
const STATE_LAST_WEBHOOK = 'last_webhook_at';
/** Clé d'état applicatif : compteur d'échecs consécutifs de réconciliation. */
const STATE_RECON_ERRORS = 'reconciliation_consecutive_errors';
/** Clé d'état applicatif : conditions de watchdog actuellement alertées. */
const STATE_ACTIVE_ALERTS = 'watchdog_active_alerts';
/** Clé d'état applicatif : nombre de notifications FedaPay REJETÉES (signature invalide). */
const STATE_WEBHOOK_REJECTED = 'webhook_rejected_count';
/** Clé d'état applicatif : horodatage de la dernière notification rejetée. */
const STATE_WEBHOOK_REJECTED_AT = 'webhook_rejected_at';
/** Clé d'état applicatif : sources des dernières notifications rejetées (IP + User-Agent). */
const STATE_WEBHOOK_REJECTED_SOURCES = 'webhook_rejected_sources';

/** Noms lisibles des fournisseurs, pour les titres/descriptions d'alerte. */
const PROVIDER_LABELS = { fedapay: 'FedaPay', moneroo: 'Moneroo' };

/**
 * Fournisseur de paiement actuellement sélectionné (défaut : fedapay).
 * @returns {string}
 */
function activeProvider() {
  return String(process.env.PAYMENT_PROVIDER || 'fedapay').toLowerCase();
}

/**
 * Normalise un nom de fournisseur (retombe sur le provider actif si absent,
 * et passe en minuscules).
 * @param {string} [provider]
 * @returns {string}
 */
function normalizeProvider(provider) {
  return String(provider || activeProvider()).toLowerCase();
}

/**
 * Espace de nommage des clés d'état : FedaPay conserve EXACTEMENT les clés
 * historiques (compatibilité test-platform.js et des états déjà persistés) ;
 * tout autre fournisseur est suffixé (`base:moneroo`). Ainsi les états/alertes
 * des fournisseurs ne se masquent plus mutuellement.
 * @param {string} base
 * @param {string} provider
 * @returns {string}
 */
function providerKey(base, provider) {
  return provider === 'fedapay' ? base : `${base}:${provider}`;
}

/** Libellés lisibles (neutres) pour les alertes de résolution. */
const BASE_LABELS = {
  pending_stale: 'paiements encaissés mais non comptabilisés',
  webhook_silent: 'webhook muet',
  webhook_rejected: 'notifications rejetées pour signature invalide',
  feda_unreachable: 'fournisseur de paiement injoignable',
  quota_low: 'budget d’appels épuisé'
};

/**
 * Libellé lisible d'une clé de condition, qu'elle soit nue (fedapay) ou
 * suffixée `base:provider`. Le nom du fournisseur n'est ajouté entre
 * parenthèses QUE si la clé porte un suffixe.
 * @param {string} key
 * @returns {string}
 */
function labelFor(key) {
  const [base, provider] = String(key).split(':');
  const label = BASE_LABELS[base] || base;
  return provider ? `${label} (${PROVIDER_LABELS[provider] || provider})` : label;
}

/**
 * Convertit un horodatage SQLite ('YYYY-MM-DD HH:MM:SS', UTC) en Date.
 * @param {string|null} value
 * @returns {Date|null}
 */
function parseSqliteUtc(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = new Date(`${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Durée écoulée en heures entre un horodatage SQLite et maintenant.
 * @param {string|null} value
 * @returns {number|null} null si l'horodatage est absent ou illisible
 */
function hoursSince(value) {
  const date = parseSqliteUtc(value);
  if (!date) return null;
  return (Date.now() - date.getTime()) / 3600000;
}

class WatchdogService {
  constructor() {
    this.lastReport = null;
  }

  /**
   * Conditions actuellement en état d'alerte.
   * Persistées dans app_state : un redémarrage du conteneur ne doit pas faire
   * oublier qu'une alerte est déjà partie (sinon le cycle suivant renverrait
   * le même message), ni faire perdre une panne en cours.
   * @returns {string[]}
   */
  getActiveAlerts() {
    const raw = StateRepository.get(STATE_ACTIVE_ALERTS) || '';
    return raw.split(',').map((k) => k.trim()).filter(Boolean);
  }

  /**
   * @param {string[]} keys
   */
  setActiveAlerts(keys) {
    const clean = [...new Set((keys || []).filter(Boolean))];
    StateRepository.set(STATE_ACTIVE_ALERTS, clean.join(','));
  }

  /**
   * Note la réception d'une notification authentifiée POUR UN FOURNISSEUR.
   * Appelé par le contrôleur webhook APRÈS vérification de la signature : on ne
   * veut pas qu'un tiers puisse repousser cet horodatage en forçant l'envoi
   * de requêtes arbitraires.
   *
   * Sans argument, retombe sur le fournisseur actif → les clés FedaPay
   * historiques (non suffixées) sont utilisées, comme avant.
   *
   * @param {string} [provider=fedapay] Fournisseur concerné
   * @returns {string} horodatage enregistré
   */
  noteWebhookReceived(provider = activeProvider()) {
    const p = normalizeProvider(provider);
    // datetime('now') est en UTC, format identique à celui du schéma.
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    // Une notification authentifiée remet le compteur de rejets DU MÊME
    // fournisseur à zéro : le canal fonctionne de nouveau pour lui — un webhook
    // Moneroo valide ne doit donc PAS masquer l'alerte de rejets FedaPay.
    StateRepository.set(providerKey(STATE_WEBHOOK_REJECTED, p), 0);
    return StateRepository.set(providerKey(STATE_LAST_WEBHOOK, p), stamp);
  }

  /**
   * Note une notification REJETÉE (signature invalide, origine non
   * authentifiée, ou rejeu).
   *
   * C'est le contrôle le plus important du watchdog. Le 2026-09-27, FedaPay
   * livrait bien ses notifications — mais le serveur les rejetait toutes, car le
   * secret configuré n'était pas celui du point de terminaison (chaque endpoint
   * FedaPay a son propre secret). Sans ce compteur, cette situation est
   * INDÉTECTABLE : le serveur ne voit que des 401, et la cagnotte reste figée
   * sans le moindre signal. Compter les rejets, c'est transformer une panne
   * muette en panne bruyante.
   *
   * @param {{ip?: string, userAgent?: string, reason?: string, provider?: string}} [context]
   * @returns {number} nombre total de rejets (pour ce fournisseur)
   */
  noteWebhookRejected(context = {}) {
    const p = normalizeProvider(context.provider);
    const countKey = providerKey(STATE_WEBHOOK_REJECTED, p);
    const count = (Number(StateRepository.get(countKey)) || 0) + 1;
    StateRepository.set(countKey, count);
    StateRepository.set(providerKey(STATE_WEBHOOK_REJECTED_AT, p), new Date().toISOString().slice(0, 19).replace('T', ' '));

    // On ne conserve que les 5 dernières sources : assez pour distinguer un
    // robot (User-Agent inconnu) des serveurs FedaPay, sans transformer
    // app_state en journal de requêtes.
    const ip = String(context.ip || 'inconnue').slice(0, 45);
    const userAgent = String(context.userAgent || 'inconnu').slice(0, 120);
    const label = `${ip} — ${userAgent}`.replace(/[,\n\r]/g, ' ');
    const sourcesKey = providerKey(STATE_WEBHOOK_REJECTED_SOURCES, p);
    const previous = (StateRepository.get(sourcesKey) || '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    StateRepository.set(sourcesKey, [label, ...previous].slice(0, 5).join('|'));
    return count;
  }

  /**
   * Consigne le résultat d'un cycle de réconciliation.
   * @param {{checked: number, updated: number, errors: number}} result
   */
  noteReconciliationResult(result) {
    const errors = Number(result?.errors) || 0;
    // Remise à zéro dès qu'un cycle passe : le compteur mesure une série
    // d'échecs CONSÉCUTIFS, pas un total sur la journée.
    StateRepository.set(STATE_RECON_ERRORS, errors > 0 ? errors : 0);
  }

  /**
   * Analyse l'état courant et déclenche les alertes utiles.
   * @returns {Promise<Object>} résumé des conditions détectées (utile aux tests)
   */
  async check() {
    const conditions = [];
    const now = new Date();

    // Toutes les conditions webhook/quota sont évaluées POUR LE FOURNISSEUR
    // ACTIF : les états FedaPay et Moneroo ne se masquent plus mutuellement.
    const active = activeProvider();
    const providerName = PROVIDER_LABELS[active] || active;

    // --- 1. Dons en attente depuis trop longtemps -----------------------------
    const stale = DonationRepository.getStalePendingDonations({ minAgeMinutes: PENDING_ALERT_MINUTES, limit: 10 });
    if (stale.length > 0) {
      const totalStaleAmount = stale.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
      conditions.push({
        key: 'pending_stale',
        severity: 'critical',
        title: `${stale.length} paiement(s) encaissés mais non comptabilisés`,
        description:
          `Des transactions sont restées « en attente » plus de ${PENDING_ALERT_MINUTES} minutes alors que FedaPay les a peut-être déjà encaissées. ` +
          'La cagnotte affichée est donc potentiellement sous-évaluée. Vérifie le dashboard FedaPay : si ces transactions y sont approuvées, lance un cycle de réconciliation.',
        fields: [
          { name: 'Transactions concernées', value: `**${stale.length}** (montant cumulé : ${totalStaleAmount.toLocaleString('fr-FR')} FCFA)`, inline: true },
          { name: 'Seuil', value: `${PENDING_ALERT_MINUTES} min`, inline: true },
          {
            name: 'Détail',
            // AUCUNE donnée nominative dans l'alerte : elle part sur un service
            // tiers (Discord) et finit dans un salon, potentiellement partagé
            // ou capturé par capture d'écran. L'identifiant de transaction suffit
            // à retrouver le donateur dans l'export ou Adminer — le nom n'apporte
            // rien au diagnostic et l'exposerait inutilement.
            value: stale
              .slice(0, 8)
              .map((row) => `\`#${row.id}\` \`${row.transaction_id}\` — ${Number(row.amount).toLocaleString('fr-FR')} FCFA — en attente depuis ${row.age_minutes} min`)
              .join('\n')
          }
        ]
      });
    }

    // --- 2. Webhook muet alors qu'on reçoit des dons --------------------------
    //
    // Deux cas distincts, même condition :
    //   a) jamais aucune notification reçue, alors que des dons ont été créés
    //      depuis plus de X heures → le canal n'a jamais fonctionné (exactement
    //      l'état du 2026-09-27, où le webhook était mort depuis le début) ;
    //   b) dernière notification ancienne, mais une donation récente → le canal
    //      vient de casser.
    // Sans le contre-test « des dons sont arrivés », un festival tranquille
    // déclencherait une alerte par jour pour rien.
    const lastWebhookAt = StateRepository.get(providerKey(STATE_LAST_WEBHOOK, active));
    const lastDonationAt = DonationRepository.getLastDonationCreatedAt();
    const hoursSinceWebhook = hoursSince(lastWebhookAt);
    const hoursSinceDonation = hoursSince(lastDonationAt);

    const neverReceived = lastWebhookAt === null;
    const silenceDetected = neverReceived || (hoursSinceWebhook !== null && hoursSinceWebhook > WEBHOOK_SILENT_HOURS);
    const donationsInWindow = hoursSinceDonation !== null && hoursSinceDonation < WEBHOOK_SILENT_HOURS;
    const donationsBeforeWindow = hoursSinceDonation !== null && hoursSinceDonation >= WEBHOOK_SILENT_HOURS;
    const shouldAlert = silenceDetected
      && (neverReceived ? donationsBeforeWindow : donationsInWindow);

    if (shouldAlert) {
      conditions.push({
        // Clé de condition par fournisseur : 'webhook_silent' (fedapay) ou
        // 'webhook_silent:moneroo'.
        key: providerKey('webhook_silent', active),
        severity: 'critical',
        title: neverReceived
          ? `Aucune notification ${providerName} reçue alors que des dons sont passés`
          : `Webhook ${providerName} muet alors que des dons arrivent`,
        description: neverReceived
          ? `Aucun webhook ${providerName} n'a jamais été reçu, et ${Math.round(hoursSinceDonation)} h séparent la dernière souscription. ` +
            'Les paiements ne sont donc comptabilisés que par la réconciliation, sans aucune notification : c\'est la situation qui a laissé 2 000 FCFA hors cagnotte le 2026-09-27.'
          : `Aucune notification ${providerName} depuis ${Math.round(hoursSinceWebhook)} h, mais ${Math.round(hoursSinceDonation)} h séparent la dernière souscription. ` +
            'Le canal de notification est cassé : les paiements ne seront comptabilisés que par la réconciliation (toutes les 10 min), avec un risque d\'échec.',
        fields: [
          { name: 'Dernier webhook', value: lastWebhookAt || 'JAMAIS reçu', inline: true },
          { name: 'Dernière souscription', value: lastDonationAt || 'aucune', inline: true },
          { name: 'Seuil de silence', value: `${WEBHOOK_SILENT_HOURS} h`, inline: true }
        ]
      });
    }

    // --- 3. Notifications FedaPay REJETÉES ------------------------------------
    //
    // Le cas le plus vicieux : FedaPay livre, le serveur refuse. Tout semble
    // fonctionner (le webhook est actif, l'URL répond) mais AUCUN paiement
    // n'entre en base. Cause quasi certaine : FEDAPAY_WEBHOOK_SECRET ne
    // correspond pas au point de terminaison — chaque endpoint FedaPay a son
    // propre secret, unique, différent entre le mode test et le mode live.
    const rejectedCount = Number(StateRepository.get(providerKey(STATE_WEBHOOK_REJECTED, active))) || 0;
    const rejectedAtValue = StateRepository.get(providerKey(STATE_WEBHOOK_REJECTED_AT, active));
    const hoursSinceRejection = hoursSince(rejectedAtValue);
    if (
      rejectedCount >= WEBHOOK_REJECTED_THRESHOLD &&
      hoursSinceRejection !== null &&
      hoursSinceRejection <= WEBHOOK_REJECTED_WINDOW_HOURS
    ) {
      const sources = (StateRepository.get(providerKey(STATE_WEBHOOK_REJECTED_SOURCES, active)) || '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);
      // Le secret à vérifier et l'endroit où le récupérer diffèrent par
      // fournisseur. FedaPay conserve le texte historique.
      const secretVar = active === 'fedapay' ? 'FEDAPAY_WEBHOOK_SECRET' : 'MONEROO_WEBHOOK_SECRET';
      const secretHint = active === 'fedapay'
        ? 'Récupère-le dans Workbench → Webhooks → ton endpoint → « Click to reveal », remplace la valeur dans le `.env`, puis recrée le conteneur.'
        : 'Récupère-le dans Dashboard → Developers → Webhooks, remplace la valeur dans le `.env`, puis recrée le conteneur.';
      conditions.push({
        key: providerKey('webhook_rejected', active),
        severity: 'critical',
        title: `${providerName} livre les notifications, mais le serveur les refuse`,
        description:
          `${rejectedCount} notification(s) ${providerName} rejetée(s) pour signature invalide alors que ${providerName} les a bien envoyées : les paiements sont encaissés mais ne rentrent pas en base. ` +
          `**Cause la plus probable :** \`${secretVar}\` ne correspond pas au point de terminaison — chaque endpoint a son PROPRE secret (différent entre test et live). ` +
          secretHint,
        fields: [
          { name: 'Rejets récents', value: `${rejectedCount} en ${Math.round((hoursSinceRejection || 0) * 60)} min`, inline: true },
          { name: 'Dernier rejet', value: rejectedAtValue || '-', inline: true },
          { name: 'Seuil d’alerte', value: `${WEBHOOK_REJECTED_THRESHOLD} rejets / ${WEBHOOK_REJECTED_WINDOW_HOURS} h`, inline: true },
          { name: 'Sources (IP — User-Agent)', value: sources.join('\n') || 'inconnue' }
        ]
      });
    }

    // --- 4. FedaPay injoignable en boucle -------------------------------------
    const consecutiveErrors = Number(StateRepository.get(STATE_RECON_ERRORS)) || 0;
    if (consecutiveErrors >= RECONCILIATION_ERROR_THRESHOLD) {
      conditions.push({
        key: 'feda_unreachable',
        severity: 'critical',
        title: 'Fournisseur de paiement injoignable : la réconciliation est aveugle',
        description:
          `${consecutiveErrors} cycles de réconciliation consécutifs ont échoué. La seule sécurité restante est le webhook ; ` +
          'vérifie la connectivité sortante et le budget d\'appels du fournisseur actif.',
        fields: [
          { name: 'Échecs consécutifs', value: String(consecutiveErrors), inline: true },
          { name: 'Seuil d’alerte', value: `${RECONCILIATION_ERROR_THRESHOLD} cycles`, inline: true }
        ]
      });
    }

    // --- 5. Budget d'appels sortants presque épuisé ---------------------------
    // On surveille LE QUOTA DE CHAQUE FOURNISSEUR : les deux fenêtres glissantes
    // sont indépendantes, et un quota FedaPay bas ne doit pas masquer un quota
    // Moneroo bas (ni l'inverse).
    const quotaProviders = [
      { name: 'fedapay', service: fedapayService },
      { name: 'moneroo', service: monerooService }
    ];
    for (const { name, service } of quotaProviders) {
      const quota = service.outgoingQuota;
      if (!quota || quota.max <= 0 || !Array.isArray(quota.hits)) continue;
      const used = quota.hits.length;
      if (used / quota.max < QUOTA_ALERT_RATIO) continue;
      const quotaLabel = PROVIDER_LABELS[name] || name;
      conditions.push({
        key: providerKey('quota_low', name),
        severity: 'warning',
        title: `Budget d’appels ${quotaLabel} presque épuisé`,
        description:
          `Le budget horaire d'appels sortants ${quotaLabel} est à ${used}/${quota.max}. Bientôt, la réconciliation et les vérifications ` +
          'seront refusées et les paiements non comptabilisés ne pourront plus être rattrapés.',
        fields: [
          { name: 'Consommé', value: `${used} / ${quota.max}`, inline: true },
          { name: 'Seuil d’alerte', value: `${Math.round(QUOTA_ALERT_RATIO * 100)} %`, inline: true }
        ]
      });
    }

    // --- Envoi ----------------------------------------------------------------
    //
    // `activeAlerts` (persisté dans app_state) est la source de vérité : une
    // condition n'est annoncée qu'à son APPARITION, jamais à chaque cycle, et
    // sa disparition déclenche une alerte de résolution. C'est ce qui rend
    // l'alerte exploitable : on sait que la panne est finie, pas seulement
    // qu'un message est parti.
    const previous = this.getActiveAlerts();
    const detected = new Set(conditions.map((c) => c.key));
    const sent = [];

    for (const condition of conditions) {
      const key = `watchdog:${condition.key}`;
      if (previous.includes(condition.key)) continue; // déjà en cours : pas de spam
      if (alertService.isUnderCooldown(key)) continue; // garde-fou supplémentaire
      const result = await alertService.send({
        title: condition.title,
        description: condition.description,
        severity: condition.severity,
        fields: condition.fields,
        key,
        cooldownMinutes: COOLDOWN_MINUTES
      });
      if (result.sent || result.reason === 'canal non configuré') {
        // « Canal non configuré » compte comme annoncé : sinon le watchdog
        // réessaierait à chaque cycle et répéterait la ligne dans les logs.
        sent.push(condition.key);
      }
    }

    // --- Alerte de résolution -------------------------------------------------
    for (const key of previous) {
      if (detected.has(key)) continue;
      const cooldownKey = `watchdog:${key}`;
      // Le cooldown doit être LEVÉ avant l'envoi : sans cela, la résolution est
      // avalée par le cooldown de l'alerte d'origine (6 h) et l'information la
      // plus importante — « c'est réglé » — ne partirait jamais.
      alertService.markSent(cooldownKey, 0);
      await alertService.send({
        title: `Résolu : ${labelFor(key)}`,
        description: `La condition « ${labelFor(key)} » n'est plus détectée. La cagnotte et les notifications sont de nouveau cohérentes.`,
        severity: 'success',
        key: cooldownKey,
        cooldownMinutes: 0
      });
      this.setActiveAlerts(previous.filter((k) => k !== key));
      console.log(`[Watchdog] Condition résolue : ${key}`);
    }

    this.setActiveAlerts([...detected]);

    // Mémorise l'état pour l'affichage et les tests.
    this.lastReport = {
      checkedAt: now.toISOString(),
      conditions: conditions.map((c) => c.key),
      sent,
      stalePending: stale.length,
      hoursSinceWebhook: hoursSinceWebhook === null ? null : Number(hoursSinceWebhook.toFixed(2)),
      consecutiveErrors
    };

    if (conditions.length > 0) {
      console.warn(`[Watchdog] ${conditions.length} condition(s) détectée(s) : ${this.lastReport.conditions.join(', ')}`);
    } else {
      console.log('[Watchdog] RAS : cagnotte cohérente, notifications opérationnelles.');
    }

    return this.lastReport;
  }
}

module.exports = new WatchdogService();
module.exports.WATCHDOG_ENABLED = WATCHDOG_ENABLED;
module.exports.PENDING_ALERT_MINUTES = PENDING_ALERT_MINUTES;
module.exports.WEBHOOK_SILENT_HOURS = WEBHOOK_SILENT_HOURS;
module.exports.WEBHOOK_REJECTED_THRESHOLD = WEBHOOK_REJECTED_THRESHOLD;
module.exports.STATE_LAST_WEBHOOK = STATE_LAST_WEBHOOK;
