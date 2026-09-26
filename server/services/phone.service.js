/**
 * Normalisation des numéros de téléphone des donateurs.
 *
 * CONTEXTE : FedaPay attend un numéro NATIONAL (sans indicatif pays) et un
 * pays cohérent. Le code envoyait auparavant le numéro brut du donateur avec
 * un `country: 'BJ'` en dur. Un donateur ivoirin entrant « +225 07 … »
 * transmettait `2250712…` (13 chiffres) déclaré béninois : FedaPay rejetait
 * toute la transaction avec un « phone_number.number n'est pas valide », et le
 * donateur ne voyait qu'un « Impossible d'initialiser le paiement » sans
 * pouvoir corriger sa saisie.
 *
 * La zone XOF est partagée par sept pays : un festival culturel reçoit
 * légitimement des donateurs de tous. On déduit donc le pays de l'indicatif
 * saisi, et on ne retombe sur le pays par défaut (FEDAPAY_PHONE_COUNTRY)
 * que si le donateur a saisi un numéro national.
 */

// Pays de la zone franc CFA (XOF) acceptés par l'API FedaPay, avec la
// longueur du numéro national une fois l'indicatif pays retiré.
const COUNTRIES = Object.freeze({
  BJ: { callingCode: '229', nationalLength: 8, label: 'Bénin' },
  CI: { callingCode: '225', nationalLength: 10, label: "Côte d'Ivoire" },
  SN: { callingCode: '221', nationalLength: 9, label: 'Sénégal' },
  ML: { callingCode: '223', nationalLength: 8, label: 'Mali' },
  BF: { callingCode: '226', nationalLength: 8, label: 'Burkina Faso' },
  TG: { callingCode: '228', nationalLength: 8, label: 'Togo' },
  GM: { callingCode: '233', nationalLength: 8, label: 'Gambie' }
});

const DEFAULT_COUNTRY = (process.env.FEDAPAY_PHONE_COUNTRY || 'BJ').toUpperCase();

function countryConfig(code) {
  return COUNTRIES[code] || null;
}

/**
 * @param {string} raw Numéro tel que saisi par le donateur
 * @param {Object} [options]
 * @param {string} [options.defaultCountry] Code ISO du pays par défaut
 * @returns {{
 *   ok: boolean,
 *   reason: string,
 *   country: string,
 *   national: string,
 *   e164: string,
 *   label: string
 * }}
 */
function normalizeDonorPhone(raw, options = {}) {
  const fallback = String(options.defaultCountry || DEFAULT_COUNTRY).toUpperCase();
  const empty = { ok: false, reason: 'empty', country: '', national: '', e164: '', label: '' };

  if (typeof raw !== 'string' && typeof raw !== 'number') return empty;

  // Espaces, points, tirets, parenthèses, « + » : tout ce qui ne compte pas.
  let digits = String(raw).replace(/\D/g, '');
  if (digits === '00') return empty;

  // Préfixe international écrit « 00 » (convention européenne).
  if (digits.startsWith('00')) digits = digits.slice(2);

  // Indicatif pays : on teste les plus longs d'abord (pas de collision ici,
  // mais l'ordre reste explicite plutôt que dépendre de l'ordre des clés).
  let country = fallback;
  const callingCodes = Object.values(COUNTRIES)
    .map((config) => config.callingCode)
    .sort((a, b) => b.length - a.length);
  for (const code of callingCodes) {
    if (digits.startsWith(code) && digits.length > code.length) {
      country = Object.keys(COUNTRIES).find((key) => COUNTRIES[key].callingCode === code);
      digits = digits.slice(code.length);
      break;
    }
  }

  const config = countryConfig(country);
  if (!config) {
    return { ...empty, country, reason: 'unsupported-country' };
  }

  // Préfixe national (le « 0 » initial des formats locaux) : on le retire
  // uniquement s'il ne reste exactement la longueur nationale attendue,
  // sinon on ne touche à rien — certains pays n'utilisent pas ce préfixe.
  if (digits.length === config.nationalLength + 1 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // FedaPay est en pratique tolérant sur la longueur exacte (8 ou 10 chiffres
  // accepte côté Bénin) ; on rejette en revanche ce qui est manifestement
  // une erreur de saisie, pour renvoyer un message utile au donateur au lieu
  // d'un échec opaque côté FedaPay.
  const plausible =
    digits.length >= 8 &&
    digits.length <= 10 &&
    !/^(\d)\1+$/.test(digits);

  return {
    ok: plausible,
    reason: plausible ? '' : 'length',
    country,
    national: digits,
    e164: `+${config.callingCode}${digits}`,
    label: config.label
  };
}

module.exports = { normalizeDonorPhone, COUNTRIES, DEFAULT_COUNTRY };
