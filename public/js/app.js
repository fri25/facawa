/**
 * Logique client principale de l'application FeCAWa 2026.
 * Gestion du formulaire de don, sélection de montant, appel API et Checkout FedaPay.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Éléments du formulaire
  const donationForm = document.getElementById('donationForm');
  const amountInput = document.getElementById('amountInput');
  const presetButtons = document.querySelectorAll('.amount-btn');
  const donateBtn = document.getElementById('donateBtn');
  const donateBtnText = document.getElementById('donateBtnText');
  const donateSpinner = document.getElementById('donateSpinner');
  const isPublicCheckbox = document.getElementById('isPublicCheckbox');
  const hideAmountCard = document.getElementById('hideAmountCard');
  const hideAmountCheckbox = document.getElementById('hideAmountCheckbox');

  // Éléments de statistiques & participants
  const metricTotal = document.getElementById('metricTotal');
  const metricDonors = document.getElementById('metricDonors');
  const metricRaised = document.getElementById('metricRaised');
  const metricPercent = document.getElementById('metricPercent');
  const metricProgressBar = document.getElementById('metricProgressBar');
  const recentDonorsFeed = document.getElementById('recentDonorsFeed');

  // Configuration FedaPay chargée depuis le serveur
  let publicConfig = null;

  // 1. Initialisation : Charger la configuration publique et les donateurs récents
  loadPublicConfig();
  loadRecentDonors();

  // 2. Gestion des boutons de montants suggérés (1000, 2000, 5000, 10000, 25000 FCFA)
  const heroAmountButtons = document.querySelectorAll('.hero-amount-btn');

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const amount = btn.getAttribute('data-amount');
      setAmount(amount);
    });
  });

  heroAmountButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const amount = btn.getAttribute('data-quick-amount');
      setAmount(amount);
      openDonationModal();
    });
  });

  function setAmount(amount) {
    if (amountInput) {
      amountInput.value = amount;
    }
    syncActiveButtons(amount);
  }

  function syncActiveButtons(amount) {
    const val = String(amount);
    presetButtons.forEach(b => {
      if (b.getAttribute('data-amount') === val) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });

    heroAmountButtons.forEach(b => {
      if (b.getAttribute('data-quick-amount') === val) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });
  }

  // Quand l'utilisateur saisit manuellement un montant
  amountInput.addEventListener('input', () => {
    syncActiveButtons(amountInput.value.trim());
  });

  // 3. Gestion du Panneau Modal de Souscription
  const donationModal = document.getElementById('donationModal');
  const modalBackdrop = document.getElementById('modalBackdrop');
  const closeModalBtn = document.getElementById('closeModalBtn');

  function openDonationModal() {
    if (donationModal) {
      donationModal.classList.remove('hidden');
      document.body.classList.add('modal-open');
      setTimeout(() => {
        const firstnameInput = document.getElementById('firstname');
        if (firstnameInput && !firstnameInput.value) {
          firstnameInput.focus();
        }
      }, 150);
    }
  }

  function closeDonationModal() {
    if (donationModal) {
      donationModal.classList.add('hidden');
      document.body.classList.remove('modal-open');
    }
  }

  // Écouteurs d'ouverture du modal
  document.querySelectorAll('.open-modal-btn, .btn-header-donate, .btn-hero-donate, a[href="#donner"], a[href="/#donner"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openDonationModal();
    });
  });

  // Écouteurs de fermeture du modal
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', closeDonationModal);
  }
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', closeDonationModal);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && donationModal && !donationModal.classList.contains('hidden')) {
      closeDonationModal();
    }
  });

  // Ouverture automatique si le lien pointe vers #donner
  if (window.location.hash === '#donner') {
    openDonationModal();
  }

  // 3. Gestion de la visibilité des options de confidentialité
  if (isPublicCheckbox && hideAmountCard) {
    isPublicCheckbox.addEventListener('change', () => {
      if (isPublicCheckbox.checked) {
        hideAmountCard.classList.remove('hidden');
      } else {
        hideAmountCard.classList.add('hidden');
        if (hideAmountCheckbox) hideAmountCheckbox.checked = false;
      }
    });
  }

  // 4. Soumission du formulaire de don
  if (donationForm) {
    donationForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const firstname = document.getElementById('firstname').value.trim();
      const lastname = document.getElementById('lastname').value.trim();
      const phone = document.getElementById('phone').value.trim();
      const email = document.getElementById('email')?.value.trim() || '';
      const amount = parseInt(amountInput.value, 10);
      const message = document.getElementById('message')?.value.trim() || '';
      const isPublic = isPublicCheckbox ? isPublicCheckbox.checked : true;
      const hideAmount = hideAmountCheckbox ? hideAmountCheckbox.checked : false;

      // Validations côté client
      if (!firstname || firstname.length < 2) {
        showToast('Veuillez renseigner votre prénom (au moins 2 lettres).', 'error');
        document.getElementById('firstname').focus();
        return;
      }

      if (!lastname || lastname.length < 2) {
        showToast('Veuillez renseigner votre nom de famille.', 'error');
        document.getElementById('lastname').focus();
        return;
      }

      const digits = phone.replace(/\D/g, '');
      if (digits.length < 8) {
        showToast('Veuillez renseigner un numéro de téléphone valide (Mobile Money).', 'error');
        document.getElementById('phone').focus();
        return;
      }

      if (isNaN(amount) || amount < 100) {
        showToast('Le montant minimum d\'un don est de 100 FCFA.', 'error');
        amountInput.focus();
        return;
      }

      // Activer l'état de chargement
      setLoading(true);

      try {
        const response = await fetch('/api/create-transaction', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            firstname,
            lastname,
            phone,
            email,
            amount,
            message,
            is_public: isPublic,
            hide_amount: hideAmount
          })
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.message || (data.errors && data.errors.join(' ')) || 'Erreur lors de l\'initialisation du don.');
        }

        console.log('[Donation] Transaction initialisée avec succès:', data);

        // Si la clé FedaPay est en mode simulation / démonstration locale
        if (data.isSimulated) {
          showToast('Mode simulation activé : redirection vers le reçu...', 'success');
          setTimeout(() => {
            window.location.replace(`/confirmation?id=${data.transactionId}&demo=true`);
          }, 800);
          return;
        }

        // Lancement du widget FedaPay Checkout.js
        triggerFedaPayCheckout({
          transactionId: data.transactionId,
          token: data.token,
          publicKey: data.publicKey || publicConfig?.fedapay?.publicKey,
          amount: data.amount,
          customer: { firstname, lastname, phone, email },
          checkoutUrl: data.checkoutUrl
        });

      } catch (err) {
        console.error('[Donation Error]', err);
        showToast(err.message || 'Une erreur est survenue lors de la préparation du paiement.', 'error');
        setLoading(false);
      }
    });
  }

  /**
   * Ouvre le widget officiel Checkout.js de FedaPay
   */
  function triggerFedaPayCheckout(params) {
    if (typeof FedaPay !== 'undefined') {
      try {
        console.log('[FedaPay] Ouverture du widget Checkout.js pour la transaction #', params.transactionId);

        // Ne pas empiler le modal du site sous l'overlay FedaPay
        closeDonationModal();

        const widget = FedaPay.init({
          public_key: params.publicKey,
          transaction: {
            id: params.transactionId
          },
          customer: {
            firstname: params.customer.firstname,
            lastname: params.customer.lastname,
            email: params.customer.email,
            phone_number: {
              number: params.customer.phone.replace(/\D/g, ''),
              country: 'BJ'
            }
          },
          onComplete: function(response) {
            console.log('[FedaPay] Paiement terminé callback:', response);

            if (response && response.reason === FedaPay.CHECKOUT_COMPLETED) {
              window.location.replace(`/confirmation?id=${params.transactionId}`);
              return;
            }

            console.log('[FedaPay] Fenêtre fermée sans paiement confirmé.');
            showToast('Paiement non confirmé. Vous pouvez réessayer.', 'info');
            setLoading(false);
          },
          onError: function(err) {
            console.error('[FedaPay] Erreur paiement:', err);
            showToast('Le paiement a été interrompu ou refusé.', 'error');
            setLoading(false);
          },
          onClose: function() {
            console.log('[FedaPay] Fenêtre de paiement fermée.');
            setLoading(false);
          }
        });

        widget.open();
      } catch (widgetError) {
        console.warn('[FedaPay] Erreur init widget, fallback URL:', widgetError);
        fallbackRedirect(params.checkoutUrl, params.transactionId);
      }
    } else {
      console.warn('[FedaPay] Checkout.js non disponible, redirection vers page de paiement.');
      fallbackRedirect(params.checkoutUrl, params.transactionId);
    }
  }

  function fallbackRedirect(checkoutUrl, txId) {
    if (checkoutUrl) {
      window.location.href = checkoutUrl;
    } else {
      window.location.replace(`/confirmation?id=${txId}`);
    }
  }

  function setLoading(isLoading) {
    if (!donateBtn) return;
    donateBtn.disabled = isLoading;
    if (isLoading) {
      donateBtnText.textContent = 'Préparation du paiement...';
      if (donateSpinner) donateSpinner.classList.remove('hidden');
    } else {
      donateBtnText.textContent = 'Faire un don avec FedaPay';
      if (donateSpinner) donateSpinner.classList.add('hidden');
    }
  }

  /**
   * Charge la configuration publique
   */
  async function loadPublicConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        publicConfig = await res.json();
      }
    } catch (e) {
      console.warn('Impossible de charger /api/config', e);
    }
  }

  /**
   * Charge les statistiques et les derniers donateurs en direct
   */
  async function loadRecentDonors() {
    try {
      const res = await fetch('/api/subscribers?limit=6');
      if (!res.ok) return;

      const data = await res.json();
      if (!data.success) return;

      // Mettre à jour les compteurs de statistiques synchronisés
      const stats = data.stats || {};
      const totalAmount = stats.totalAmount || 0;
      const totalDonors = stats.totalDonors || 0;
      const goal = 1000000;
      const percent = Math.min(100, (totalAmount / goal) * 100).toFixed(1);

      if (metricTotal) metricTotal.textContent = `${formatCFA(totalAmount)} FCFA`;
      if (metricDonors) metricDonors.textContent = totalDonors;
      if (metricRaised) metricRaised.textContent = formatCFA(totalAmount);
      if (metricPercent) metricPercent.textContent = `${percent} % de l'objectif atteint`;
      if (metricProgressBar) metricProgressBar.style.width = `${percent}%`;

      // Affichage des donateurs récents dans le feed de l'accueil
      if (recentDonorsFeed) {
        if (data.subscribers && data.subscribers.length > 0) {
          recentDonorsFeed.innerHTML = data.subscribers.map((donor, idx) => renderHomeDonorCard(donor, idx)).join('');
        } else {
          recentDonorsFeed.innerHTML = `
            <div class="participants-list">
              <p class="empty-state-line">Aucune souscription confirmée pour l'instant.</p>
              <p class="empty-state-sub">Soyez le premier à soutenir le FeCAWa 2026 !</p>
            </div>
          `;
        }
      }
    } catch (e) {
      console.warn('Erreur chargement souscripteurs récents:', e);
    }
  }

  function renderHomeDonorCard(donor, index) {
    const isGold = index === 0 && Boolean(donor.amount && donor.amount >= 50000);
    const initial = donor.displayName ? donor.displayName.charAt(0).toUpperCase() : 'W';
    const formattedAmount = donor.amount 
      ? `<span class="donor-sum">${formatCFA(donor.amount)} FCFA</span>`
      : `<span class="donor-amount-masked"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Montant masqué</span>`;

    const dateFormatted = formatDate(donor.date);

    return `
      <article class="donor-card">
        <div class="donor-card-top">
          <div class="donor-profile">
            <div class="donor-avatar-circle ${isGold ? 'gold-medal' : ''}" title="${escapeHtml(donor.displayName)}">
              ${escapeHtml(initial)}
            </div>
            <div class="donor-meta">
              <div class="donor-identity-row">
                <span class="donor-fullname">${escapeHtml(donor.displayName)}</span>
                <span class="donor-verified-badge">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  Don certifié
                </span>
              </div>
              <div class="donor-timestamp">Souscription confirmée • ${dateFormatted}</div>
            </div>
          </div>
          <div class="donor-amount-box">
            ${formattedAmount}
          </div>
        </div>
        ${donor.message ? `
          <div class="donor-message-bubble">
            « ${escapeHtml(donor.message)} »
          </div>
        ` : ''}
      </article>
    `;
  }
});

// Fonctions utilitaires partagées
function formatCFA(num) {
  return new Intl.NumberFormat('fr-FR').format(num);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (e) {
    return dateStr;
  }
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
