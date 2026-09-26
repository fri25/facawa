/**
 * Configuration et accès à la base de données SQLite pour FeCAWa 2026.
 * Utilise le module natif node:sqlite avec initialisation automatique des tables et index.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Chemin vers la base de données
const dbFilePath = process.env.DB_FILE || path.join(__dirname, '../../data/fecawa.db');
const dbDir = path.dirname(dbFilePath);

// S'assurer que le dossier parent existe
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialisation de la connexion SQLite
const db = new DatabaseSync(dbFilePath);

// Activer le mode WAL pour de meilleures performances concurrentes
try {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
} catch (err) {
  console.warn('[DB] Avertissement configuration pragma:', err.message);
}

// Initialisation du schéma de la base
function initSchema() {
  const schemaSql = `
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT UNIQUE,
      reference TEXT,
      firstname TEXT NOT NULL,
      lastname TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'XOF',
      message TEXT,
      is_public INTEGER DEFAULT 1,
      hide_amount INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      payment_method TEXT,
      feda_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
    CREATE INDEX IF NOT EXISTS idx_donations_created_at ON donations(created_at);
    CREATE INDEX IF NOT EXISTS idx_donations_transaction_id ON donations(transaction_id);
  `;

  db.exec(schemaSql);
  console.log('[DB] Schéma SQLite initialisé avec succès.');
}

// -----------------------------------------------------------------------------
// Migrations idempotentes
// -----------------------------------------------------------------------------
// `CREATE TABLE IF NOT EXISTS` ne fait RIEN sur une table déjà existante : sans
// cette étape, une colonne ajoutée au schéma n'atteindrait jamais les bases
// déjà déployées. ALTER TABLE n'est donc appliqué que si la colonne manque.
function runMigrations() {
  const migrations = [
    // Jeton de reçu : preuve de propriété d'une transaction. Sans lui,
    // n'importe qui pouvait énumérer les ID de transaction (entiers
    // séquentiels) et lire nom, montant, référence et message des donateurs —
    // y compris ceux dont le paiement a expiré et qui n'apparaissent donc
    // dans aucune liste publique. Colonnes utilisées :
    //   receipt_token_hash : SHA-256 du jeton (le jeton en clair n'est jamais stocké)
    //   receipt_token_issued_at : horodatage d'émission
    // `name` DOIT être le nom exact de la colonne ajoutée par `sql` : c'est
    // lui que la détection d'idempotence compare à PRAGMA table_info.
    {
      name: 'receipt_token_hash',
      sql: 'ALTER TABLE donations ADD COLUMN receipt_token_hash TEXT'
    },
    {
      name: 'receipt_token_issued_at',
      sql: 'ALTER TABLE donations ADD COLUMN receipt_token_issued_at DATETIME'
    }
  ];

  for (const migration of migrations) {
    const column = migration.name;
    // `PRAGMA table_info` via prepare() est le seul moyen fiable avec
    // node:sqlite : la forme table-valued `pragma_table_info('donations')`
    // n'est pas supportée et renvoyait zéro ligne, ce qui faisait rejouer
    // l'ALTER TABLE sur une colonne déjà existante.
    const columns = db.prepare('PRAGMA table_info(donations)').all();
    if (columns.some((c) => c.name === column)) continue;
    try {
      db.exec(migration.sql);
      console.log(`[DB] Migration appliquée : ${column}`);
    } catch (err) {
      console.error(`[DB] Échec de la migration ${column} :`, err.message);
    }
  }
}

// Exécuter l'initialisation au chargement
initSchema();
runMigrations();

/**
 * Génère un jeton de reçu aléatoire et son empreinte stockable.
 * 32 octets aléatoires → 64 caractères hexadécimaux, impossibles à deviner.
 * Seul le SHA-256 est persisté : une fuite de la base ne donne pas les jetons
 * exploitables (ils ne sont de toute façon valables que pour le don concerné).
 *
 * @returns {{ token: string, hash: string }}
 */
function issueReceiptToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashReceiptToken(token) };
}

/**
 * Empreinte SHA-256 d'un jeton de reçu, en temps constant côté comparaison.
 * @param {string} token
 * @returns {string} hexadécimal 64 caractères
 */
function hashReceiptToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Comparaison à temps constant de deux empreintes de jeton.
 * @returns {boolean}
 */
function safeCompareHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a.toLowerCase(), 'utf8');
  const bufB = Buffer.from(b.toLowerCase(), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}


// Couche d'accès aux données (DAO / Repository)
const DonationRepository = {
  /**
   * Enregistre une souscription initiale en attente de paiement
   */
  createPendingDonation(data) {
    const {
      transactionId,
      reference = null,
      firstname,
      lastname,
      phone,
      email = null,
      amount,
      currency = 'XOF',
      message = null,
      isPublic = 1,
      hideAmount = 0,
      fedaToken = null
    } = data;

    // Preuve de propriété de la transaction : le jeton en clair est renvoyé au
    // donateur (et à lui seul), seule son empreinte est persistée.
    const { token, hash } = issueReceiptToken();

    const stmt = db.prepare(`
      INSERT INTO donations (
        transaction_id, reference, firstname, lastname, phone, email,
        amount, currency, message, is_public, hide_amount, status,
        payment_method, feda_token, receipt_token_hash, receipt_token_issued_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, ?, ?, datetime('now'), datetime('now'), datetime('now'))
    `);

    const result = stmt.run(
      transactionId ? String(transactionId) : null,
      reference,
      firstname.trim(),
      lastname.trim(),
      phone.trim(),
      email ? email.trim() : null,
      parseInt(amount, 10),
      currency,
      message ? message.trim() : null,
      isPublic ? 1 : 0,
      hideAmount ? 1 : 0,
      fedaToken,
      hash
    );

    return { donation: this.getById(result.lastInsertRowid), receiptToken: token };
  },

  /**
   * Récupère une souscription par son ID de transaction FedaPay
   */
  getByTransactionId(transactionId) {
    if (!transactionId) return null;
    const stmt = db.prepare('SELECT * FROM donations WHERE transaction_id = ?');
    return stmt.get(String(transactionId));
  },

  /**
   * Vérifie qu'un jeton de reçu correspond bien à la transaction demandée.
   * Comparaison en temps constant sur les empreintes SHA-256.
   *
   * @param {string|number} transactionId
   * @param {string} token Jeton en clair présenté par le client
   * @returns {boolean}
   */
  ownsTransaction(transactionId, token) {
    if (!transactionId || typeof token !== 'string' || !token) return false;
    const donation = this.getByTransactionId(transactionId);
    if (!donation || !donation.receipt_token_hash) return false;
    return safeCompareHash(donation.receipt_token_hash, hashReceiptToken(token));
  },

  /**
   * Associe (ou régénère) le jeton de reçu d'une transaction créée hors de
   * l'application (ex: import,_slack webhook antérieur au déploiement).
   * @returns {string} jeton en clair
   */
  ensureReceiptToken(transactionId) {
    const existing = this.getByTransactionId(transactionId);
    if (existing && existing.receipt_token_hash) {
      // Un jeton existe déjà mais le donataire ne l'a jamais reçu : on ne peut
      // pas le lui retransmettre (seule l'empreinte est stockée). On n'en
      // fabrique pas de nouveau ici — l'absence de jeton reste gérable.
      return null;
    }
    const { token, hash } = issueReceiptToken();
    const stmt = db.prepare(`
      UPDATE donations
      SET receipt_token_hash = ?, receipt_token_issued_at = datetime('now')
      WHERE transaction_id = ?
    `);
    stmt.run(hash, String(transactionId));
    return token;
  },


  /**
   * Récupère une souscription par son ID interne
   */
  getById(id) {
    const stmt = db.prepare('SELECT * FROM donations WHERE id = ?');
    return stmt.get(id);
  },

  /**
   * Récupère une souscription par son ID de transaction FedaPay
   */
  getByTransactionId(transactionId) {
    if (!transactionId) return null;
    const stmt = db.prepare('SELECT * FROM donations WHERE transaction_id = ?');
    return stmt.get(String(transactionId));
  },

  /**
   * Met à jour le statut d'une transaction (ex: approved, declined, canceled)
   */
  updateStatus(transactionId, status, paymentMethod = null) {
    const stmt = db.prepare(`
      UPDATE donations 
      SET status = ?, 
          payment_method = COALESCE(?, payment_method),
          updated_at = datetime('now')
      WHERE transaction_id = ?
    `);

    stmt.run(status, paymentMethod, String(transactionId));
    return this.getByTransactionId(transactionId);
  },

  /**
   * Enregistre ou met à jour une donation confirmée par Webhook
   */
  upsertApprovedFromWebhook(data) {
    const existing = this.getByTransactionId(data.transactionId);
    if (existing) {
      return this.updateStatus(data.transactionId, 'approved', data.paymentMethod);
    }

    // Si la transaction n'avait pas été préalablement créée en local
    const stmt = db.prepare(`
      INSERT INTO donations (
        transaction_id, reference, firstname, lastname, phone, email,
        amount, currency, message, is_public, hide_amount, status,
        payment_method, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'), datetime('now'))
    `);

    const result = stmt.run(
      String(data.transactionId),
      data.reference || null,
      data.firstname || 'Généreux',
      data.lastname || 'Donateur',
      data.phone || '',
      data.email || null,
      parseInt(data.amount, 10) || 0,
      data.currency || 'XOF',
      data.message || null,
      data.isPublic !== undefined ? (data.isPublic ? 1 : 0) : 1,
      data.hideAmount !== undefined ? (data.hideAmount ? 1 : 0) : 0,
      data.paymentMethod || null
    );

    return this.getById(result.lastInsertRowid);
  },

  /**
   * Liste publique des souscripteurs (approuvés uniquement, triés du plus récent au plus ancien)
   */
  getPublicSubscribers({ limit = 50, offset = 0, search = '' } = {}) {
    let sql = `
      SELECT 
        id, 
        firstname, 
        lastname, 
        amount, 
        currency, 
        message, 
        is_public, 
        hide_amount, 
        created_at
      FROM donations
      WHERE status = 'approved'
    `;

    const params = [];

    if (search && search.trim().length > 0) {
      sql += ` AND (firstname LIKE ? OR lastname LIKE ? OR message LIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);

    // Formatage des données en respectant la vie privée et les préférences de confidentialité
    return rows.map(row => {
      const isPublic = Boolean(row.is_public);
      const hideAmount = Boolean(row.hide_amount);

      return {
        id: row.id,
        displayName: isPublic 
          ? `${row.firstname} ${row.lastname.charAt(0)}.` 
          : 'Donateur bienveillant',
        fullName: isPublic ? `${row.firstname} ${row.lastname}` : 'Anonyme',
        isAnonymous: !isPublic,
        amount: hideAmount ? null : row.amount,
        currency: row.currency,
        hideAmount: hideAmount,
        message: row.message,
        date: row.created_at
      };
    });
  },

  /**
   * Statistiques globales des souscriptions
   */
  getStats() {
    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(amount), 0) as totalAmount,
        COALESCE(MAX(amount), 0) as maxDonation
      FROM donations 
      WHERE status = 'approved'
    `);
    
    const stats = stmt.get() || { count: 0, totalAmount: 0, maxDonation: 0 };

    // Derniers souscripteurs récents (24h)
    const recentStmt = db.prepare(`
      SELECT COUNT(*) as recentCount 
      FROM donations 
      WHERE status = 'approved' 
        AND created_at >= datetime('now', '-1 day')
    `);
    const recent = recentStmt.get() || { recentCount: 0 };

    return {
      totalDonors: Number(stats.count),
      totalAmount: Number(stats.totalAmount),
      maxDonation: Number(stats.maxDonation),
      recentDonors24h: Number(recent.recentCount),
      currency: 'XOF'
    };
  },

  /**
   * Récupère les transactions en attente récentes pour réconciliation
   * @param {Object} options
   * @param {number} options.limit Nombre max d'enregistrements (défaut 50)
   * @param {number} options.minAgeMinutes Âge minimal en minutes (défaut 2 min)
   * @param {number} options.maxAgeHours Âge maximal en heures (défaut 24 h)
   */
  getPendingDonations({ limit = 50, minAgeMinutes = 2, maxAgeHours = 24 } = {}) {
    const stmt = db.prepare(`
      SELECT * FROM donations 
      WHERE status = 'pending'
        AND transaction_id IS NOT NULL
        AND created_at <= datetime('now', '-' || ? || ' minutes')
        AND created_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY created_at ASC
      LIMIT ?
    `);
    return stmt.all(minAgeMinutes, maxAgeHours, limit);
  }
};

module.exports = {
  db,
  DonationRepository,
  issueReceiptToken,
  hashReceiptToken,
  safeCompareHash
};
