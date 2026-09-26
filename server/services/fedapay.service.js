/**
 * Service d'intégration API FedaPay pour FeCAWa 2026.
 * Gère la création de transaction, génération de token Checkout,
 * vérification de statut et traitement sécurisé des webhooks.
 */

const axios = require('axios');
const { normalizeDonorPhone } = require('./phone.service');
const crypto = require('crypto');

/**
 * Normalise la réponse de POST /transactions/:id/token.
 * Vérifié sur l'API live : la réponse est plate { token, url }.
 * Par défense, on gère aussi l'enveloppe "v1/token" d'autres modèles d'API.
 */
function unwrapTokenData(data) {
  const wrap = data || {};
  return wrap['v1/token'] || wrap;
}

class FedaPayService {
  constructor() {
    this.secretKey = process.env.FEDAPAY_SECRET_KEY || '';
    this.publicKey = process.env.FEDAPAY_PUBLIC_KEY || '';
    this.webhookSecret = process.env.FEDAPAY_WEBHOOK_SECRET || '';

    // Détection automatique : si la clé commence par sk_live_, forcer le mode live
    if (this.secretKey.startsWith('sk_live_')) {
      this.env = 'live';
    } else if (this.secretKey.startsWith('sk_sandbox_')) {
      this.env = 'sandbox';
    } else {
      this.env = process.env.FEDAPAY_ENV === 'live' ? 'live' : 'sandbox';
    }

    // URL de base de l'API selon l'environnement
    this.baseUrl = this.env === 'live'
      ? 'https://api.fedapay.com/v1'
      : 'https://sandbox-api.fedapay.com/v1';

    // Détecter si les clés sont des placeholders pour proposer un mode simulation si besoin
    this.isSampleKey = !this.secretKey || this.secretKey.includes('sample_key') || this.secretKey.includes('votre_cle');

    // Budget d'appels sortants (fenêtre glissante d'1 h). Plafond par défaut
    // très supérieur à l'usage normal d'un festival (une vérification par
    // donateur + quelques contrôles), mais assez bas pour qu'un abus ne
    // puisse pas vider le quota du compte FedaPay. 0 = désactivé.
    const quotaMax = parseInt(process.env.FEDAPAY_OUTGOING_QUOTA_PER_HOUR || '600', 10);
    this.outgoingQuota = {
      max: Number.isFinite(quotaMax) && quotaMax >= 0 ? quotaMax : 600,
      hits: []
    };

    if (this.isSampleKey) {
      console.warn('[FedaPay] ⚠️ Aucune clé FedaPay valide configurée dans .env (Mode démonstration/simulation activé).');
    } else {
      console.log(`[FedaPay] ✅ Initialisé en mode [${this.env.toUpperCase()}]. Base URL: ${this.baseUrl}`);
    }
  }

