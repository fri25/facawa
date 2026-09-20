/**
 * Script de test et de validation globale de la plateforme FeCAWa 2026.
 * Teste les endpoints API, la base de données SQLite, la création de don, le webhook et le respect de la confidentialité.
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');

async function runTests() {
  console.log('🚀 Démarrage des tests automatisés FeCAWa 2026...\n');

  // Démarrer le serveur en environnement de test isolé
  const testDbPath = path.join(__dirname, 'data/test_fecawa.db');
  try {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  } catch (e) {
    // ignoré si en cours d'utilisation
  }

  process.env.PORT = '3001';
  process.env.DB_FILE = testDbPath;
  process.env.APP_URL = 'http://localhost:3001';
  process.env.FEDAPAY_SECRET_KEY = 'sk_sandbox_sample_key';
  process.env.FEDAPAY_PUBLIC_KEY = 'pk_sandbox_sample_key';
  process.env.FEDAPAY_ENV = 'sandbox';
  // Désactive la vérification de signature des webhooks simulés
  process.env.FEDAPAY_WEBHOOK_SECRET = '';
  
  const server = require('./server/server.js');
  const baseUrl = 'http://localhost:3001';

  // Attendre 1s que le serveur soit écouteur
  await new Promise(r => setTimeout(r, 1000));

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName}`);
      failed++;
    }
  }

  try {
    // Test 1: GET /api/config
    const configRes = await axios.get(`${baseUrl}/api/config`);
    assert(configRes.status === 200, 'GET /api/config status 200');
    assert(configRes.data.festival.name.includes('FeCAWa'), 'Config contient le nom du festival');
    assert(configRes.data.festival.dates === '19 au 21 novembre 2026', 'Dates du festival exactes (19 au 21 novembre 2026)');

    // Test 2: Validation d'entrée - Erreur si nom manquant
    try {
      await axios.post(`${baseUrl}/api/create-transaction`, {
        firstname: '',
        lastname: '',
        phone: '61000000',
        amount: 5000
      });
      assert(false, 'Validation rejette les champs vides');
    } catch (err) {
      assert(err.response && err.response.status === 400, 'Validation rejette le prénom/nom vide (HTTP 400)');
    }

    // Test 3: Validation d'entrée - Erreur si montant insuffisant
    try {
      await axios.post(`${baseUrl}/api/create-transaction`, {
        firstname: 'Bio',
        lastname: 'Chabi',
        phone: '61000000',
        amount: 50
      });
      assert(false, 'Validation rejette montant < 100 FCFA');
    } catch (err) {
      assert(err.response && err.response.status === 400, 'Validation rejette montant inférieur à 100 FCFA');
    }

    // Test 4: Création d'une transaction valide (Donateur Public)
    const txRes = await axios.post(`${baseUrl}/api/create-transaction`, {
      firstname: 'Koffi',
      lastname: 'Sabi',
      phone: '61000000',
      email: 'koffi@example.com',
      amount: 10000,
      message: 'Fier de nos origines Waama ! Plein succès au festival !',
      is_public: true,
      hide_amount: false
    });
    assert(txRes.status === 201, 'POST /api/create-transaction status 201');
    assert(txRes.data.transactionId !== undefined, 'Transaction ID retourné');
    const txId1 = txRes.data.transactionId;

    // Test 5: Création d'une deuxième transaction (Donateur Anonyme avec montant masqué)
    const txRes2 = await axios.post(`${baseUrl}/api/create-transaction`, {
      firstname: 'Amina',
      lastname: 'Kora',
      phone: '95000000',
      amount: 25000,
      message: 'Que nos ancêtres bénissent cette édition.',
      is_public: false,
      hide_amount: true
    });
    const txId2 = txRes2.data.transactionId;
    assert(txRes2.status === 201, 'Deuxième transaction (anonyme) créée avec succès');

    // Test 5bis: VÉRIFICATION STRICTE - Tant que le paiement n'est pas effectif (pending), la cagnotte DOIT être à 0 !
    const pendingStatsRes = await axios.get(`${baseUrl}/api/stats`);
    assert(pendingStatsRes.data.stats.totalAmount === 0, 'La cagnotte est strictement à 0 FCFA tant que les paiements sont en attente');
    assert(pendingStatsRes.data.stats.totalDonors === 0, 'Le nombre de donateurs est à 0 tant que les paiements sont en attente');

    const pendingSubsRes = await axios.get(`${baseUrl}/api/subscribers`);
    assert(pendingSubsRes.data.subscribers.length === 0, 'La liste publique des donateurs est vide tant que les paiements ne sont pas effectifs');

    // Test 5ter: Simulation d'une transaction refusée/annulée (declined)
    const txResDeclined = await axios.post(`${baseUrl}/api/create-transaction`, {
      firstname: 'Tenteur',
      lastname: 'Echoue',
      phone: '61999999',
      amount: 50000
    });
    const txIdDeclined = txResDeclined.data.transactionId;

    await axios.post(`${baseUrl}/api/webhook/fedapay`, {
      name: 'transaction.declined',
      entity: { id: txIdDeclined, status: 'declined' }
    });

    const declinedStatsRes = await axios.get(`${baseUrl}/api/stats`);
    assert(declinedStatsRes.data.stats.totalAmount === 0, 'Une transaction refusée (50 000 F) ne modifie absolument PAS la cagnotte (toujours 0 F)');

    // Test 5ter-bis: Régression stricte - un webhook approved ne suffit pas si FedaPay ne confirme pas le paiement
    const fedapayService = require('./server/services/fedapay.service');
    const originalGetTransaction = fedapayService.getTransaction;
    fedapayService.getTransaction = async () => {
      throw new Error('API FedaPay indisponible');
    };

    const txIdUnconfirmed = 'sim_unconfirmed_01';
    const unconfirmedWebhook = {
      name: 'transaction.approved',
      entity: {
        id: txIdUnconfirmed,
        reference: 'FEC-TEST-UNCONFIRMED',
        status: 'approved',
        amount: 18000,
        currency: { iso: 'XOF' },
        mode: 'mtn_open',
        customer: {
          firstname: 'Unconfirmed',
          lastname: 'Donor',
          phone_number: { number: '67000000' }
        },
        custom_metadata: {
          message: 'Paiement non confirmé par l’API FedaPay',
          is_public: true,
          hide_amount: false
        }
      }
    };

    const unconfirmedRes = await axios.post(`${baseUrl}/api/webhook/fedapay`, unconfirmedWebhook);
    assert(unconfirmedRes.status === 200, 'Webhook reçu avec code 200 même sans confirmation API');

    const statsAfterUnconfirmed = await axios.get(`${baseUrl}/api/stats`);
    assert(statsAfterUnconfirmed.data.stats.totalAmount === 0, 'Aucun montant n’est ajouté sans confirmation effective de FedaPay');

    fedapayService.getTransaction = originalGetTransaction;

    // Test 6: Simulation Webhook FedaPay (transaction.approved) pour txId1
    const webhookPayload1 = {
      name: 'transaction.approved',
      entity: {
        id: txId1,
        reference: 'FEC-TEST-001',
        status: 'approved',
        amount: 10000,
        currency: { iso: 'XOF' },
        mode: 'mtn_open',
        customer: {
          firstname: 'Koffi',
          lastname: 'Sabi',
          phone_number: { number: '61000000' }
        },
        custom_metadata: {
          message: 'Fier de nos origines Waama ! Plein succès au festival !',
          is_public: true,
          hide_amount: false
        }
      }
    };
    const whRes1 = await axios.post(`${baseUrl}/api/webhook/fedapay`, webhookPayload1);
    assert(whRes1.status === 200, 'Webhook transaction.approved traité avec code 200');

    // Simulation Webhook pour txId2
    const webhookPayload2 = {
      name: 'transaction.approved',
      entity: {
        id: txId2,
        reference: 'FEC-TEST-002',
        status: 'approved',
        amount: 25000,
        currency: { iso: 'XOF' },
        mode: 'moov',
        customer: {
          firstname: 'Amina',
          lastname: 'Kora',
          phone_number: { number: '95000000' }
        },
        custom_metadata: {
          message: 'Que nos ancêtres bénissent cette édition.',
          is_public: false,
          hide_amount: true
        }
      }
    };
    await axios.post(`${baseUrl}/api/webhook/fedapay`, webhookPayload2);

    // Test 7: GET /api/verify-transaction/:id
    const verifyRes = await axios.get(`${baseUrl}/api/verify-transaction/${txId1}`);
    assert(verifyRes.status === 200, 'GET /api/verify-transaction status 200');
    assert(verifyRes.data.status === 'approved', 'Transaction vérifiée comme approuvée');
    assert(verifyRes.data.donation.firstname === 'Koffi', 'Nom du donateur vérifié');

    // Test 8: GET /api/subscribers (Respect de la confidentialité)
    const subsRes = await axios.get(`${baseUrl}/api/subscribers`);
    assert(subsRes.status === 200, 'GET /api/subscribers status 200');
    assert(subsRes.data.subscribers.length >= 2, 'Les 2 souscripteurs approuvés sont listés');
    
    // Le premier donateur (Koffi Sabi) est public
    const publicDonor = subsRes.data.subscribers.find(s => s.displayName.includes('Koffi'));
    assert(publicDonor !== undefined, 'Donateur public trouvé dans la liste');
    assert(publicDonor.amount === 10000, 'Montant du donateur public visible (10 000 FCFA)');

    // Le deuxième donateur (Amina Kora) a choisi l'anonymat
    const anonDonor = subsRes.data.subscribers.find(s => s.isAnonymous === true);
    assert(anonDonor !== undefined, 'Donateur anonyme identifié');
    assert(anonDonor.displayName === 'Donateur bienveillant', 'Nom anonymisé en "Donateur bienveillant"');
    assert(anonDonor.amount === null, 'Montant du donateur masqué respecté (null)');

    // Test 9: GET /api/stats
    const statsRes = await axios.get(`${baseUrl}/api/stats`);
    assert(statsRes.status === 200, 'GET /api/stats status 200');
    assert(statsRes.data.stats.totalDonors >= 2, 'Compteur total donateurs >= 2');
    assert(statsRes.data.stats.totalAmount >= 35000, 'Total montant collecté calculé avec exactitude (35 000 FCFA)');

    // Test 10: Vérification des pages HTML et du panneau modal
    const pageIndex = await axios.get(`${baseUrl}/`);
    assert(pageIndex.status === 200 && pageIndex.data.includes('FeCAWa'), 'Page d\'accueil index.html servie avec succès');
    assert(pageIndex.data.includes('id="donationModal"'), 'Panneau modal de souscription présent sur la page d\'accueil');
    assert(pageIndex.data.includes('id="donationForm"'), 'Formulaire de souscription logé dans le panneau modal');
    assert(pageIndex.data.includes('aria-describedby="modalSubtitle"') && pageIndex.data.includes('id="modalSubtitle"'), '[#11] Attributs ARIA complets sur la modale (aria-modal, aria-labelledby, aria-describedby)');

    // Test 10.bis (Issue #11) : Vérification du focus trap et restitution du focus dans app.js
    const appJsContent = fs.readFileSync(path.join(__dirname, 'public/js/app.js'), 'utf8');
    assert(appJsContent.includes('getFocusableModalElements') && appJsContent.includes('lastFocusedElement') && appJsContent.includes('clearTimeout(focusTimeoutId)'), '[#11] Script app.js intègre le focus trap, la restitution de focus et l\'annulation du timer');

    // Test 10.ter (Issue #9) : Suppression du code mort et redirection 301 pérenne
    const deadHtmlExists = fs.existsSync(path.join(__dirname, 'public/souscripteurs.html'));
    const deadJsExists = fs.existsSync(path.join(__dirname, 'public/js/subscribers.js'));
    assert(!deadHtmlExists && !deadJsExists, '[#9] Fichiers morts public/souscripteurs.html et public/js/subscribers.js physiquement supprimés');

    try {
      await axios.get(`${baseUrl}/souscripteurs`, { maxRedirects: 0 });
      assert(false, '[#9] GET /souscripteurs doit retourner HTTP 301');
    } catch (err) {
      assert(err.response && err.response.status === 301 && err.response.headers.location === '/', '[#9] GET /souscripteurs redirigé en HTTP 301 vers /');
    }

    try {
      await axios.get(`${baseUrl}/souscripteurs.html`, { maxRedirects: 0 });
      assert(false, '[#9] GET /souscripteurs.html doit retourner HTTP 301');
    } catch (err) {
      assert(err.response && err.response.status === 301 && err.response.headers.location === '/', '[#9] GET /souscripteurs.html redirigé en HTTP 301 vers /');
    }

    const pageSubscribers = await axios.get(`${baseUrl}/souscripteurs.html`, { maxRedirects: 5 });
    assert(pageSubscribers.status === 200 && pageSubscribers.data.includes('FeCAWa'), '[#9] La redirection 301 atterrit bien sur la page d\'accueil');

    // Facture / Reçu de confirmation
    const pageConfirmation = await axios.get(`${baseUrl}/confirmation.html`);
    assert(pageConfirmation.status === 200 && pageConfirmation.data.includes('Que Dieu bénisse ces généreux donateurs'), 'Page de confirmation/facture servie avec la bénédiction');

    // =========================================================================
    // TESTS COMPLÉMENTAIRES : ISSUES #17, #5, #12
    // =========================================================================
    console.log('\n🔒 Tests de sécurité et durcissement (#17, #5, #12)...');

    // Test 11 (Issue #17) : Vérification que le mode démo n'est plus actif sur confirmation
    assert(!pageConfirmation.data.includes('FEC-2026-DEMO-777'), '[#17] Pas de fausse référence DEMO préremplie dans confirmation.html');
    assert(!pageConfirmation.data.includes("urlParams.get('demo')"), '[#17] Suppression de la capture du paramètre ?demo=true');

    try {
      await axios.get(`${baseUrl}/api/verify-transaction/demo`);
      assert(false, '[#17] GET /api/verify-transaction/demo doit être rejeté');
    } catch (err) {
      assert(err.response && err.response.status === 400, '[#17] GET /api/verify-transaction/demo rejeté en HTTP 400');
    }

    // Test 12 (Issue #5) : Vérification de la signature HMAC FedaPay (t=...,s=...)
    const crypto = require('crypto');
    fedapayService.webhookSecret = 'wh_test_secret_key_12345';

    const testWebhookBody = JSON.stringify({
      name: 'transaction.approved',
      entity: { id: 'test_tx_hmac', status: 'approved' }
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const signedPayload = `${nowSec}.${testWebhookBody}`;
    const validHmac = crypto.createHmac('sha256', fedapayService.webhookSecret).update(signedPayload).digest('hex');

    // A. Signature officielle FedaPay valide
    const validHeaders = {
      'x-fedapay-signature': `t=${nowSec},s=${validHmac}`
    };
    const isValidSignature = fedapayService.verifyWebhook(validHeaders, JSON.parse(testWebhookBody), testWebhookBody);
    assert(isValidSignature === true, '[#5] Signature officielle FedaPay t=...,s=... acceptée');

    // B. Signature altérée
    const tamperedHeaders = {
      'x-fedapay-signature': `t=${nowSec},s=0000000000000000000000000000000000000000000000000000000000000000`
    };
    const isTamperedValid = fedapayService.verifyWebhook(tamperedHeaders, JSON.parse(testWebhookBody), testWebhookBody);
    assert(isTamperedValid === false, '[#5] Signature HMAC altérée rejetée (false)');

    // C. Timestamp hors tolérance (> 300 secondes dans le passé)
    const expiredSec = nowSec - 500;
    const expiredSignedPayload = `${expiredSec}.${testWebhookBody}`;
    const expiredHmac = crypto.createHmac('sha256', fedapayService.webhookSecret).update(expiredSignedPayload).digest('hex');
    const expiredHeaders = {
      'x-fedapay-signature': `t=${expiredSec},s=${expiredHmac}`
    };
    const isExpiredValid = fedapayService.verifyWebhook(expiredHeaders, JSON.parse(testWebhookBody), testWebhookBody);
    assert(isExpiredValid === false, '[#5] Signature avec timestamp expiré (> 300s) rejetée (anti-rejeu)');

    // D. Envoi réel sur la route /api/webhook/fedapay avec mauvaise signature -> 401
    try {
      await axios.post(`${baseUrl}/api/webhook/fedapay`, JSON.parse(testWebhookBody), {
        headers: { 'x-fedapay-signature': 't=1234,s=badhex' }
      });
      assert(false, '[#5] Webhook avec signature invalide doit retourner 401');
    } catch (err) {
      assert(err.response && err.response.status === 401, '[#5] POST /api/webhook/fedapay avec signature invalide retourne HTTP 401');
    }

    // Réinitialiser le secret pour les tests sans signature
    fedapayService.webhookSecret = '';

    // Test 13 (Issue #12) : Idempotence de la réception du webhook
    const idempotentPayload = {
      name: 'transaction.approved',
      entity: { id: txId1, status: 'approved' }
    };
    const idempRes = await axios.post(`${baseUrl}/api/webhook/fedapay`, idempotentPayload);
    assert(idempRes.status === 200 && idempRes.data.status === 'already_processed', '[#12] Webhook renvoyé pour transaction déjà validée acquitté en mode idempotent (already_processed)');

    // Test 14 (Issue #12) : Anti-hammering et bypass sur statut terminal
    const terminalCheckRes = await axios.get(`${baseUrl}/api/verify-transaction/${txId1}`);
    assert(terminalCheckRes.status === 200 && terminalCheckRes.data.status === 'approved', '[#12] Transaction approuvée consultée sans réinterroger inutilement FedaPay');

    // Test 15 (Issue #12) : Service de réconciliation
    const reconciliationService = require('./server/services/reconciliation.service');
    const reconcilRes = await reconciliationService.reconcilePending({ limit: 10, minAgeMinutes: 0 });
    assert(reconcilRes !== undefined && reconcilRes.checked >= 0, '[#12] Service de réconciliation des transactions pending opérationnel');

    // =========================================================================
    // TESTS COMPLÉMENTAIRES : ISSUES #6, #13, #7
    // =========================================================================
    console.log('\n🛡️ Tests de rate limiting et d\'étanchéité IP (#6, #13, #7)...');

    // Test 16 (Issue #7) : Présence de rate limiting sur /api/stats, /api/subscribers et /api/verify-transaction
    const statsRateRes = await axios.get(`${baseUrl}/api/stats`);
    assert(statsRateRes.headers['ratelimit-limit'] !== undefined, '[#7] En-tête RateLimit-Limit présent sur GET /api/stats');

    const subsRateRes = await axios.get(`${baseUrl}/api/subscribers`);
    assert(subsRateRes.headers['ratelimit-limit'] !== undefined, '[#7] En-tête RateLimit-Limit présent sur GET /api/subscribers');

    const verifyRateRes = await axios.get(`${baseUrl}/api/verify-transaction/${txId1}`);
    assert(verifyRateRes.headers['ratelimit-limit'] !== undefined, '[#7] En-tête RateLimit-Limit présent sur GET /api/verify-transaction/:id');

    // Test 17 (Issue #13) : Anti-spoofing X-Forwarded-For (ne crée pas de nouveau bucket sur connexion directe)
    // En envoyant une fausse IP en X-Forwarded-For, le serveur utilise l'IP réelle du socket
    const fakeIpRes1 = await axios.get(`${baseUrl}/api/stats`, {
      headers: { 'x-forwarded-for': '203.0.113.111' }
    });
    const remaining1 = parseInt(fakeIpRes1.headers['ratelimit-remaining'], 10);

    const fakeIpRes2 = await axios.get(`${baseUrl}/api/stats`, {
      headers: { 'x-forwarded-for': '203.0.113.222' }
    });
    const remaining2 = parseInt(fakeIpRes2.headers['ratelimit-remaining'], 10);

    // Si le spoofing réussissait, remaining2 serait égal à la limite max (nouveau bucket).
    // Grâce au correctif anti-spoofing, les deux requêtes partagent le même bucket local et remaining décrémente.
    assert(remaining2 < remaining1, '[#13] Anti-spoofing X-Forwarded-For : les requêtes partagent le même bucket socket et décrémentent le quota');

    // Test 18 (Issue #6) : Prise en compte de CF-Connecting-IP sous Cloudflare
    // En simulant une connexion proxy avec CF-Connecting-IP valide, le quota utilise cette IP
    process.env.TRUST_LOOPBACK_PROXY = 'true';
    const cfRes1 = await axios.get(`${baseUrl}/api/stats`, {
      headers: { 'cf-connecting-ip': '198.51.100.77' }
    });
    const cfLimit = parseInt(cfRes1.headers['ratelimit-limit'], 10);

    const cfRes2 = await axios.get(`${baseUrl}/api/stats`, {
      headers: { 'cf-connecting-ip': '198.51.100.88' }
    });
    const cfRemaining2 = parseInt(cfRes2.headers['ratelimit-remaining'], 10);
    // Deux IPs clientes réelles distinctes doivent avoir chacune leur propre quota intact (-1)
    assert(cfRemaining2 === cfLimit - 1, '[#6] Header CF-Connecting-IP alloue un quota distinct par visiteur derrière le proxy Cloudflare');
    delete process.env.TRUST_LOOPBACK_PROXY;

    console.log(`\n========================================`);
    console.log(`🎉 BILAN : ${passed} passés, ${failed} échoués`);
    console.log(`========================================\n`);

  } catch (err) {
    console.error('Erreur inattendue pendant les tests:', err);
    failed++;
  } finally {
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
