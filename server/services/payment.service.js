/**
 * Façade de paiement FeCAWa 2026.
 *
 * Choisit le fournisseur actif selon PAYMENT_PROVIDER (défaut : fedapay) et
 * expose EXACTEMENT le même contrat d'interface pour les deux :
 *   - createTransaction({ amount, description, customer, customMetadata, callbackUrl })
 *   - getTransaction(id)
 *   - verifyWebhook(headers, body, rawBody)
 *
 * Le reste du code ne connaît que cette façade : passer de FedaPay à Moneroo
 * (ou l'inverse) est un simple changement de variable d'environnement.
 */

const key = String(process.env.PAYMENT_PROVIDER || 'fedapay').toLowerCase();
const registry = {
  fedapay: require('./fedapay.service'),
  moneroo: require('./moneroo.service')
};
const active = registry[key] || registry.fedapay;
if (!registry[key]) {
  console.warn(`[Payment] Provider "${key}" inconnu → repli sur fedapay.`);
}

module.exports = {
  name: registry[key] ? key : 'fedapay',
  // Résout le service d'un fournisseur donné (pour vérifier une transaction
  // chez CELUI QUI L'A CRÉÉE, et non le fournisseur globalement actif).
  getProvider: (n) => registry[String(n || 'fedapay').toLowerCase()] || registry.fedapay,
  createTransaction: (...a) => active.createTransaction(...a),
  getTransaction: (...a) => active.getTransaction(...a),
  verifyWebhook: (...a) => active.verifyWebhook(...a)
};
