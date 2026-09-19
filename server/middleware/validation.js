/**
 * Middlewares de validation et de nettoyage des entrées pour l'API FeCAWa.
 */

function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>?/gm, '') // Supprime les balises HTML éventuelles (anti-XSS)
    .trim();
}

/**
 * Valide et nettoie les champs de création de don
 */
function validateDonationInput(req, res, next) {
  const {
    firstname,
    lastname,
    phone,
    email,
    amount,
    message,
    is_public,
    hide_amount
  } = req.body;

  const errors = [];

  // Validation Nom & Prénom
  const cleanFirstname = sanitizeString(firstname);
  const cleanLastname = sanitizeString(lastname);

  if (!cleanFirstname || cleanFirstname.length < 2) {
    errors.push('Le prénom est obligatoire (minimum 2 caractères).');
  }
  if (!cleanLastname || cleanLastname.length < 2) {
    errors.push('Le nom est obligatoire (minimum 2 caractères).');
  }

  // Validation Téléphone
  const cleanPhone = sanitizeString(phone).replace(/\s+/g, '');
  // Format minimum : au moins 8 chiffres
  const digitsOnly = cleanPhone.replace(/\D/g, '');
  if (!digitsOnly || digitsOnly.length < 8) {
    errors.push('Un numéro de téléphone valide est obligatoire pour le paiement Mobile Money.');
  }

  // Validation Montant (minimum 100 FCFA)
  const parsedAmount = parseInt(amount, 10);
  if (isNaN(parsedAmount) || parsedAmount < 100) {
    errors.push('Le montant du don doit être d\'au moins 100 FCFA.');
  }
  if (parsedAmount > 50000000) {
    errors.push('Le montant dépasse la limite autorisée.');
  }

  // Validation Email (optionnel)
  let cleanEmail = email ? sanitizeString(email) : null;
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    // Si l'email est invalide, on ne bloque pas si non obligatoire, mais on le nullifie ou signale
    cleanEmail = null;
  }

  // Message optionnel (tronqué à 500 caractères)
  let cleanMessage = message ? sanitizeString(message) : null;
  if (cleanMessage && cleanMessage.length > 500) {
    cleanMessage = cleanMessage.substring(0, 500);
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Erreur de validation des données transmises.',
      errors
    });
  }

  // Assigner les données nettoyées
  req.cleanData = {
    firstname: cleanFirstname,
    lastname: cleanLastname,
    phone: cleanPhone,
    email: cleanEmail,
    amount: parsedAmount,
    message: cleanMessage,
    isPublic: is_public === undefined ? true : Boolean(is_public),
    hideAmount: Boolean(hide_amount)
  };

  next();
}

module.exports = {
  validateDonationInput,
  sanitizeString
};
