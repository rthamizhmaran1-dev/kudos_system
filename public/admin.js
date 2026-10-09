const $ = (id) => document.getElementById(id);
const state = { status: 'all', nextCursor: null, pending: null, loading: false };

(async function init() {
  try {
    const me = await api('GET', '/api/auth/me');
    if (me.role !== 'admin') { location.href = '/'; return; }
  } catch {
    location.href = '/';
    return;
  }
  load(true);
})();

$('logout-btn').addEventListener('click', logout);

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  state.status = b.dataset.status;
  load(true);
}));
$('load-more').addEventListener('click', () => load(false));

async function load(reset) {
  if (state.loading) return;
  state.loading = true;
  showBanner($('admin-error'), '');
  try {
    const qs = new URLSearchParams({ status: state.status, limit: '20' });
    if (!reset && state.nextCursor) qs.set('cursor', state.nextCursor);
    const data = await api('GET', `/api/admin/kudos?${qs}`);
    if (reset) $('rows').textContent = '';
    data.items.forEach((k) => $('rows').append(row(k)));
    state.nextCursor = data.nextCursor;
    $('load-more').hidden = !data.nextCursor;
    $('empty').hidden = $('rows').children.length > 0;
  } catch (err) {
    if (err.status === 401 || err.status === 403) return (location.href = '/');
    showBanner($('admin-error'), err.message);
  } finally {
    state.loading = false;
  }
}

function row(k) {
  const status = el('td', {},
    el('span', { class: `badge ${k.isVisible ? '' : 'hidden'}`, text: k.isVisible ? 'Visible' : 'Hidden' }),
    k.reportCount > 0 ? [' ', el('span', { class: 'badge reported', text: `${k.reportCount} report${k.reportCount > 1 ? 's' : ''}` })] : null);

  const details = el('td', { class: 'meta' });
  if (!k.isVisible) {
    details.append(
      el('div', { text: `By: ${k.moderatedBy || 'system (auto-hide)'}` }),
      el('div', { text: `When: ${k.moderatedAt ? new Date(k.moderatedAt).toLocaleString() : '–'}` }),
      el('div', { text: `Reason: ${k.moderationReason || '–'}` }));
  } else details.textContent = '–';

  const actions = el('td', { class: 'actions' });
  if (k.isVisible) actions.append(el('button', { class: 'secondary small', type: 'button', text: 'Hide', onclick: () => ask('hide', k) }));
  else actions.append(el('button', { class: 'secondary small', type: 'button', text: 'Restore', onclick: () => restore(k) }));
  actions.append(el('button', { class: 'danger small', type: 'button', text: 'Delete', onclick: () => ask('delete', k) }));

  return el('tr', { 'data-id': String(k.id) },
    el('td', { text: `${k.sender.name} → ${k.recipient.name}` }),
    el('td', { text: k.message, style: 'overflow-wrap:anywhere;max-width:340px' }),
    status, details, actions);
}

function ask(action, k) {
  state.pending = { action, k };
  $('dialog-title').textContent = action === 'hide' ? 'Hide this kudos?' : 'Permanently delete this kudos?';
  $('dialog-text').textContent = action === 'hide'
    ? 'It will disappear from the public feed. You can restore it later.'
    : 'This cannot be undone. A record is kept in the moderation log.';
  $('action-reason').value = '';
  $('action-error').textContent = '';
  $('action-dialog').showModal();
}
$('action-cancel').addEventListener('click', () => $('action-dialog').close());

$('action-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reason = $('action-reason').value.trim();
  if (!reason) { $('action-error').textContent = 'A reason is required'; return; }
  const { action, k } = state.pending;
  $('action-confirm').disabled = true;
  try {
    if (action === 'hide') await api('PATCH', `/api/admin/kudos/${k.id}/hide`, { reason });
    else await api('DELETE', `/api/admin/kudos/${k.id}`, { reason });
    $('action-dialog').close();
    toast(action === 'hide' ? 'Kudos hidden' : 'Kudos deleted');
    load(true);
  } catch (err) {
    $('action-error').textContent = err.message;
  } finally {
    $('action-confirm').disabled = false;
  }
});

async function restore(k) {
  try {
    await api('PATCH', `/api/admin/kudos/${k.id}/restore`);
    toast('Kudos restored');
    load(true);
  } catch (err) {
    showBanner($('admin-error'), err.message);
  }
}
