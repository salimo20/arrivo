import './style.css';

const app = document.querySelector('#app');
const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
const demoMode = import.meta.env.VITE_DEMO_MODE === 'true';

const state = {
  stop: localStorage.getItem('lastStop') || '', route: '', data: null,
  loading: false, error: '', authenticated: false, verifying: false,
  refreshIn: 60, timer: null, installPrompt: null
};

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function render() {
  const hasResults = Boolean(state.data);
  const routes = state.data?.routes || [];
  const arrivals = state.data?.arrivals || [];

  app.innerHTML = `
    <div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>
    <div class="page-shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="Arrivo home">
          <img src="/icon.svg" alt="" width="48" height="48">
          <span><strong>ARRIVO</strong><small>DUBLIN LIVE BUS</small></span>
        </a>
        <div class="top-actions">
          ${state.installPrompt ? '<button id="install-app" class="install-button">Install app</button>' : ''}
          <div class="live-pill"><i></i><span>LIVE</span></div>
        </div>
      </header>

      <main>
        <section class="hero-card">
          <div class="hero-copy">
            <p class="eyebrow">YOUR BUS. YOUR TIME.</p>
            <h1>Live buses.<br><em>Zero guesswork.</em></h1>
            <p>Enter the number printed on your bus stop pole and Arrivo will show what is coming next.</p>
          </div>
          <form id="stop-form" class="search-form" novalidate>
            <label for="stop-number"><span>BUS STOP</span><small>Numbers only</small></label>
            <div class="search-row">
              <div class="input-wrap">
                <span aria-hidden="true">#</span>
                <input id="stop-number" name="stop" inputmode="numeric" autocomplete="off"
                  maxlength="8" pattern="[0-9]*" placeholder="${demoMode ? '9999' : '768'}"
                  value="${escapeHtml(state.stop)}" required>
              </div>
              <button class="primary-button" type="submit" ${state.loading ? 'disabled' : ''}>
                ${state.loading ? '<span class="spinner"></span><span>Checking</span>' : '<span>Find my bus</span><b aria-hidden="true">→</b>'}
              </button>
            </div>
            <p class="privacy-note"><span aria-hidden="true">◈</span> Secure live data. Your NTA key never leaves the server.</p>
          </form>
        </section>

        ${state.verifying ? securityPanel() : ''}
        ${state.error ? `<div class="error-banner" role="alert"><strong>We could not load the board.</strong><span>${escapeHtml(state.error)}</span></div>` : ''}

        ${hasResults ? `
          <section class="results" aria-live="polite">
            <div class="stop-heading">
              <div><p class="eyebrow">STOP ${escapeHtml(state.data.stop.code)}</p><h2>${escapeHtml(state.data.stop.name)}</h2></div>
              <div class="refresh-block"><span>REFRESH</span><strong>${state.refreshIn}s</strong></div>
            </div>
            <div class="route-filter" aria-label="Choose a route">
              <button class="route-chip ${state.route === '' ? 'active' : ''}" data-route="">ALL</button>
              ${routes.map((route) => `<button class="route-chip ${state.route === route ? 'active' : ''}" data-route="${escapeHtml(route)}">${escapeHtml(route)}</button>`).join('')}
            </div>
            <div class="board-shell">
              <div class="board-status"><span><i></i> ARRIVO LIVE DEPARTURES</span><time>${formatTime(state.data.refreshedAt)}</time></div>
              <div class="board-header" aria-hidden="true"><span>ROUTE</span><span>DESTINATION</span><span>ARRIVAL</span></div>
              <div class="arrival-board">
                ${arrivals.length ? arrivals.map(arrivalRow).join('') : `<div class="empty-state"><strong>No live buses for this selection.</strong><span>Choose ALL or check again after the next refresh.</span></div>`}
              </div>
              <div class="board-footer"><span>Updated ${formatTime(state.data.refreshedAt)}</span><button id="manual-refresh" class="text-button" ${state.loading ? 'disabled' : ''}>Refresh now ↻</button></div>
            </div>
          </section>` : ''}
      </main>
      <footer><strong>ARRIVO</strong><span>Independent passenger app · Live data supplied by the National Transport Authority.</span></footer>
    </div>`;
  bindEvents();
}

function securityPanel() {
  return `<section class="security-panel" aria-live="polite"><div class="shield">✓</div><div><strong>One quick security check</strong><p>This protects live arrivals. No account or password is needed.</p><div id="turnstile-container"></div></div></section>`;
}

