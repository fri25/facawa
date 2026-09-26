/**
 * Résolution anti-usurpation de l'adresse IP cliente.
 *
 * Contexte (vulnérabilité corrigée le 2026-09-26, CWE-290) :
 * la version précédente lisait `CF-Connecting-IP` puis `X-Forwarded-For` en
 * donnant la PRIORITÉ ABSOLUE à la première IP publique trouvée. Ces en-têtes
 * étant choisis par le client, n'importe qui pouvait forger une IP arbitraire
 * et neutraliser les 4 rate-limiters de l'API (test : 70 requêtes forgées,
 * 0 réponse 429). Le site étant également joignable sur son IP d'origine
 * (80/443 ouverts), l'attaque était exploitable à distance.
 *
 * Principe retenu : on ne fait confiance qu'aux en-têtes que le proxy a
 * AJOUTÉS (donc en fin de chaîne), jamais à ceux que le client a pu
 * PRÉFIXER en tête de chaîne.
 *
 * Deux cas, selon la présence d'une IP Cloudflare dans la chaîne :
 *
 *  1. Requête passée par Cloudflare (cas nominal) :
 *     Cloudflare ajoute l'IP du vrai client puis son propre IP ; Traefik
 *     ajoute ensuite celle de Cloudflare. Le client peut préfixer des IP
 *     arbitraires, elles sont donc ignorées : on prend `CF-Connecting-IP`
 *     (valeur réécrite par Cloudflare), ou à défaut l'entrée située juste
 *     avant la dernière IP Cloudflare de la chaîne.
 *
 *  2. Requête directe sur l'origine (Cloudflare contourné) ou via un proxy
 *     non-Cloudflare : aucune IP Cloudflare dans la chaîne. Traefik a
 *     *ajouté* l'adresse TCP réelle en dernière position : c'est donc la
 *     seule entrée fiable, et elle est située au bout de la chaîne.
 *     Les entrées préfixées par l'attaquant sont ignorées.
 *
 * En cas d'IP Cloudflare inconnue (plages non encore à jour), on retombe sur
 * le cas 2 : le limiteur devient plus strict pour les visiteurs concernés mais
 * ne peut pas être contourné. Le repli est donc sûr (fail-safe, pas fail-open).
 */

// Plages IP Cloudflare publiées sur https://www.cloudflare.com/ips-v4 et
// https://www.cloudflare.com/ips-v6.
//
// SOURCE UNIQUE DE VÉRITÉ : la variable d'environnement
// `CLOUDFLARE_IP_RANGES` (liste séparée par des virgules) est prioritaire. Elle
// alimente AUSSI le middleware Traefik `ipwhitelist` qui n'accepte que
// Cloudflare sur les routeurs de production. C'est volontaire : si les deux
// listes divergeaient, le limiteur de l'application et celui du proxy
// s'autoriseraient mutuellement, et la protection dépendrait de la moins à
// jour des deux. La liste ci-dessous n'est donc qu'un repli, à garder
// synchronisée, jamais la référence.
//
// RAFRAÎCHIR : `curl -s https://www.cloudflare.com/ips-v4` et
// `curl -s https://www.cloudflare.com/ips-v6`, puis mettre à jour la variable
// dans .env ET CLOUDFLARE_RANGES ci-dessous.
const CLOUDFLARE_RANGES = Object.freeze([
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  // IPv6
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
]);

function configuredRanges() {
  const raw = process.env.CLOUDFLARE_IP_RANGES;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => /^[0-9a-f.:/]+$/i.test(entry));
    if (parsed.length > 0) return Object.freeze(parsed);
  }
  // Repli sur la liste embarquée. En production c'est un défaut de
  // configuration, pas un choix : les deux listes doivent être identiques, et
  // Traefik n'applique de toute façon que CLOUDFLARE_IP_RANGES. On le dit.
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[proxy] CLOUDFLARE_IP_RANGES absente : repli sur la liste embarquée, ' +
      'qui peut être périmée. Renseigner la variable (voir .env.example).'
    );
  }
  return CLOUDFLARE_RANGES;
}


