// All DOM is built with el(); chain data (token names, URIs…) is untrusted,
// so nothing is ever assigned through innerHTML.
const $ = (id) => document.getElementById(id);
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLSCAN = 'https://solscan.io';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1400);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed');
  }
}

const copyBtn = (text) => el('button', { class: 'icon-btn', title: 'Copy address', onclick: () => copy(text) }, 'Copy');
const lookupLink = (address, text = address) => el('a', { class: 'mono', href: `#/a/${address}`, title: address }, text);
const solscan = (address, kind = 'account') =>
  el('a', { class: 'icon-btn', href: `${SOLSCAN}/${kind}/${address}`, target: '_blank', rel: 'noopener noreferrer', title: 'Open in Solscan' }, 'Solscan');

// ------------------------------------------------------------- routing

const state = { q: '', category: '', type: '', protocol: '', facets: null };

function route() {
  const hash = location.hash.slice(1) || '/';
  const [path, query = ''] = hash.split('?');
  const showLookup = path.startsWith('/a/') || path === '/lookup';
  $('directory').hidden = showLookup;
  $('lookup').hidden = !showLookup;
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.tab === (showLookup ? 'lookup' : 'directory'));

  if (path.startsWith('/a/')) {
    const params = new URLSearchParams(query);
    const address = decodeURIComponent(path.slice(3));
    $('lookup-input').value = address;
    renderLookup(address, params.has('holdings'));
  } else if (path === '/lookup') {
    $('lookup-result').replaceChildren();
    $('lookup-input').focus();
  } else {
    const params = new URLSearchParams(query);
    for (const k of ['q', 'category', 'type', 'protocol']) state[k] = params.get(k) || '';
    $('search').value = state.q;
    renderDirectory();
  }
}

function setFilters(patch) {
  Object.assign(state, patch);
  const params = new URLSearchParams();
  for (const k of ['q', 'category', 'type', 'protocol']) if (state[k]) params.set(k, state[k]);
  const next = `#/${params.toString() ? `?${params}` : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
  renderDirectory();
}

// ------------------------------------------------------------- directory

async function loadFacets() {
  state.facets = await api('/api/facets');
  const typeSel = $('type');
  for (const t of state.facets.types) typeSel.append(el('option', { value: t.name }, `${t.name} (${t.count})`));
  const protoSel = $('protocol');
  for (const p of state.facets.protocols) protoSel.append(el('option', { value: p.name }, `${p.name} (${p.count})`));
  typeSel.onchange = () => setFilters({ type: typeSel.value });
  protoSel.onchange = () => setFilters({ protocol: protoSel.value });
}

function renderChips() {
  const f = state.facets;
  const chip = (name, label, count) =>
    el('button', { class: `chip${state.category === name ? ' on' : ''}`, onclick: () => setFilters({ category: name }) },
      label, el('span', { class: 'n' }, count));
  $('categories').replaceChildren(
    chip('', 'All', f.total),
    ...f.categories.map((c) => chip(c.name, c.name, c.count)),
  );
  $('type').value = state.type;
  $('protocol').value = state.protocol;
}

let directoryRequest = 0;
async function renderDirectory() {
  if (!state.facets) return;
  renderChips();
  const id = ++directoryRequest;
  const params = new URLSearchParams();
  for (const k of ['q', 'category', 'type', 'protocol']) if (state[k]) params.set(k, state[k]);
  const { total, entries } = await api(`/api/search?${params}`);
  if (id !== directoryRequest) return;

  const synced = state.facets.syncedAt ? ` · on-chain data synced ${new Date(state.facets.syncedAt).toLocaleString()}` : '';
  $('count').textContent = `${total} address${total === 1 ? '' : 'es'}${synced}`;

  if (!entries.length) {
    $('results').replaceChildren(el('p', { class: 'empty' }, 'No matches. Paste an address in the search box to identify it on-chain.'));
    return;
  }
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.protocol)) groups.set(e.protocol, []);
    groups.get(e.protocol).push(e);
  }
  $('results').replaceChildren(
    ...[...groups].map(([protocol, list]) => {
      const first = list[0];
      return el('section', { class: 'group' },
        el('div', { class: 'group-head' },
          el('h2', {}, protocol),
          el('span', { class: 'tag cat' }, first.category),
          el('span', { class: 'muted' }, `${list.length}`),
          first.website && el('a', { href: first.website, target: '_blank', rel: 'noopener noreferrer' }, new URL(first.website).host),
        ),
        ...list.map(entryRow),
      );
    }),
  );
}

function entryRow(e) {
  return el('div', { class: 'entry' },
    el('div', { class: 'name' }, e.name, e.notes && el('span', { class: 'notes' }, e.notes)),
    el('div', { class: 'type' }, el('span', { class: 'tag' }, e.type)),
    el('div', { class: 'addr' }, lookupLink(e.address)),
    el('div', { class: 'actions' },
      el('span', { class: `tag src-${e.source}`, title: SOURCE_INFO[e.source] }, e.source),
      copyBtn(e.address),
      solscan(e.address),
    ),
  );
}

const SOURCE_INFO = {
  chain: 'Read from on-chain config accounts by `npm run sync`',
  derived: 'Derived deterministically (PDA / ATA)',
  repo: 'Taken from addresses already used in your bots, verified on-chain',
  curated: 'Hand-curated, verified on-chain by `npm run verify`',
  custom: 'Your own label',
};

// ------------------------------------------------------------- lookup

let lookupRequest = 0;
async function renderLookup(address, holdings = false) {
  const out = $('lookup-result');
  const id = ++lookupRequest;
  out.replaceChildren(el('p', { class: 'loading' }, 'Reading chain state…'));
  let r;
  try {
    r = await api(`/api/whois/${encodeURIComponent(address)}${holdings ? '?holdings' : ''}`);
  } catch (e) {
    if (id === lookupRequest) out.replaceChildren(el('p', { class: 'error' }, `Lookup failed: ${e.message}`));
    return;
  }
  if (id !== lookupRequest) return;
  if (!r.valid) {
    const isSig = /signature/.test(r.error);
    out.replaceChildren(el('div', { class: 'card' },
      el('p', { class: 'error' }, r.error),
      isSig && el('a', { href: `${SOLSCAN}/tx/${address}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open the transaction in Solscan'),
    ));
    return;
  }

  const verdict = el('div', { class: 'card verdict' },
    el('h1', {}, r.summary),
    r.detail && r.detail !== r.summary && el('p', { class: 'detail' }, r.detail),
    el('div', { class: 'addr' }, el('span', { class: 'mono' }, r.address), copyBtn(r.address), solscan(r.address)),
    r.labels.length > 0 && el('div', { class: 'labels' },
      ...r.labels.map((l) => el('span', { class: 'label-pill' },
        `${l.protocol} · ${l.name} `,
        el('span', { class: 'tag' }, l.type), ' ',
        el('span', { class: `tag src-${l.source}`, title: SOURCE_INFO[l.source] }, l.source),
      )),
    ),
    ...(r.hints || []).map((h) => el('p', { class: 'hint' }, h)),
    r.offerHoldings && !holdings && el('p', {},
      el('button', { class: 'ghost small', onclick: () => { location.hash = `#/a/${r.address}?holdings`; } }, 'Load token holdings'),
      el('span', { class: 'muted' }, '  (can be slow for busy wallets)'),
    ),
  );

  const sections = r.sections.map((s) =>
    el('div', { class: 'card section' },
      el('h3', {}, s.title),
      el('dl', { class: 'kv' }, ...s.rows.flatMap((row) => [el('dt', {}, row.key), el('dd', {}, rowValue(row))])),
    ),
  );

  out.replaceChildren(verdict, ...sections, labelForm(r));
}

