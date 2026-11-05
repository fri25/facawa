/**
 * Contrôleur d'export CSV FeCAWa 2026.
 *
 * Produit le relevé COMPLET des souscriptions : tous les statuts (encaissés,
 * expirés, refusés, en attente), avec les coordonnées des donateurs. C'est la
 * vue « organisation » — celle qui sert à rapprocher les encaissements du
 * dashboard FedaPay et à émettre les reçus. Elle est donc strictement
 * confidentielle (PII : nom, prénom, téléphone, e-mail, message) et n'a rien à
 * faire avec la liste publique des donateurs.
 *
 * Protection (3 couches) :
 *   1. un jeton secret compares en temps constant (X-Export-Token) ;
 *   2. le rate-limit de l'endpoint, pour rendre le devinette de jeton
 *      impraticable même s'il essayait ;
 *   3. le routeur Traefik du site, qui n'accepte que les requêtes passant par
 *      Cloudflare (les autres conteneurs du réseau partagé sont de toute façon
 *      bloqués par `fecawa-gate`).
 *
 * Le jeton n'est JAMAIS accepté en paramètre d'URL : il n'irait ni dans les
 * logs d'accès, ni dans l'historique du navigateur, ni dans un en-tête Referer.
 * La page /export.html le place dans un en-tête et déclenche un téléchargement.
 */

const crypto = require('crypto');
const { DonationRepository } = require('../config/database');

/**
 * Compare deux jetons en temps constant.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // On compare quand même deux valeurs de même longueur pour ne pas révéler
    // la longueur du secret par un retour anticipé.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Échappe une valeur pour un fichier CSV.
 *
 * Le séparateur est le POINT-VIRGULE : c'est le séparateur attendu par Excel et
 * LibreOffice en locale française, où la virgule décimale rendrait le CSV
 * ambigu. Le BOM UTF-8 placé en tête de fichier force Excel à ouvrir le fichier
 * en UTF-8 (sans lui, les accents des noms de donateurs deviennent illisibles).
 *
 * @param {*} value
 * @returns {string}
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // Neutralise les séparateurs, les guillemets et les retours à la ligne.
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Construit le relevé complet.
 * @param {Array<Object>} rows
 * @returns {string} contenu CSV (avec BOM UTF-8)
 */
function buildCsv(rows) {
  const headers = [
    'id',
    'transaction_id',
    'reference',
    'date_creation',
    'statut',
    'montant',
    'devise',
    'nom',
    'prenom',
    'telephone',
    'email',
    'message',
    'don_public',
    'montant_masque',
    'moyen_paiement',
    'date_mise_a_jour'
  ];

  const lines = [headers.join(';')];
  for (const row of rows) {
    lines.push([
      row.id,
      row.transaction_id,
      row.reference,
      row.created_at,
      row.status,
      row.amount,
      row.currency,
      row.lastname,
      row.firstname,
      row.phone,
      row.email,
      row.message,
      row.is_public ? 'oui' : 'non',
      row.hide_amount ? 'oui' : 'non',
      row.payment_method,
      row.updated_at
    ].map(csvCell).join(';'));
  }

  // '\uFEFF' = BOM UTF-8 pour Excel.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Longueur minimale du jeton d'export. 32 caractères = 128 bits d'entropie si
 *  le jeton a été généré par `openssl rand -hex 24` (48 caractères). En dessous,
 *  l'export serait protégé par un secret devinable, ce qui n'est pas une
 *  protection. Le contrôle est fait à CHAQUE requête, pas seulement au
 *  déploiement : une variable affaiblie par erreur plus tard ne doit pas ouvrir
 *  l'endpoint. */
const MIN_TOKEN_LENGTH = 32;

const ExportController = {
  /**
   * GET /api/admin/export.csv
   * En-tête requis : X-Export-Token: <FECAWAY_EXPORT_TOKEN>
   */
  async exportCsv(req, res) {
    const configuredToken = (process.env.FECAWAY_EXPORT_TOKEN || '').trim();

    // Secret non configuré : l'export est FERME. Mieux vaut un 503 explicite
    // qu'un endpoint ouvert parce qu'une variable d'environnement a été
    // oubliée — c'est le genre d'oubli qui ne se voit qu'au moment de subir.
    if (!configuredToken) {
      console.error('[Export] Requête refusée : FECAWAY_EXPORT_TOKEN n\'est pas configurée.');
      return res.status(503).json({
        success: false,
        message: 'Export désactivé : aucun jeton d\'export n\'est configuré sur le serveur.'
      });
    }

    // Jeton présent mais trop court : on REFUSE de servir plutôt que d'accepter
    // un secret faible. Message volontairement identique au cas « non
    // configuré » : l'appelant n'apprend rien de la configuration du serveur.
    if (configuredToken.length < MIN_TOKEN_LENGTH) {
      console.error(`[Export] Requête refusée : FECAWAY_EXPORT_TOKEN fait ${configuredToken.length} caractères, minimum ${MIN_TOKEN_LENGTH}. Régénère-la avec « openssl rand -hex 24 ».`);
      return res.status(503).json({
        success: false,
        message: 'Export désactivé : le jeton configuré est trop court.'
      });
    }

    const presented = req.get('x-export-token') || '';
    if (!safeCompare(presented, configuredToken)) {
      // Aucun détail sur la raison : ni « jeton manquant » ni « jeton faux »
      // ne sont distingués, pour ne pas aider à l'énumération.
      console.warn(`[Export] Export refusé : jeton absent ou invalide (IP ${req.ip || 'inconnue'}).`);
      return res.status(401).json({ success: false, message: 'Jeton d\'export invalide.' });
    }

    try {
      // `getAllDonations` n'expose QUE les champs du relevé : ni feda_token,
      // ni empreinte du jeton de reçu, ni rien d'autre.
      const rows = DonationRepository.getAllDonations();
      const csv = buildCsv(rows);

      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="fecawa-souscriptions-${stamp}.csv"`);
      // Un export contient des PII : il ne doit jamais finir dans un cache
      // partagé ni dans un navigateur tiers.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const totalApproved = rows.filter((r) => r.status === 'approved');
      const collected = totalApproved.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
      console.log(`[Export] Export servi : ${rows.length} ligne(s), ${totalApproved.length} encaissée(s), ${collected} FCFA.`);

      return res.status(200).send(csv);
    } catch (error) {
      console.error('[Export] Erreur lors de la génération du CSV:', error.message);
      return res.status(500).json({ success: false, message: 'Impossible de générer l\'export.' });
    }
  },

  // Exposé pour les tests unitaires.
  _internals: { buildCsv, csvCell, safeCompare }
};

module.exports = ExportController;
