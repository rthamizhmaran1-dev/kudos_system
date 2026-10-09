const $ = (id) => document.getElementById(id);
const MAX = 500;
const state = { me: null, users: [], nextCursor: null, loadingFeed: false, reportingId: null, pollTimer: null };

// ---------- Boot ----------
(async function init() {
  try {
    state.me = await api('GET', '/api/auth/me');
  } catch {
    $('login-view').hidden = false;
    return;
  }
  showDashboard();
})();

// ---------- Login ----------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showBanner($('login-error'), '');
  $('login-btn').disabled = true;
  try {
    state.me = await api('POST', '/api/auth/login', { email: $('email').value, password: $('password').value });
    $('login-view').hidden = true;
    $('password').value = '';
    showDashboard();
  } catch (err) {
    showBanner($('login-error'), err.message);
  } finally {
    $('login-btn').disabled = false;
  }
});

$('logout-btn').addEventListener('click', logout);

async function showDashboard() {
  $('dashboard-view').hidden = false;
  $('whoami').textContent = `Signed in as ${state.me.name}`;
  $('admin-link').hidden = state.me.role !== 'admin';
  await Promise.all([loadUsers(), loadFeed(true)]);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { if (!document.hidden) loadFeed(true, true); }, 60000);
}

// ---------- Recipient select ----------
async function loadUsers() {
  try {
    state.users = await api('GET', '/api/users');
    renderUsers('');
  } catch (err) {
    showBanner($('form-error'), err.message);
  }
}

function renderUsers(filter) {
  const sel = $('recipient');
  const previous = sel.value;
  sel.textContent = '';
  sel.append(el('option', { value: '', text: 'Select a colleague…' }));
  const f = filter.trim().toLowerCase();
  state.users.filter((u) => u.name.toLowerCase().includes(f)).forEach((u) => sel.append(el('option', { value: String(u.id), text: u.name })));
  if ([...sel.options].some((o) => o.value === previous)) sel.value = previous;
}
$('recipient-search').addEventListener('input', (e) => renderUsers(e.target.value));

// ---------- Message counter ----------
function updateCounter() {
  const len = Array.from($('message').value).length;
  const c = $('message-counter');
  c.textContent = `${len} / ${MAX}`;
  c.classList.toggle('over', len > MAX);
}
$('message').addEventListener('input', updateCounter);

// ---------- Submit kudos ----------
function setFieldErrors(fields = {}) {
  $('recipient-error').textContent = fields.recipientId || '';
  $('message-error').textContent = fields.message || '';
}

$('kudos-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showBanner($('form-error'), '');
  setFieldErrors();

  // Client-side checks (the server re-validates everything)
  const recipientId = Number($('recipient').value);
  const message = $('message').value.trim();
  const fields = {};
  if (!recipientId) fields.recipientId = 'Please select a colleague';
  if (!message) fields.message = 'Message is required';
  else if (Array.from(message).length > MAX) fields.message = `Message must be at most ${MAX} characters`;
  if (Object.keys(fields).length) return setFieldErrors(fields);

  const btn = $('submit-btn');
  btn.disabled = true; // prevents double submissions
  try {
    const created = await api('POST', '/api/kudos', { recipientId, message });
    $('message').value = '';
    $('recipient').value = '';
    $('recipient-search').value = '';
    renderUsers('');
    updateCounter();
    prependKudos(created);
    toast('Kudos sent! 🎉');
  } catch (err) {
    if (err.fields && Object.keys(err.fields).length) setFieldErrors(err.fields);
    // Typed message is preserved on error.
    showBanner($('form-error'), err.network ? "Couldn't submit kudos. Please try again." : err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Feed ----------
function kudosCard(k) {
  const recipientName = k.recipient.former ? `${k.recipient.name} (former employee)` : k.recipient.name;
  const head = el('div', { class: 'kudos-head' },
    el('span', {}, el('strong', { text: k.sender.name }), ' → ', el('strong', { text: recipientName })),
    el('span', { class: 'meta', title: new Date(k.createdAt).toLocaleString(), text: timeAgo(k.createdAt) }));
  const children = [head, el('p', { class: 'kudos-msg', text: k.message })];
  if (state.me && k.sender.id !== state.me.id) {
    children.push(el('button', { class: 'secondary small', type: 'button', text: 'Report', onclick: () => openReport(k.id) }));
  }
  return el('article', { class: 'kudos-item', 'data-id': String(k.id) }, children);
}

function updateEmpty() {
  $('feed-empty').hidden = $('feed').children.length > 0;
}

function prependKudos(k) {
  $('feed').prepend(kudosCard(k));
  updateEmpty();
}

async function loadFeed(reset = false, silent = false) {
  if (state.loadingFeed) return;
  state.loadingFeed = true;
  if (!silent) showBanner($('feed-error'), '');
  try {
    const qs = new URLSearchParams({ limit: '20' });
    if (!reset && state.nextCursor) qs.set('cursor', state.nextCursor);
    const data = await api('GET', `/api/kudos?${qs}`);
    if (reset) $('feed').textContent = '';
    data.items.forEach((k) => $('feed').append(kudosCard(k)));
    state.nextCursor = data.nextCursor;
    $('load-more').hidden = !data.nextCursor;
    updateEmpty();
  } catch (err) {
    if (err.status === 401) return location.reload();
    if (!silent) showBanner($('feed-error'), err.message);
  } finally {
    state.loadingFeed = false;
  }
}
$('load-more').addEventListener('click', () => loadFeed(false));

// ---------- Report ----------
function openReport(id) {
  state.reportingId = id;
  $('report-reason').value = '';
  $('report-dialog').showModal();
}
$('report-cancel').addEventListener('click', () => $('report-dialog').close());
$('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('report-confirm').disabled = true;
  try {
    await api('POST', `/api/kudos/${state.reportingId}/report`, { reason: $('report-reason').value });
    $('report-dialog').close();
    toast('Thanks – an admin will review it.');
    loadFeed(true, true); // item may have been auto-hidden
  } catch (err) {
    $('report-dialog').close();
    showBanner($('feed-error'), err.message);
  } finally {
    $('report-confirm').disabled = false;
  }
});