function arrivalRow(item) {
  const cancelled = item.status === 'Cancelled';
  const minuteText = cancelled ? 'CANCELLED' : item.minutes === 0 ? 'DUE' : String(item.minutes).padStart(2, '0');
  const unit = cancelled || item.minutes === 0 ? '' : 'MIN';
  return `<article class="arrival-row">
    <div class="route-badge">${escapeHtml(item.route)}</div>
    <div class="destination"><strong>${escapeHtml(item.destination)}</strong><span>${escapeHtml(item.agencyName || 'Bus service')}${item.vehicleId ? ` · Bus ${escapeHtml(item.vehicleId)}` : ''}</span></div>
    <div class="arrival-time"><div class="flip-display ${cancelled ? 'cancelled' : ''}"><span class="flip-value">${minuteText}</span>${unit ? `<small>${unit}</small>` : ''}</div><span class="status status-${item.status.toLowerCase().replaceAll(' ', '-')}">${escapeHtml(item.status)}</span></div>
  </article>`;
}

function bindEvents() {
  document.querySelector('#stop-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const stop = document.querySelector('#stop-number').value.trim();
    if (!/^\d{1,8}$/.test(stop)) { state.error = 'Please enter the numeric stop number printed on the pole.'; render(); return; }
    state.stop = stop; state.route = ''; localStorage.setItem('lastStop', stop); await loadArrivals();
  });
  document.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', async () => { state.route = button.dataset.route || ''; await loadArrivals(false); }));
  document.querySelector('#manual-refresh')?.addEventListener('click', () => loadArrivals(false));
  document.querySelector('#install-app')?.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; render();
  });
}

async function loadArrivals(resetTimer = true) {
  state.loading = true; state.error = ''; render();
  try {
    await ensureAuthenticated();
    const params = new URLSearchParams({ stop: state.stop }); if (state.route) params.set('route', state.route);
    let response = await fetch(`/api/arrivals?${params}`, { credentials: 'same-origin' });
    if (response.status === 401) { state.authenticated = false; await ensureAuthenticated(true); response = await fetch(`/api/arrivals?${params}`, { credentials: 'same-origin' }); }
    const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || 'The live service did not respond.');
    state.data = payload; state.refreshIn = 60; if (resetTimer) startRefreshTimer();
  } catch (error) { state.error = error.message || 'Unexpected error.'; }
  finally { state.loading = false; state.verifying = false; render(); }
}

async function ensureAuthenticated(force = false) {
  if (!force && state.authenticated) return;
  if (!force) { const status = await fetch('/api/session', { credentials: 'same-origin' }); if (status.ok && (await status.json()).authenticated) { state.authenticated = true; return; } }
  const token = await getVerificationToken();
  const response = await fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnstileToken: token }) });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || 'Security verification failed.'); state.authenticated = true;
}

async function getVerificationToken() {
  if (demoMode && !turnstileSiteKey) return 'local-dev-bypass';
  if (!turnstileSiteKey) throw new Error('Turnstile is not configured. Add VITE_TURNSTILE_SITE_KEY in Netlify.');
  state.verifying = true; render(); await loadTurnstileScript();
  return new Promise((resolve, reject) => {
    const container = document.querySelector('#turnstile-container'); if (!container) return reject(new Error('Could not open security verification.'));
    window.turnstile.render(container, { sitekey: turnstileSiteKey, theme: 'dark', size: 'flexible', action: 'passenger_session', callback: resolve,
      'error-callback': () => reject(new Error('Security verification could not be completed.')),
      'expired-callback': () => reject(new Error('Security verification expired. Please try again.')) });
  });
}

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-turnstile]');
    if (existing) { existing.addEventListener('load', resolve, { once: true }); existing.addEventListener('error', reject, { once: true }); return; }
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.defer = true; script.dataset.turnstile = 'true'; script.onload = resolve; script.onerror = () => reject(new Error('Could not load the security check.')); document.head.appendChild(script);
  });
}

function startRefreshTimer() {
  clearInterval(state.timer); state.timer = setInterval(async () => {
    state.refreshIn -= 1; if (state.refreshIn <= 0) { state.refreshIn = 60; await loadArrivals(false); return; }
    const counter = document.querySelector('.refresh-block strong'); if (counter) counter.textContent = `${state.refreshIn}s`;
  }, 1000);
}

function formatTime(iso) {
  const date = new Date(iso); if (Number.isNaN(date.getTime())) return 'just now';
  return new Intl.DateTimeFormat('en-IE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.installPrompt = event; render(); });
window.addEventListener('appinstalled', () => { state.installPrompt = null; render(); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
window.addEventListener('online', () => { if (state.stop && state.data) loadArrivals(false); });
render();
