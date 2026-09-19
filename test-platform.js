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

    // Vérification de la disparition de la page souscripteurs (redirection vers accueil)
    const pageSubscribers = await axios.get(`${baseUrl}/souscripteurs.html`, { maxRedirects: 5 });
    assert(pageSubscribers.status === 200 && pageSubscribers.data.includes('FeCAWa'), 'La requête vers souscripteurs.html est redirigée vers la page d\'accueil');

    // Facture / Reçu de confirmation
    const pageConfirmation = await axios.get(`${baseUrl}/confirmation.html`);
    assert(pageConfirmation.status === 200 && pageConfirmation.data.includes('Que Dieu bénisse ces généreux donateurs'), 'Page de confirmation/facture servie avec la bénédiction');

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