function rowValue(row) {
  if (row.address) {
    return el('span', {}, lookupLink(row.address), row.label && el('span', { class: 'lbl' }, row.label));
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(row.value)) {
    return el('a', { class: 'mono', href: `${SOLSCAN}/tx/${row.value}`, target: '_blank', rel: 'noopener noreferrer' }, row.value);
  }
  return row.value;
}

function labelForm(r) {
  const f = state.facets;
  const custom = r.labels.filter((l) => l.source === 'custom');
  const input = (name, placeholder, required) => el('input', { name, placeholder, required });
  const select = (name, values, initial) =>
    el('select', { name }, ...values.map((v) => el('option', { value: v, selected: v === initial }, v)));
  const form = el('form', { class: 'label-form' },
    input('name', 'Name (e.g. "Axiom fee wallet")', true),
    input('protocol', 'Protocol / owner'),
    select('category', f.allCategories, 'other'),
    select('type', f.allTypes, 'wallet'),
    input('notes', 'Notes (optional)'),
    el('button', { type: 'submit' }, 'Save label'),
  );
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    try {
      await api('/api/labels', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, address: r.address }) });
      toast('Label saved');
      await refreshFacets();
      renderLookup(r.address);
    } catch (e) {
      toast(e.message);
    }
  };
  return el('details', { class: 'card', open: r.labels.length === 0 || null },
    el('summary', {}, r.labels.length ? 'Add another label' : 'Know what this is? Label it'),
    el('p', { class: 'muted' }, 'Saved to data/custom.json and shown everywhere this address appears.'),
    form,
    custom.length > 0 && el('p', {},
      el('button', { class: 'ghost small', onclick: async () => {
        await api(`/api/labels/${r.address}`, { method: 'DELETE' });
        toast('Custom labels removed');
        await refreshFacets();
        renderLookup(r.address);
      } }, `Remove my ${custom.length} label(s)`),
    ),
  );
}

async function refreshFacets() {
  $('type').length = 1;
  $('protocol').length = 1;
  await loadFacets();
}

// ------------------------------------------------------------- wiring

$('search-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = $('search').value.trim();
  if (ADDRESS_RE.test(v) || v.length > 80) location.hash = `#/a/${v}`;
  else if (location.hash.startsWith('#/a/') || location.hash === '#/lookup') location.hash = `#/?q=${encodeURIComponent(v)}`;
  else setFilters({ q: v });
});
let typingTimer;
$('search').addEventListener('input', () => {
  const v = $('search').value.trim();
  if (ADDRESS_RE.test(v) || $('directory').hidden) return;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => setFilters({ q: v }), 150);
});
$('lookup-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = $('lookup-input').value.trim();
  if (v) location.hash = `#/a/${v}`;
});
window.addEventListener('hashchange', route);

loadFacets().then(route).catch((e) => {
  $('results').replaceChildren(el('p', { class: 'error' }, `Could not reach the API: ${e.message}`));
  route();
});
