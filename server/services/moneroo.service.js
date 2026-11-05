/**
 * Service d'intégration API Moneroo pour FeCAWa 2026.
 *
 * Calqué sur fedapay.service.js pour exposer le MÊME contrat d'interface
 * (createTransaction / getTransaction / verifyWebhook), ce qui permet à la
 * façade payment.service.js de basculer d'un fournisseur à l'autre sans rien
 * changer au reste du code.
 *
 * Différences notables avec FedaPay :
 *   - une SEULE base URL pour sandbox et live (https://api.moneroo.io/v1) :
 *     seule la clé change ;
 *   - pas de SDK Node officiel → axios brut ;
 *   - le webhook ne porte AUCUN timestamp (pas d'anti-rejeu natif) : voir
 *     verifyWebhook plus bas.
 */

const axios = require('axios');
const { normalizeDonorPhone } = require('./phone.service');
const crypto = require('crypto');

// Correspondance des statuts Moneroo vers les statuts canoniques attendus par
// le reste de l'application (mêmes valeurs que FedaPay).
const STATUS_MAP = {
  success: 'approved',
  failed: 'declined',
  cancelled: 'canceled',
  initiated: 'pending',
  pending: 'pending'
};

class MonerooService {
  constructor() {
    this.secretKey = process.env.MONEROO_SECRET_KEY || '';
    this.publicKey = process.env.MONEROO_PUBLIC_KEY || '';
    this.webhookSecret = process.env.MONEROO_WEBHOOK_SECRET || '';

    // Moneroo n'expose pas d'URL distincte pour le sandbox : seul le jeu de
    // clés change. On garde tout de même un libellé d'environnement pour les logs.
    this.env = process.env.MONEROO_ENV === 'live' ? 'live' : 'sandbox';
    this.baseUrl = 'https://api.moneroo.io/v1';

    // Placeholder / clé absente → mode simulation (aucun appel réseau), comme FedaPay.
    this.isSampleKey =
      !this.secretKey ||
      this.secretKey.includes('votre_cle') ||
      this.secretKey.includes('sample');

    // Budget d'appels sortants (fenêtre glissante d'1 h). Réplique exacte du
    // mécanisme FedaPay : filet de sécurité qui empêche un abus de vider le
    // quota du compte Moneroo (rate limit API : 120 req/min). 0 = désactivé.
    const quotaMax = parseInt(process.env.MONEROO_OUTGOING_QUOTA_PER_HOUR || '600', 10);
    this.outgoingQuota = {
      max: Number.isFinite(quotaMax) && quotaMax >= 0 ? quotaMax : 600,
      hits: []
    };

    if (this.isSampleKey) {
      // N'alerter que si Moneroo est réellement le fournisseur actif : sinon
      // ce serait du bruit à chaque démarrage quand FedaPay est utilisé.
      if (String(process.env.PAYMENT_PROVIDER || '').toLowerCase() === 'moneroo') {
        console.warn('[Moneroo] ⚠️ Aucune clé Moneroo valide configurée dans .env (Mode démonstration/simulation activé).');
      }
    } else {
      console.log(`[Moneroo] ✅ Initialisé en mode [${this.env.toUpperCase()}]. Base URL: ${this.baseUrl}`);
    }
  }

