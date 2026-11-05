/**
 * Service d'alerte FeCAWa 2026 — canal Discord.
 *
 * But : qu'aucun encaissement ne puisse rester invisible. Le 2026-09-27, 2 000
 * FCFA approuvés chez FedaPay n'étaient pas comptabilisés, et personne n'a été
 * prévenu : le webhook était mort ET aucun mécanisme ne surveillait le canal.
 * Ce service est l'expéditeur ; la logique de décision vit dans
 * `watchdog.service.js`.
 *
 * Choix techniques :
 *   - Envoi par « webhook Discord » : une seule URL, aucun serveur SMTP, aucun
 *     bot à faire tourner, et l'alerte arrive en notification push sur le
 *     téléphone. Rien n'est stocké côté FedaPay ni ailleurs.
 *   - L'URL du webhook Discord EST un secret (elle permet d'écrire dans le
 *     salon) : elle n'est jamais journalisée, ni en cas de succès, ni en cas
 *     d'échec, ni dans le message d'erreur renvoyé par Discord.
 *   - Timeout court (8 s) et un seul essai : une alerte n'est pas une
 *     transaction, elle ne doit jamais retarder un cycle ni s'empiler.
 *   - Sans URL configurée, le service fonctionne en SECO : l'alerte est
 *     journalisée dans les logs avec un marqueur explicite. Un tableau de bord
 *     muet est infiniment préférable à une exception non gérée.
 */

const axios = require('axios');

/** Marqueur reconnaissable dans les logs : facilite le grep en exploitation. */
const ALERT_TAG = '[Alerte]';

class AlertService {
  constructor() {
    this.webhookUrl = (process.env.ALERT_DISCORD_WEBHOOK_URL || '').trim();
    this.timeout = 8000;
    // Anti-spam : une même clé ne peut être renvoyée qu'une fois par période.
    // Un watchdog qui tourne toutes les 10 min ne doit pas remplir un salon
    // Discord de 144 messages identiques par jour.
    this.cooldowns = new Map();
  }

  /**
   * L'URL du webhook est-elle exploitable ?
   * Une URL manifestement fausse est rejetée ici plutôt que d'envoyer une
   * requête qui échouerait à chaque cycle.
   * @returns {boolean}
   */
  isConfigured() {
    if (!this.webhookUrl) return false;
    try {
      const url = new URL(this.webhookUrl);
      return url.protocol === 'https:' && /(^|\.)discord(app)?\.com$/.test(url.hostname);
    } catch {
      return false;
    }
  }

