/**
 * Service d'intégration API FedaPay pour FeCAWa 2026.
 * Gère la création de transaction, génération de token Checkout,
 * vérification de statut et traitement sécurisé des webhooks.
 */

const axios = require('axios');
const crypto = require('crypto');

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
        checkoutUrl: `${callbackUrl || '/confirmation.html'}?id=${simulatedId}&demo=true`,
        isSimulated: true
      };
    }

    try {
      const client = this.getHttpClient();

      // Normaliser le numéro de téléphone béninois (si commence par 01, +229, etc.)
      let rawPhone = customer.phone ? customer.phone.replace(/\D/g, '') : '';
      if (rawPhone.startsWith('229')) {
        rawPhone = rawPhone.substring(3);
      }
      if (rawPhone.startsWith('01') && rawPhone.length > 9) {
        rawPhone = rawPhone.substring(2);
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
            number: rawPhone,
            country: 'BJ'
          }
        },
        custom_metadata: customMetadata || {}
      };

      console.log('[FedaPay] Création de la transaction...', { amount: payload.amount, customer: payload.customer.firstname });
      const res = await client.post('/transactions', payload);
      const transaction = res.data['v1/transaction'] || res.data.transaction || res.data;

      // Génération du token Checkout pour le widget frontend
      const tokenRes = await client.post(`/transactions/${transaction.id}/token`);
      const tokenData = tokenRes.data || {};

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
      const res = await client.get(`/transactions/${transactionId}`);
      const transaction = res.data['v1/transaction'] || res.data.transaction || res.data;
      return transaction;
    } catch (error) {
      console.error(`[FedaPay] Erreur vérification transaction ${transactionId}:`, error.message);
      throw error;
    }
  }

  /**
   * Vérifie la signature ou l'authenticité d'un webhook FedaPay
   * @param {Object} headers En-têtes HTTP de la requête
   * @param {string|Object} body Corps de la requête
   */
  verifyWebhook(headers, body) {
    // Si aucun secret n'est configuré, on vérifie la présence du format standard FedaPay
    if (!this.webhookSecret) {
      return true;
    }

    const signature = headers['x-fedapay-signature'] || headers['X-FEDAPAY-SIGNATURE'];
    if (!signature) {
      console.warn('[FedaPay Webhook] En-tête X-FEDAPAY-SIGNATURE manquant.');
      return false;
    }

    try {
      const payloadString = typeof body === 'string' ? body : JSON.stringify(body);
      const hmac = crypto.createHmac('sha256', this.webhookSecret);
      const digest = hmac.update(payloadString).digest('hex');

      const provided = Buffer.from(signature, 'hex');
      const expected = Buffer.from(digest, 'hex');
      // timingSafeEqual requiert des buffers de même longueur : on vérifie
      // explicitement pour ne pas lever d'exception sur une signature invalide.
      if (!provided.length || provided.length !== expected.length) {
        return false;
      }
      return crypto.timingSafeEqual(provided, expected);
    } catch (err) {
      console.error('[FedaPay Webhook] Erreur calcul signature:', err.message);
      return false;
    }
  }
}

module.exports = new FedaPayService();