  /**
   * Client HTTP préconfiguré avec les en-têtes d'authentification Moneroo.
   */
  getHttpClient() {
    return axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'FeCAWa-Donation-Platform/1.0.0'
      },
      timeout: 15000
    });
  }

  /**
   * Budget d'appels sortants (fenêtre glissante 1 h), identique à FedaPay.
   */
  consumeOutgoingQuota(cost = 1) {
    if (!this.outgoingQuota || this.outgoingQuota.max <= 0) return true; // désactivé
    const now = Date.now();
    // Purge des entrées hors fenêtre
    while (this.outgoingQuota.hits.length > 0 && now - this.outgoingQuota.hits[0] > 3600000) {
      this.outgoingQuota.hits.shift();
    }
    if (this.outgoingQuota.hits.length + cost > this.outgoingQuota.max) {
      return false;
    }
    for (let i = 0; i < cost; i++) this.outgoingQuota.hits.push(now);
    return true;
  }

  /**
   * Exécute un appel API Moneroo en respectant le budget d'appels sortants.
   */
  async callMoneroo(fn, label) {
    if (!this.consumeOutgoingQuota(1)) {
      const err = new Error(
        `Budget d'appels Moneroo épuisé (${this.outgoingQuota.max}/h). Opération "${label}" refusée.`
      );
      err.code = 'MONEROO_QUOTA_EXCEEDED';
      console.error(`[Moneroo] 🛑 Budget d'appels sortants épuisé : "${label}" refusée.`);
      throw err;
    }
    return fn();
  }

  /**
   * Crée un paiement sur l'API Moneroo.
   * @param {Object} params { amount, description, customer, customMetadata, callbackUrl }
   */
  async createTransaction(params) {
    const { amount, description, customer, customMetadata, callbackUrl } = params;

    // Mode simulation si les clés Moneroo n'ont pas encore été renseignées.
    if (this.isSampleKey) {
      console.log('[Moneroo Simulator] Simulation d\'une transaction Moneroo...', { amount, customer });
      const simulatedId = 'sim_' + Date.now();
      return {
        id: simulatedId,
        reference: simulatedId,
        amount: parseInt(amount, 10),
        status: 'pending',
        token: null,
        publicKey: null,
        checkoutUrl: `${callbackUrl || '/confirmation.html'}?id=${simulatedId}`,
        isSimulated: true
      };
    }

    // Validation du téléphone AVANT tout appel réseau : le donateur reçoit un
    // message actionnable et l'appel échoué ne consomme pas le quota sortant.
    // Volontairement placé HORS du try/catch ci-dessous pour que les attributs
    // statusCode / isUserError survivent (ils seraient écrasés par le rethrow).
    const phone = normalizeDonorPhone(customer.phone);
    if (!phone.ok) {
      const error = new Error(
        `Numéro de téléphone non exploitable pour le paiement (${phone.reason}). ` +
        'Merci de le ressaisir au format international, ex. +229 01 97 51 23 45.'
      );
      error.statusCode = 400;
      error.isUserError = true;
      throw error;
    }

    try {
      const client = this.getHttpClient();

      // Moneroo exige un email : on en fabrique un si le donateur n'en a pas,
      // à partir du numéro normalisé (sans le '+').
      const email = customer.email || `${phone.e164.replace('+', '')}@fecawa-waama.org`;

      // Les métadonnées Moneroo n'acceptent QUE des valeurs String.
      const metadata = {
        message: customMetadata?.message !== undefined && customMetadata?.message !== null
          ? String(customMetadata.message)
          : '',
        is_public: String(Boolean(customMetadata?.is_public)),
        hide_amount: String(Boolean(customMetadata?.hide_amount))
      };

      const payload = {
        amount: parseInt(amount, 10),
        currency: 'XOF',
        description: description || 'Souscription FeCAWa 2026',
        return_url: callbackUrl,
        customer: {
          first_name: customer.firstname,
          last_name: customer.lastname,
          email,
          // TODO(sandbox): confirmer le format attendu (e164 avec '+' vs sans).
          phone: phone.e164
        },
        metadata
      };

      // Restriction pays : uniquement si explicitement configurée. Vide par
      // défaut → on autorise toutes les méthodes de toute la zone XOF.
      if (process.env.MONEROO_RESTRICT_COUNTRY) {
        payload.restrict_country_code = process.env.MONEROO_RESTRICT_COUNTRY;
      }

      console.log('[Moneroo] Création du paiement...', { amount: payload.amount, customer: payload.customer.first_name });
      const res = await this.callMoneroo(
        () => client.post('/payments/initialize', payload),
        'create-payment'
      );
      const data = res.data?.data;
      if (!data || !data.checkout_url) {
        throw new Error('Réponse Moneroo inattendue (data.checkout_url manquant).');
      }

      return {
        id: data.id,
        reference: data.id,
        amount: data.amount !== undefined ? data.amount : parseInt(amount, 10),
        status: 'pending',
        token: null,
        publicKey: null,
        checkoutUrl: data.checkout_url,
        isSimulated: false
      };
    } catch (error) {
      // Logging complet pour diagnostiquer la vraie cause (status + corps + détails)
      const status = error.response?.status;
      const data = error.response?.data;
      const errorMsg = data?.message || data?.errors || error.message;
      console.error('[Moneroo] Erreur lors de la création du paiement:');
      console.error(`  Status HTTP : ${status || 'N/A'}`);
      console.error(`  Message     : ${errorMsg}`);
      if (data && (data.errors || data.error)) {
        console.error(`  Détails     : ${JSON.stringify(data.errors || data.error)}`);
      }
      if (error.code === 'ECONNABORTED') {
        console.error('  Cause       : Timeout (15s) — API Moneroo injoignable ou trop lente.');
      }
      throw new Error(`Erreur Moneroo: ${JSON.stringify(errorMsg)}`);
    }
  }

  /**
   * Vérifie le statut d'un paiement auprès de Moneroo.
   * @param {string|number} transactionId
   */
  async getTransaction(transactionId, { timeoutMs } = {}) {
    if (!transactionId) throw new Error('Transaction ID requis.');

    // Mode simulation : parité avec FedaPay. `isSampleKey` couvre le cas des
    // clés placeholder, sinon un id legacy non-`sim_` déclencherait un vrai
    // appel réseau → 401 → fausse alerte « injoignable ».
    if (this.isSampleKey || String(transactionId).startsWith('sim_')) {
      return {
        id: transactionId,
        status: 'approved',
        mode: 'mobile_money',
        amount: 5000,
        reference: 'SIM-REF-OK',
        customer: { firstname: 'Simulé', lastname: 'Donateur', phone_number: { number: '' }, email: null },
        custom_metadata: {},
        currency: 'XOF',
        isSimulated: true
      };
    }

    try {
      const client = this.getHttpClient();
      const res = await this.callMoneroo(
        // timeoutMs surcharge le timeout d'instance (15 s) quand l'appelant
        // doit respecter une fenêtre plus courte (webhook < 3 s).
        () => client.get(`/payments/${transactionId}/verify`, timeoutMs ? { timeout: timeoutMs } : {}),
        `verify-payment:${transactionId}`
      );
      const data = res.data?.data || {};
      const status = STATUS_MAP[data.status] || 'pending';

      return {
        id: data.id || transactionId,
        status,
        mode: data.capture?.method?.short_code || 'mobile_money',
        amount: data.amount,
        reference: data.id || transactionId,
        customer: {
          firstname: data.customer?.first_name,
          lastname: data.customer?.last_name,
          phone_number: { number: data.capture?.phone_number || data.customer?.phone || '' },
          email: data.customer?.email
        },
        custom_metadata: data.metadata || {},
        currency: data.currency?.code || 'XOF',
        isSimulated: false
      };
    } catch (error) {
      // On rethrow l'erreur axios TELLE QUELLE : la réconciliation a besoin de
      // distinguer un 404 (transaction inconnue → annulée) d'une panne réseau.
      console.error(`[Moneroo] Erreur vérification transaction ${transactionId}:`, error.message);
      throw error;
    }
  }

  /**
   * Vérifie la signature et l'authenticité d'un webhook Moneroo.
   *
   * Format : en-tête `X-Moneroo-Signature` = HMAC-SHA256 HEXADÉCIMAL calculé
   * sur le CORPS BRUT, avec pour clé le secret webhook. Contrairement à
   * FedaPay, il n'y a AUCUN timestamp signé.
   *
   * ⚠️ ABSENCE D'ANTI-REJEU : sans timestamp, un webhook intercepté reste
   * rejouable indéfiniment. C'est une limite assumée du fournisseur, pas un
   * choix. Les protections réelles sont :
   *   - l'idempotence en base (une transaction déjà approuvée est acquittée
   *     sans recalcul) ;
   *   - la RE-VÉRIFICATION systématique via l'API Moneroo (`getTransaction`)
   *     avant toute mise à jour de la cagnotte : la doc précise elle-même que
   *     le webhook est INCOMPLET et ne doit jamais servir de source de vérité.
   *
   * @param {Object} headers En-têtes HTTP de la requête
   * @param {Object} body Corps analysé de la requête
   * @param {string} [rawBody] Corps brut reçu sur le socket HTTP
   */
  verifyWebhook(headers, body, rawBody = null) {
    const signatureHeader = headers['x-moneroo-signature'] || headers['X-Moneroo-Signature'];

    // Si aucun secret n'est configuré
    if (!this.webhookSecret) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[Moneroo Webhook] ❌ Rejet strict: MONEROO_WEBHOOK_SECRET non configuré en production.');
        return false;
      }
      // Hors production, sans secret : on n'accepte qu'une requête SANS signature
      // (tests locaux). Une signature présentée sans secret est rejetée.
      return !signatureHeader;
    }

    if (!signatureHeader || typeof signatureHeader !== 'string') {
      console.warn('[Moneroo Webhook] En-tête X-Moneroo-Signature manquant ou invalide.');
      return false;
    }

    try {
      // 1. Déterminer le payload string brut
      const payloadString = (typeof rawBody === 'string' && rawBody.length > 0)
        ? rawBody
        : (typeof body === 'string' ? body : JSON.stringify(body));

      // 2. Calculer l'empreinte HMAC attendue (hexadécimal)
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(payloadString)
        .digest('hex');

      // Comparaison en temps constant (évite ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH_MISMATCH)
      const timingSafeMatches = (expectedHex, candidateHex) => {
        if (!expectedHex || !candidateHex) return false;
        const hashExpected = crypto.createHash('sha256').update(expectedHex.toLowerCase()).digest();
        const hashCandidate = crypto.createHash('sha256').update(candidateHex.toLowerCase()).digest();
        return crypto.timingSafeEqual(hashExpected, hashCandidate);
      };

      if (timingSafeMatches(expectedSignature, signatureHeader)) {
        return true;
      }

      console.warn('[Moneroo Webhook] ❌ Signature invalide : aucune correspondance cryptographique.');
      return false;
    } catch (err) {
      console.error('[Moneroo Webhook] Erreur lors de la vérification de la signature:', err.message);
      return false;
    }
  }
}

module.exports = new MonerooService();