const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  const trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return normalizeIp(trimmed.slice(1, -1));
  }
  return trimmed.replace(/^::ffff:/, '');
}

/**
 * Convertit une IP en tableau de bits, pour IPv4 comme pour IPv6 (forme
 * compressée et IPv4 embarquée incluses). Retourne null si l'adresse est
 * inexploitable.
 *
 * @param {string} ip
 * @returns {number[]|null}
 */
function ipToBits(ip) {
  const clean = normalizeIp(ip);
  if (IPV4_RE.test(clean)) {
    const parts = clean.split('.').map(Number);
    if (parts.some((n) => n > 255)) return null;
    return parts.flatMap((n) => [n >> 4, n & 0x0f]);
  }
  if (!clean.includes(':') || !/^[0-9a-f:.]+$/.test(clean)) return null;

  // IPv4 embarquée en fin d'adresse (ex: ::ffff:1.2.3.4 déjà normalisée, ou
  // ::1.2.3.4) : on convertit la partie décimale en deux groupes.
  let text = clean;
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (embedded) {
    const parts = embedded[1].split('.').map(Number);
    if (parts.some((n) => n > 255)) return null;
    const g1 = ((parts[0] << 8) | parts[1]).toString(16);
    const g2 = ((parts[2] << 8) | parts[3]).toString(16);
    text = text.slice(0, -embedded[1].length) + `${g1}:${g2}`;
  }

  const [head, tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  if (head === '' && tail === '') return null;

  let groups;
  if (text.includes('::')) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) return null;
    groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  } else {
    groups = headGroups;
  }
  // Une base CIDR peut être écrite sans `::` (ex: `2400:cb00::/32`) : on la
  // complète alors par des zéros à gauche pour obtenir les 8 groupes.
  if (groups.length > 8) return null;
  while (groups.length < 8) groups.unshift('0');
  if (groups.some((g) => g === '' || !/^[0-9a-f]{1,4}$/.test(g))) return null;

  return groups.flatMap((g) => {
    const value = parseInt(g, 16);
    return [value >> 12, (value >> 8) & 0xf, (value >> 4) & 0xf, value & 0xf];
  });
}

function isValidIp(ip) {
  return ipToBits(ip) !== null;
}

/**
 * Teste une IP contre un CIDR (IPv4 ou IPv6), sans dépendance externe.
 *
 * @param {string} ip
 * @param {string} cidr
 * @returns {boolean}
 */
function ipInCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const ipBits = ipToBits(ip);
  const rangeBits = ipToBits(range);
  if (!ipBits || !rangeBits || ipBits.length !== rangeBits.length) return false;
  const prefix = bitsRaw === undefined ? ipBits.length * 4 : parseInt(bitsRaw, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ipBits.length * 4) return false;
  // `prefix` est en BITS, ipBits contient des NIBBLES (4 bits) : un /20
  // couvre 5 nibbles, pas 20. Les bits restants d'un préfixe non multiple
  // de 4 sont comparés via un masque.
  const fullNibbles = Math.floor(prefix / 4);
  for (let i = 0; i < fullNibbles; i++) {
    if (ipBits[i] !== rangeBits[i]) return false;
  }
  const remainingBits = prefix % 4;
  if (remainingBits > 0) {
    const mask = (0xf << (4 - remainingBits)) & 0xf;
    const a = ipBits[fullNibbles] === undefined ? 0 : ipBits[fullNibbles];
    const b = rangeBits[fullNibbles] === undefined ? 0 : rangeBits[fullNibbles];
    if ((a & mask) !== (b & mask)) return false;
  }
  return true;
}

function isCloudflareIp(ip) {
  const clean = normalizeIp(ip);
  if (!clean) return false;
  return configuredRanges().some((cidr) => ipInCidr(clean, cidr));
}

