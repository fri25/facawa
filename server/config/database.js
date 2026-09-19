/**
 * Configuration et accès à la base de données SQLite pour FeCAWa 2026.
 * Utilise le module natif node:sqlite avec initialisation automatique des tables et index.
 */

const fs = require('fs');
const path = require('path');
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

// Exécuter l'initialisation au chargement
initSchema();

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

    const stmt = db.prepare(`
      INSERT INTO donations (
        transaction_id, reference, firstname, lastname, phone, email,
        amount, currency, message, is_public, hide_amount, status,
        payment_method, feda_token, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, ?, datetime('now'), datetime('now'))
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
      fedaToken
    );

    return this.getById(result.lastInsertRowid);
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
  }
};

module.exports = {
  db,
  DonationRepository
};