  /**
   * URL du webhook expurgée, pour les journaux : on ne montre que le nom du
   * salon cible, jamais la clé qui permet d'écrire dedans.
   * @returns {string}
   */
  describeTarget() {
    if (!this.isConfigured()) return 'aucun (mode sec)';
    try {
      const url = new URL(this.webhookUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[parts.length - 2] || '?';
      const token = parts[parts.length - 1] || '';
      return `discord salon#${id} (clé …${token.slice(-4)})`;
    } catch {
      return 'discord (URL illisible)';
    }
  }

  /**
   * Une clé est-elle encore sous cooldown ?
   * @param {string} key
   * @param {number} [now]
   * @returns {boolean}
   */
  isUnderCooldown(key, now = Date.now()) {
    if (!key) return false;
    const until = this.cooldowns.get(key);
    return typeof until === 'number' && until > now;
  }

  /**
   * Ouvre (ou referme) le cooldown d'une clé.
   * @param {string} key
   * @param {number} durationMinutes 0 = refermer immédiatement
   */
  markSent(key, durationMinutes = 0) {
    if (!key) return;
    const minutes = parseFloat(durationMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      this.cooldowns.delete(key);
      return;
    }
    this.cooldowns.set(key, Date.now() + minutes * 60000);
  }

  /**
   * Envoie une alerte.
   *
   * @param {Object} alert
   * @param {string} alert.title        Titre court, ex. « Paiement non comptabilisé »
   * @param {string} [alert.description] Texte libre (2 premières lignes Discord)
   * @param {string} [alert.severity]   'critical' | 'warning' | 'info' | 'success'
   * @param {Array<{name: string, value: string, inline?: boolean}>} [alert.fields]
   * @param {string} [alert.key]        Clé de cooldown (recommandé)
   * @param {number} [alert.cooldownMinutes] Anti-spam, défaut 360
   * @returns {Promise<{ sent: boolean, skipped?: boolean, reason?: string }>}
   */
  async send({ title, description = '', severity = 'warning', fields = [], key = null, cooldownMinutes = 360 }) {
    if (!title) return { sent: false, reason: 'titre manquant' };

    if (key && this.isUnderCooldown(key)) {
      return { sent: false, skipped: true, reason: 'déjà alerté (cooldown)' };
    }

    // Couleurs Discord (décimales) : rouge, orange, bleu, vert.
    const colors = { critical: 0xd32f2f, warning: 0xef6c00, info: 0x1976d2, success: 0x2e7d32 };
    const emoji = { critical: '🚨', warning: '⚠️', info: 'ℹ️', success: '✅' };
    const level = colors[severity] !== undefined ? severity : 'warning';

    const embed = {
      title: `${emoji[level]} ${title}`.slice(0, 256),
      color: colors[level],
      timestamp: new Date().toISOString(),
      footer: { text: 'FeCAWa 2026 — surveillance de la cagnotte' },
      fields: []
    };

    if (description) {
      // Discord n'affiche que les 2 4096 premiers caractères d'une embed.
      embed.description = String(description).slice(0, 2000);
    }

    for (const field of fields.slice(0, 25)) {
      if (!field || !field.name) continue;
      embed.fields.push({
        name: String(field.name).slice(0, 256),
        // 1024 caractères max par field, valeur obligatoire.
        value: String(field.value === undefined || field.value === null ? '-' : field.value).slice(0, 1024) || '-',
        inline: Boolean(field.inline)
      });
    }
    if (embed.fields.length === 0) delete embed.fields;

    const payload = {
      username: 'FeCAWa Surveillance',
      embeds: [embed],
      // Pas de mention @everyone par défaut : une alerte de routine ne doit pas
      // notifier toute l'équipe. Le watchdog ne l'active que pour 'critical'.
      allowed_mentions: { parse: [] }
    };

    if (!this.isConfigured()) {
      const lines = [
        `${ALERT_TAG} ${emoji[level]} ${title}`,
        description ? String(description).split('\n').slice(0, 3).join(' ') : null,
        ...fields.slice(0, 6).map((f) => `   • ${f.name} : ${f.value}`)
      ].filter(Boolean);
      console.warn(lines.join('\n'));
      console.warn(`${ALERT_TAG} Mode sec : ALERT_DISCORD_WEBHOOK_URL n'est pas configurée, l'alerte n'est PAS partie sur Discord.`);
      // Le cooldown est malgré même posé : sans canal, inutile de répéter la
      // même ligne 144 fois par jour dans les logs.
      this.markSent(key, cooldownMinutes);
      return { sent: false, reason: 'canal non configuré' };
    }

    try {
      const response = await axios.post(this.webhookUrl, payload, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' },
        // Ne suit aucune redirection : une URL de webhook ne redirige jamais,
        // et unfollowed redirect pourrait exposer la clé vers un tiers.
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 300
      });
      // Discord répond 204 en cas de succès. `response` n'est volontairement pas
      // journalisé : il peut contenir des détails d'URL.
      void response;
      this.markSent(key, cooldownMinutes);
      console.log(`${ALERT_TAG} Alerte envoyée sur Discord : « ${title} » (${this.describeTarget()})`);
      return { sent: true };
    } catch (error) {
      // Le message d'erreur axios peut contenir l'URL : on ne le journalise pas
      // tel quel, seulement le code HTTP et le motif.
      const status = error.response?.status || 'n/a';
      const motif = error.code || error.name || 'erreur inconnue';
      console.error(`${ALERT_TAG} Échec de l'envoi de l'alerte « ${title} » vers ${this.describeTarget()} : HTTP ${status} (${motif}).`);
      // Pas de cooldown en cas d'échec : la prochaine cycle réessaiera, ce qui
      // est le bon comportement (l'alerte est alors peut-être réellement urgente).
      return { sent: false, reason: `échec d'envoi (HTTP ${status})` };
    }
  }
}

module.exports = new AlertService();
module.exports.ALERT_TAG = ALERT_TAG;