function isPrivateOrLoopback(ip) {
  const clean = normalizeIp(ip);
  if (!clean) return false;
  if (clean === '127.0.0.1' || clean === '::1') return true;
  if (clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80')) return true;
  if (clean.startsWith('10.') || clean.startsWith('192.168.')) return true;
  const m = /^172\.(\d+)\./.exec(clean);
  if (m) {
    const octet = parseInt(m[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

function parseXff(header) {
  if (Array.isArray(header)) header = header.join(',');
  if (typeof header !== 'string' || header.length > 1024) return [];
  return header
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((part) => part.length > 0 && part.length <= 45);
}

/**
 * Détermine l'adresse IP cliente de façon non falsifiable par le client.
 *
 * @param {import('express').Request} req
 * @returns {string} IP cliente, ou '' si elle est indéterminable
 */
function getClientIp(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress || '');
  const xff = parseXff(req.headers['x-forwarded-for']);

  if (process.env.DEBUG_PROXY_HEADERS === 'true') {
    console.warn('[DEBUG proxy] socket=%s xff=%j cf-connecting-ip=%j',
      socketIp, xff, req.headers['cf-connecting-ip'] || null);
  }

  // Branche Cloudflare : elle n'est ouverte QUE si la DERNIERE entree de la
  // chaine est une IP Cloudflare.
  //
  // Comportement MESURE de la stack reelle le 2026-09-26 (Traefik devant
  // Cloudflare) : Traefik n'AJOUTE PAS l'entree, il la REMPLACE par
  // l'adresse de son pair TCP quand l'emetteur n'est pas dans sa liste
  // `forwardedTrustIPs`. Un X-Forwarded-For forge par le client arrive donc
  // deja ecrase = IP du pair de Traefik, qui est soit une IP edge Cloudflare
  // (requete legitime), soit l'IP reelle de l'attaquant en acces direct.
  // Une chaine a plusieurs entrees signale un autre proxy : on reste prudent.
  //
  // Consequence : cette condition est PLUS SOLIDE que prevu. Un attaquant en
  // acces direct ne peut pas placer une IP Cloudflare en derniere position,
  // puisque Traefik reecrit la chaine apres reception. Une IP Cloudflare
  // ailleurs dans la chaine est ignoree.
  const last = xff.length > 0 ? xff[xff.length - 1] : '';

  if (last && isCloudflareIp(last)) {
    // CF-Connecting-IP est reecrit par Cloudflare : source la plus fiable.
    // Il doit toutefois etre une IP valide, sinon un en-tete pourri deviendrait
    // une cle de rate-limit libre. Attention : Traefik ne nettoie PAS cet
    // en-tete, il le transmet tel quel depuis une requete directe (verifie).
    const cfConnecting = normalizeIp(req.headers['cf-connecting-ip']);
    if (isValidIp(cfConnecting) && !isPrivateOrLoopback(cfConnecting)) return cfConnecting;

    // Repli : l'entree juste avant l'IP Cloudflare est l'IP du client telle
    // qu'affirmee par Cloudflare. Inutile avec la stack actuelle (XFF a une
    // seule entree) mais utile si un proxy intermediaire reecrase l'en-tete.
    for (let i = xff.length - 2; i >= 0; i--) {
      if (isValidIp(xff[i]) && !isPrivateOrLoopback(xff[i])) return xff[i];
    }
  }

  // Requête directe sur l'origine (ou proxy non-Cloudflare) : la dernière
  // entrée de X-Forwarded-For est celle que le proxy vient d'ajouter, donc
  // l'adresse TCP réelle. Les entrées précédentes sont fournies par le client.
  if (last) return last;

  // Aucun XFF : seule la socket fait foi. Si son adresse est privée, il
  // s'agit d'un autre conteneur du réseau Docker : on ne peut pas l'attribuer
  // à un humain, on garde donc la valeur brute comme clé (le portail
  // proxyGate interdit de toute façon à ces pairs d'atteindre l'API).
  return socketIp || 'unknown';
}

module.exports = {
  getClientIp,
  isCloudflareIp,
  isPrivateOrLoopback,
  isValidIp,
  ipInCidr,
  normalizeIp,
  CLOUDFLARE_RANGES
};