  /**
   * Client HTTP préconfiguré avec les en-têtes d'authentification FedaPay
   */
  getHttpClient() {
    return axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'FeCAWa-Donation-Platform/1.0.0'
      },
      timeout: 15000
    });
  }

  /**
   * Budget d'appels sortants.
   *
   * Le quota du compte FedaPay est fini : sans plafond, n'importe quel client
   * peut le consommer à l'excès en enchaînant des vérifications de
   * transaction, ce qui bloque les encaissements légitimes. Le budget est
   * global au processus : il ne dépend d'aucune clé de rate-limit, donc il
   * résiste à l'usurpation d'IP. Fenêtre glissante d'une heure.
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
   * Exécute un appel API FedaPay en respectant le budget d'appels sortants.
   */
  async callFeda(fn, label) {
    if (!this.consumeOutgoingQuota(1)) {
      const err = new Error(
        `Budget d'appels FedaPay épuisé (${this.outgoingQuota.max}/h). Opération "${label}" refusée.`
      );
      err.code = 'FEDA_QUOTA_EXCEEDED';
      console.error(`[FedaPay] 🛑 Budget d'appels sortants épuisé : "${label}" refusée.`);
      throw err;
    }
    return fn();
  }

  /**
   * Crée une transaction sur l'API FedaPay
   * @param {Object} params { amount, description, customer, customMetadata, callbackUrl }
   */
  async createTransaction(params) {
    const { amount, description, customer, customMetadata, callbackUrl } = params;

    // Mode simulation si les clés FedaPay n'ont pas encore été renseignées dans le .env
    if (this.isSampleKey) {
      console.log('[FedaPay Simulator] Simulation d\'une transaction FedaPay...', { amount, customer });
      const simulatedId = 'sim_' + Date.now();
      const simulatedToken = 'tok_simulated_' + Math.random().toString(36).substring(2, 10);
      return {
        id: simulatedId,
        reference: 'FEC-' + Date.now().toString().slice(-6),
        amount: amount,
        status: 'pending',
        token: simulatedToken,
        checkoutUrl: `${callbackUrl || '/confirmation.html'}?id=${simulatedId}`,
        isSimulated: true
      };
    }

    try {
      const client = this.getHttpClient();

      // Normalisation du numéro : FedaPay exige un numéro NATIONAL et un pays
      // cohérent. L'ancien code envoyait le numéro brut avec `country: 'BJ'`
      // en dur, ce qui rejetait toute saisie portant un autre indicatif pays
      // (ex. « +225 07 … » pour un donateur ivoirien) avec un message
      // illisible côté donateur. Voir services/phone.service.js.
      const phone = normalizeDonorPhone(customer.phone);
      if (!phone.ok) {
        // Erreur volontairement AVANT tout appel réseau : le donateur reçoit un
        // message actionnable, et l'appel échoué ne consomme pas le quota
        // sortant FedaPay.
        const error = new Error(
          `Numéro de téléphone non exploitable pour le paiement (${phone.reason}). ` +
          'Merci de le ressaisir au format international, ex. +229 01 97 51 23 45.'
        );
        error.statusCode = 400;
        error.isUserError = true;
        throw error;
      }

      const payload = {
        description: description || 'Souscription FeCAWa 2026',
        amount: parseInt(amount, 10),
        currency: {
          iso: 'XOF'
        },
        callback_url: callbackUrl,
        customer: {
          firstname: customer.firstname,
          lastname: customer.lastname,
          email: customer.email || `${customer.phone.replace(/\D/g, '') || 'donateur'}@fecawa-waama.org`,
          phone_number: {
            number: phone.national,
            country: phone.country
          }
        },
        custom_metadata: customMetadata || {}
      };

      console.log('[FedaPay] Création de la transaction...', { amount: payload.amount, customer: payload.customer.firstname });
      const res = await this.callFeda(() => client.post('/transactions', payload), 'create-transaction');
      const transaction = res.data['v1/transaction'] || res.data.transaction || res.data;

      // Génération du token Checkout pour le widget frontend.
      // Réponse live (vérifiée) : { token, url } en plat. unwrapTokenData gère en
      // plus l'enveloppe "v1/token" par défense (fonction pure, testée).
      const tokenRes = await this.callFeda(
        () => client.post(`/transactions/${transaction.id}/token`),
        'create-token'
      );
      const tokenData = unwrapTokenData(tokenRes.data);

      return {
        id: transaction.id,
        reference: transaction.reference,
        amount: transaction.amount,
        status: transaction.status,
        token: tokenData.token,
        checkoutUrl: tokenData.url,
        isSimulated: false
      };
    } catch (error) {
      // Logging complet pour diagnostiquer la vraie cause (status + corps + détails)
      const status = error.response?.status;
      const data = error.response?.data;
      const errorMsg = data?.message || data?.errors || error.message;
      console.error('[FedaPay] Erreur lors de la création de la transaction:');
      console.error(`  Status HTTP : ${status || 'N/A'}`);
      console.error(`  Message     : ${errorMsg}`);
      if (data && (data.errors || data.error)) {
        console.error(`  Détails     : ${JSON.stringify(data.errors || data.error)}`);
      }
      if (error.code === 'ECONNABORTED') {
        console.error('  Cause       : Timeout (15s) — API FedaPay injoignable ou trop lente.');
      }
      throw new Error(`Erreur FedaPay: ${JSON.stringify(errorMsg)}`);
    }
  }

  /**
   * Vérifie le statut d'une transaction auprès de FedaPay
   * @param {string|number} transactionId
   */
  async getTransaction(transactionId) {
    if (!transactionId) throw new Error('Transaction ID requis.');

    // En mode simulation
    if (this.isSampleKey || String(transactionId).startsWith('sim_')) {
      return {
        id: transactionId,
        status: 'approved',
        amount: 5000,
        currency: 'XOF',
        reference: 'SIM-REF-OK',
        isSimulated: true
      };
    }

    try {
      const client = this.getHttpClient();
      const res = await this.callFeda(
        () => client.get(`/transactions/${transactionId}`),
        `get-transaction:${transactionId}`
      );
      const transaction = res.data['v1/transaction'] || res.data.transaction || res.data;
      return transaction;
    } catch (error) {
      console.error(`[FedaPay] Erreur vérification transaction ${transactionId}:`, error.message);
      throw error;
    }
  }

  /**
   * Vérifie la signature et l'authenticité d'un webhook FedaPay.
   *
   * Format officiel unique : en-tête `X-FEDAPAY-SIGNATURE` = `t=<timestamp>,s=<hex>`
   * où s = HMAC-SHA256(secret, "<timestamp>.<corps brut>").
   *
   * La documentation FedaPay est explicite : « FedaPay inclut un horodatage
   * (timestamp) dans l'en-tête X-FEDAPAY-SIGNATURE pour empêcher les attaques
   * par nouvelle tentative » et « si l'horodatage est trop ancien, votre
   * application peut rejeter le webhook ». Le timestamp est donc TOUJOURS
   * présent, et chaque réessai régénère signature + horodatage.
   *
   * Un ancien repli acceptait un HMAC direct sur le corps, SANS timestamp,
   * donc SANS aucune protection anti-rejeu : un webhook intercepté restait
   * rejouable indéfiniment. Ce repli a été SUPPRIMÉ (2026-09-26) — il était
   * mort en pratique et affaiblissait la sécurité. Toute signature acceptée
   * doit désormais porter un timestamp frais.
   *
   * @param {Object} headers En-têtes HTTP de la requête
   * @param {Object} body Corps analysé de la requête
   * @param {string} [rawBody] Corps brut reçu sur le socket HTTP
   */

  verifyWebhook(headers, body, rawBody = null) {
    // Si aucun secret n'est configuré
    if (!this.webhookSecret) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[FedaPay Webhook] ❌ Rejet strict: FEDAPAY_WEBHOOK_SECRET non configuré en production.');
        return false;
      }
      // En environnement de test ou développement sans secret, autoriser si aucun header n'est fourni
      const testSig = headers['x-fedapay-signature'] || headers['X-FEDAPAY-SIGNATURE'];
      if (!testSig) {
        return true;
      }
    }

    const signatureHeader = headers['x-fedapay-signature'] || headers['X-FEDAPAY-SIGNATURE'];
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      console.warn('[FedaPay Webhook] En-tête X-FEDAPAY-SIGNATURE manquant ou invalide.');
      return false;
    }

    try {
      // 1. Déterminer le payload string brut
      const payloadString = (typeof rawBody === 'string' && rawBody.length > 0)
        ? rawBody
        : (typeof body === 'string' ? body : JSON.stringify(body));

      // 2. Extraire le timestamp et la signature (format officiel : t=...,s=...)
      let timestamp = null;
      const candidates = [];
      const items = signatureHeader.split(',');

      for (const item of items) {
        const parts = item.trim().split('=');
        if (parts.length === 2) {
          const key = parts[0].trim().toLowerCase();
          const val = parts[1].trim();
          if (key === 't') {
            const parsedT = parseInt(val, 10);
            if (Number.isFinite(parsedT)) {
              timestamp = parsedT;
            }
          } else if (key === 's' || key === 'v1' || key === 'sha256') {
            candidates.push(val);
          }
        }
        // NOTE : plus aucun cas d'acceptation d'un hexadécimal « nu » sans
        // timestamp — c'était le point d'entrée du rejeu infini.
      }

      // 3. Le timestamp est OBLIGATOIRE : sans lui, aucune protection
      //    anti-rejeu n'est possible, donc rien n'est accepté.
      if (timestamp === null) {
        console.warn('[FedaPay Webhook] ❌ Signature sans timestamp : rejetée (anti-rejeu impossible).');
        return false;
      }

      if (candidates.length === 0) {
        console.warn('[FedaPay Webhook] ❌ Aucune signature candidate trouvée dans le header.');
        return false;
      }

      // 4. Vérification de la tolérance temporelle (anti-rejeu) : 300 s
      const nowSec = Math.floor(Date.now() / 1000);
      const toleranceSec = 300;
      if (Math.abs(nowSec - timestamp) > toleranceSec) {
        console.warn(`[FedaPay Webhook] ❌ Rejet anti-rejeu : Timestamp hors tolérance (${timestamp} vs now: ${nowSec}).`);
        return false;
      }

      // Comparaison en temps constant et sécurisée (évite ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH_MISMATCH)
      const timingSafeMatches = (expectedHex, candidateHex) => {
        if (!expectedHex || !candidateHex) return false;
        const hashExpected = crypto.createHash('sha256').update(expectedHex.toLowerCase()).digest();
        const hashCandidate = crypto.createHash('sha256').update(candidateHex.toLowerCase()).digest();
        return crypto.timingSafeEqual(hashExpected, hashCandidate);
      };

      // 5. Calculer l'empreinte HMAC attendue
      // signedPayload = `${timestamp}.${payloadString}`
      const signedPayload = `${timestamp}.${payloadString}`;
      const hmac = crypto.createHmac('sha256', this.webhookSecret);
      const expectedSignature = hmac.update(signedPayload).digest('hex');

      for (const candidate of candidates) {
        if (timingSafeMatches(expectedSignature, candidate)) {
          return true;
        }
      }

      console.warn('[FedaPay Webhook] ❌ Signature invalide : aucune correspondance cryptographique.');
      return false;
    } catch (err) {
      console.error('[FedaPay Webhook] Erreur lors de la vérification de la signature:', err.message);
      return false;
    }
  }
}

module.exports = new FedaPayService();
module.exports.unwrapTokenData = unwrapTokenData;
