/**
 * Script pour la page dédiée des souscripteurs (/souscripteurs.html).
 * Gère l'affichage en temps réel, la recherche dynamique, les filtres et la pagination.
 */

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('searchInput');
  const searchClearBtn = document.getElementById('searchClearBtn');
  const subscribersList = document.getElementById('subscribersList');
  const totalDonorsBadge = document.getElementById('totalDonorsBadge');
  const totalAmountBadge = document.getElementById('totalAmountBadge');
  const maxDonationBadge = document.getElementById('maxDonationBadge');
  const subscribersCount = document.getElementById('subscribersCount');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const emptyState = document.getElementById('emptyState');
  const filterChips = document.querySelectorAll('.filter-chip');

  let currentOffset = 0;
  const limit = 30;
  let currentSearch = '';
  let activeFilter = 'all';
  let searchTimeout = null;
  let allLoadedSubscribers = [];

  // 1. Chargement initial
  loadSubscribers(true);

  // 2. Recherche dynamique en direct
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      currentSearch = e.target.value.trim();

      if (searchClearBtn) {
        if (currentSearch.length > 0) {
          searchClearBtn.classList.remove('hidden');
        } else {
          searchClearBtn.classList.add('hidden');
        }
      }

      searchTimeout = setTimeout(() => {
        currentOffset = 0;
        loadSubscribers(true);
      }, 300);
    });
  }

  // 3. Bouton pour effacer la recherche
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      currentSearch = '';
      searchClearBtn.classList.add('hidden');
      currentOffset = 0;
      loadSubscribers(true);
    });
  }

  // 4. Filtres rapides
  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.getAttribute('data-filter') || 'all';
      applyFilterAndRender();
    });
  });

  // 5. Bouton "Charger plus"
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      currentOffset += limit;
      loadSubscribers(false);
    });
  }

  /**
   * Récupère les donateurs depuis l'API
   * @param {boolean} reset True pour réinitialiser la liste (ex: nouvelle recherche)
   */
  async function loadSubscribers(reset = false) {
    try {
      if (reset) {
        currentOffset = 0;
        allLoadedSubscribers = [];
        if (subscribersList) {
          subscribersList.innerHTML = `
            <div style="text-align: center; padding: 3rem 0;">
              <div class="spinner-pending"></div>
              <p style="margin-top: 12px; color: var(--muted); font-size: 0.95rem;">Chargement des donateurs...</p>
            </div>
          `;
        }
      }

      const url = `/api/subscribers?limit=${limit}&offset=${currentOffset}&search=${encodeURIComponent(currentSearch)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || 'Erreur lors du chargement des donateurs.');
      }

      // Mise à jour des statistiques
      if (data.stats) {
        if (totalDonorsBadge) totalDonorsBadge.textContent = data.stats.totalDonors || 0;
        if (totalAmountBadge) totalAmountBadge.textContent = `${formatCFA(data.stats.totalAmount || 0)} FCFA`;
        if (maxDonationBadge) {
          const maxVal = data.stats.maxDonation || 0;
          maxDonationBadge.textContent = maxVal > 0 ? `${formatCFA(maxVal)} FCFA` : '-';
        }
      }

      const fetched = data.subscribers || [];

      if (reset) {
        allLoadedSubscribers = fetched;
      } else {
        allLoadedSubscribers = allLoadedSubscribers.concat(fetched);
      }

      // Gestion pagination
      if (loadMoreBtn) {
        if (data.pagination && data.pagination.hasMore) {
          loadMoreBtn.classList.remove('hidden');
        } else {
          loadMoreBtn.classList.add('hidden');
        }
      }

      applyFilterAndRender();

    } catch (err) {
      console.error('[Subscribers Error]', err);
      if (subscribersList && currentOffset === 0) {
        subscribersList.innerHTML = `
          <div class="subscribers-empty-box">
            <p style="color: #c0392b; font-weight:600;">Impossible de charger la liste pour le moment. Veuillez vérifier votre connexion.</p>
            <button onclick="location.reload()" class="btn-secondary-action" style="margin-top:10px;">Réessayer</button>
          </div>
        `;
      }
    }
  }

  function applyFilterAndRender() {
    let list = [...allLoadedSubscribers];

    if (activeFilter === 'top') {
      list.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    } else if (activeFilter === 'recent') {
      list.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    } else if (activeFilter === 'messages') {
      list = list.filter(d => Boolean(d.message && d.message.trim().length > 0));
    }

    if (subscribersCount) {
      const count = list.length;
      if (count === 0) {
        subscribersCount.textContent = 'Aucun donateur correspondant';
      } else if (count === 1) {
        subscribersCount.textContent = '1 donateur affiché';
      } else {
        subscribersCount.textContent = `${count} donateurs affichés`;
      }
    }

    if (list.length === 0) {
      if (subscribersList) subscribersList.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    if (subscribersList) {
      subscribersList.innerHTML = list.map((donor, idx) => renderSubscriberCard(donor, idx)).join('');
    }
  }

  function renderSubscriberCard(donor, index) {
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
});
