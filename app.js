'use strict';
/* Humus Bestellungen: gesamte App-Logik.
   Abschnitte: 1 Helfer · 2 Zustand · 3 Login/Router · 4 Live-Daten · 5 Ton · 6 Bestellkarte
               7 Kellner · 8 Küche · 9 Admin */

const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const app = document.getElementById('app');

/* ---------- 1. Helfer ---------- */
const $ = (s) => document.querySelector(s);

function el(tag, props, ...kids) {           // kleiner Element-Baukasten (textContent = sicher gegen Schadcode)
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => { if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c)); });
  return n;
}
const fill = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false));
const eur = (c) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const hm = (d) => new Date(d).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const dayStr = (d) => new Date(d).toLocaleDateString('sv-SE');          // JJJJ-MM-TT (lokal)
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const STATUS = { neu: 'Neu', in_arbeit: 'In Zubereitung', fertig: 'Fertig' };
const SOURCE = { telefon: 'Telefon', vor_ort: 'Vor Ort', online: 'Online-E-Mail' };

function toast(msg, bad) {
  const t = el('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

/* ---------- 2. Zustand (Warenkorb bleibt bei Seiten-Neuladen erhalten) ---------- */
const newForm = () => ({ asap: true, date: dayStr(new Date()), time: '', name: '', phone: '', note: '', source: 'vor_ort' });
const S = { user: null, role: null, cat: null, tab: 'neu', cart: [], form: newForm(), editId: null };
try { Object.assign(S, JSON.parse(localStorage.getItem('humus') || '{}')); } catch (e) { /* ignorieren */ }
S.form = { ...newForm(), ...S.form };
const save = () => { try { localStorage.setItem('humus', JSON.stringify({ cart: S.cart, form: S.form, editId: S.editId })); } catch (e) { /* ignorieren */ } };

/* ---------- 3. Login, Rollen, Router ---------- */
const ROUTES = {
  menu: ['kellner', 'admin'], abschluss: ['kellner', 'admin'], uebersicht: ['kellner', 'admin'],
  kueche: ['kueche', 'admin'], admin: ['admin'],
};
const HOME = { kellner: 'menu', kueche: 'kueche', admin: 'admin' };
const NAV = {
  kellner: [['menu', 'Menü'], ['uebersicht', 'Übersicht']],
  admin: [['menu', 'Menü'], ['uebersicht', 'Übersicht'], ['kueche', 'Küche'], ['admin', 'Admin']],
  kueche: [],
};

async function setSession(session) {
  S.user = session ? session.user : null;
  S.role = null;
  if (S.user) {
    const { data } = await sb.from('profiles').select('role').eq('id', S.user.id).maybeSingle();
    S.role = data ? data.role : null;
  }
  route();
}
async function logout() { await sb.auth.signOut(); await setSession(null); }

function route() {
  stopLive();
  if (!S.user) return viewLogin();
  if (!S.role) return viewNoRole();
  const name = location.hash.replace('#/', '');
  if (!(ROUTES[name] || []).includes(S.role)) { location.hash = '#/' + HOME[S.role]; return; }
  ({ menu: viewMenu, abschluss: viewAbschluss, uebersicht: viewUebersicht, kueche: viewKueche, admin: viewAdmin })[name]();
}

function shell(title, body) {
  const cur = location.hash.replace('#/', '');
  const active = (n) => n === cur || (n === 'menu' && cur === 'abschluss');
  app.replaceChildren(
    el('header', { class: 'bar' + (NAV[S.role].length ? ' has-nav' : '') },
      el('strong', {}, title),
      el('nav', {}, NAV[S.role].map(([n, t]) => el('a', { href: '#/' + n, class: active(n) ? 'on' : '' }, t))),
      el('span', { id: 'dot', class: 'dot', title: 'Verbindung' }),
      el('button', { class: 'ghost', onclick: logout }, 'Abmelden')),
    el('main', {}, body));
}

function viewLogin() {
  const err = el('p', { class: 'error' });
  const email = el('input', { type: 'email', placeholder: 'E-Mail', autocomplete: 'username', required: true });
  const pw = el('input', { type: 'password', placeholder: 'Passwort', autocomplete: 'current-password', required: true });
  const btn = el('button', { class: 'primary', type: 'submit' }, 'Anmelden');
  app.replaceChildren(el('form', {
    class: 'login',
    onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = '';
      const { data, error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
      btn.disabled = false;
      if (error) { err.textContent = 'E-Mail oder Passwort falsch.'; return; }
      await setSession(data.session);
    },
  }, el('h1', {}, 'Mr. & Mrs. Humus'), el('p', {}, 'Bestellungen zum Mitnehmen'), email, pw, btn, err));
}
function viewNoRole() {
  app.replaceChildren(el('div', { class: 'login' }, el('h1', {}, 'Kein Zugriff'),
    el('p', {}, 'Für dieses Konto ist keine Rolle eingetragen. Bitte den Admin fragen.'),
    el('button', { class: 'primary', onclick: logout }, 'Abmelden')));
}

/* ---------- 4. Live-Daten (Realtime + Sicherheitsnetz) ---------- */
const live = { map: new Map(), ch: null, timer: null, render: null, sound: false, ready: false, wake: null };
const isLive = (o) => o.status !== 'fertig' || new Date(o.created_at) >= startOfDay();

function setDot(ok) {
  const d = $('#dot');
  if (d) { d.className = 'dot ' + (ok ? 'ok' : 'off'); d.title = ok ? 'Verbunden' : 'Keine Verbindung'; }
}
function put(o) {                              // eine Bestellung einsortieren; Küche: Ton bei neu/geändert
  const old = live.map.get(o.id);
  if (!isLive(o)) { live.map.delete(o.id); return; }
  live.map.set(o.id, o);
  if (live.ready && live.sound) {
    if (!old && o.status === 'neu') beep('new');
    else if (old && o.edited_at !== old.edited_at) beep('edit');
  }
}
async function reload() {
  const { data, error } = await sb.from('orders').select('*')
    .or(`status.neq.fertig,created_at.gte.${startOfDay().toISOString()}`).order('created_at');
  if (error) { setDot(false); return; }
  const ids = new Set(data.map((o) => o.id));
  data.forEach(put);
  for (const id of [...live.map.keys()]) if (!ids.has(id)) live.map.delete(id);
  live.ready = true;
  if (live.render) live.render();
}
function onVisible() {
  if (document.visibilityState !== 'visible') return;
  reload();
  if (live.sound) keepAwake();
}
async function keepAwake() { try { live.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* nicht unterstützt */ } }

function startLive(render, sound) {
  live.map.clear(); live.ready = false; live.render = render; live.sound = sound;
  live.ch = sb.channel('orders-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (p) => {
      if (p.eventType === 'DELETE') live.map.delete(p.old.id); else put(p.new);
      render();
    })
    .subscribe((st) => { setDot(st === 'SUBSCRIBED'); if (st === 'SUBSCRIBED') reload(); });
  live.timer = setInterval(reload, 30000);   // Sicherheitsnetz + Uhrzeit-Farben aktualisieren
  document.addEventListener('visibilitychange', onVisible);
  if (sound) keepAwake();
}
function stopLive() {
  if (live.ch) sb.removeChannel(live.ch);
  clearInterval(live.timer);
  document.removeEventListener('visibilitychange', onVisible);
  if (live.wake) { live.wake.release().catch(() => {}); live.wake = null; }
  live.ch = null; live.render = null;
}
window.addEventListener('online', () => live.ch && reload());
window.addEventListener('offline', () => setDot(false));

/* ---------- 5. Ton (nur Küche) ---------- */
let actx = null;                                 // Browser erlauben Ton erst nach einem Tippen
function enableSound() { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); }
function beep(kind) {
  if (!actx) return;
  const notes = kind === 'new' ? [[880, 0], [1175, 0.2], [880, 0.4], [1175, 0.6]] : [[520, 0], [520, 0.18]];
  notes.forEach(([f, t]) => {
    const o = actx.createOscillator(), g = actx.createGain(), s = actx.currentTime + t;
    o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.5, s); g.gain.exponentialRampToValueAtTime(0.001, s + 0.17);
    o.start(s); o.stop(s + 0.18);
  });
}

/* ---------- 6. Bestellkarte (gleich für Küche, Kellner, Admin) ---------- */
const sortKey = (o) => new Date(o.pickup_at || o.created_at).getTime();
const isLate = (o) => o.status !== 'fertig' && o.pickup_at && new Date(o.pickup_at) - Date.now() < 10 * 60000;
const changed = (o) => o.status !== 'fertig' && o.edited_at && (!o.ack_at || new Date(o.edited_at) > new Date(o.ack_at));

function pickupLabel(o) {
  if (!o.pickup_at) return 'Ab sofort';
  const d = new Date(o.pickup_at);
  const day = dayStr(d) === dayStr(new Date()) ? '' : d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' ';
  return `Abholung ${day}${hm(d)} Uhr`;
}

async function patchOrder(o, patch) {            // eine Änderung speichern (Rechte prüft die Datenbank)
  const { data, error } = await sb.from('orders').update(patch).eq('id', o.id).select().single();
  if (error) return toast('Änderung fehlgeschlagen. Bitte erneut versuchen.', true);
  put(data); live.render();
}
const stamp = (on) => (on ? new Date().toISOString() : null);
function setStatus(o, status) {
  const now = new Date().toISOString();
  patchOrder(o, { status, ack_at: now, started_at: status === 'neu' ? null : (o.started_at || now), ready_at: status === 'fertig' ? now : null });
}
const ackChange = (o) => patchOrder(o, { ack_at: stamp(true) });          // "Änderung gesehen", Status bleibt
const togglePaid = (o) => patchOrder(o, { paid_at: stamp(!o.paid_at) });
const setPickedUp = (o, yes) => patchOrder(o, { picked_up_at: stamp(yes) });
const advance = (o) => { if (o.status !== 'fertig') setStatus(o, o.status === 'neu' ? 'in_arbeit' : 'fertig'); };
const goBack = (o) => setStatus(o, o.status === 'fertig' ? 'in_arbeit' : 'neu');
const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

function orderCard(o, mode) {
  const kitchen = mode === 'kueche';
  const cls = ['card', 's-' + o.status, isLate(o) && 'late', kitchen && 'tap', kitchen && o.status === 'neu' && 'fresh', o.picked_up_at && 'picked'];
  const acts = kitchen ? [
    o.status === 'fertig' && el('button', { class: 'primary small', onclick: stop(() => setPickedUp(o, true)) }, 'Abgeholt ✓'),
    o.status !== 'neu' && el('button', { class: 'ghost small', onclick: stop(() => goBack(o)) }, '↩ Zurück'),
  ] : mode === 'kellner' ? [
    el('button', { class: 'pay small' + (o.paid_at ? ' on' : o.status === 'fertig' && !o.picked_up_at ? ' due' : ''), onclick: () => togglePaid(o) }, o.paid_at ? '✓ Bezahlt' : 'Bezahlt'),
    o.picked_up_at ? el('button', { class: 'ghost small', onclick: () => setPickedUp(o, false) }, '↩ Zurück')
      : el('button', { class: 'primary small', onclick: () => (o.status === 'fertig' ? setPickedUp(o, true) : startEdit(o)) }, o.status === 'fertig' ? 'Abgeholt' : 'Bearbeiten'),
  ] : [];
  const times = mode === 'admin' ? [o.started_at && 'gestartet ' + hm(o.started_at), o.ready_at && 'fertig ' + hm(o.ready_at),
    o.picked_up_at && 'abgeholt ' + hm(o.picked_up_at), o.paid_at ? 'bezahlt ' + hm(o.paid_at) : 'nicht bezahlt'] : [];
  return el('article', { class: cls.filter(Boolean).join(' '), onclick: kitchen ? () => advance(o) : null },
    el('div', { class: 'card-head' }, el('span', { class: 'no' }, '#' + o.daily_no), el('span', { class: 'pick' }, pickupLabel(o))),
    el('div', { class: 'meta' }, [o.customer_name, o.customer_phone, SOURCE[o.source], 'bestellt ' + hm(o.created_at)].filter(Boolean).join(' · ')),
    changed(o) && el('div', { class: 'chg' }, 'GEÄNDERT',
      kitchen && el('button', { onclick: stop(() => ackChange(o)) }, 'Gesehen ✓')),
    el('ul', { class: 'items' }, o.items.map((i) => el('li', {}, el('b', {}, i.qty + '×'), ' ' + i.name, i.note && el('em', {}, ' – ' + i.note)))),
    o.note && el('div', { class: 'onote' }, 'Notiz: ' + o.note),
    el('div', { class: 'card-foot' },
      el('span', { class: 'pill' }, o.picked_up_at ? 'Abgeholt' : STATUS[o.status]),
      !kitchen && el('span', {}, eur(o.total_cents)),
      kitchen && o.status === 'fertig' && el('span', { class: o.paid_at ? 'ok' : 'warn' }, o.paid_at ? '✓ Bezahlt' : 'Nicht bezahlt'),
      times.filter(Boolean).map((t) => el('span', { class: 'meta' }, t)),
      kitchen && o.status !== 'fertig' && el('span', { class: 'hint' }, 'Tippen: ' + (o.status === 'neu' ? 'In Zubereitung' : 'Fertig')),
      acts.some(Boolean) && el('span', { class: 'acts' }, acts)));
}

/* ---------- 7. Kellner ---------- */
const qtyOf = (name) => (S.cart.find((l) => l.name === name) || { qty: 0 }).qty;
function chg(name, price, d) {
  let l = S.cart.find((x) => x.name === name);
  if (!l && d > 0) S.cart.push(l = { name, price, qty: 0, note: '' });
  if (!l) return;
  l.qty += d;
  if (l.qty <= 0) S.cart = S.cart.filter((x) => x !== l);
  save();
}
const cartCount = () => S.cart.reduce((n, l) => n + l.qty, 0);
const cartTotal = () => S.cart.reduce((n, l) => n + l.qty * l.price, 0);

function editBanner() {
  return S.editId && el('div', { class: 'banner' }, 'Bestellung wird bearbeitet',
    el('button', { class: 'ghost', onclick: () => { S.cart = []; S.form = newForm(); S.editId = null; save(); route(); } }, 'Abbrechen'));
}

function openCat(i) { S.cat = i; viewMenu(); window.scrollTo(0, 0); }   // null = Kategorie-Übersicht

function viewMenu() {
  const cat = S.cat == null ? null : MENU[S.cat];
  const items = (c) => el('div', { class: 'tiles' }, c.items.map((it) => {
    const q = qtyOf(it.name);
    return el('div', { class: 'tile' + (q ? ' on' : '') },
      el('button', { class: 'tile-add', onclick: () => { chg(it.name, it.price, 1); viewMenu(); } },
        el('span', { class: 'tn' }, it.name), el('span', { class: 'tp' }, eur(it.price))),
      q > 0 && el('div', { class: 'tile-q' }, el('button', { onclick: () => { chg(it.name, it.price, -1); viewMenu(); } }, '−'), el('b', {}, q)));
  }));
  const cats = () => el('div', { class: 'tiles' }, MENU.map((c, i) => {
    const n = c.items.reduce((s, it) => s + qtyOf(it.name), 0);
    return el('button', { class: 'cat' + (n ? ' on' : ''), onclick: () => openCat(i) },
      el('span', { class: 'tn' }, c.cat), el('span', { class: 'tp' }, `${c.items.length} ${c.items.length === 1 ? 'Gericht' : 'Gerichte'}`), n > 0 && el('b', { class: 'badge' }, n));
  }));
  shell('Menü', [
    editBanner(),
    cat && el('div', { class: 'catbar' }, el('button', { onclick: () => openCat(null) }, '← Kategorien'), el('h1', {}, cat.cat)),
    cat ? items(cat) : cats(),
    el('div', { class: 'bottombar' },
      el('span', {}, `${cartCount()} Artikel · ${eur(cartTotal())}`),
      el('button', { class: 'primary', disabled: !cartCount(), onclick: () => { location.hash = '#/abschluss'; } }, 'Weiter →')),
  ]);
}

function quickTimes() {                         // nächste 4 Viertelstunden (frühestens in 15 Min)
  const t = new Date(Date.now() + 15 * 60000); t.setSeconds(0, 0);
  t.setMinutes(Math.ceil(t.getMinutes() / 15) * 15);
  return [0, 1, 2, 3].map((i) => new Date(t.getTime() + i * 15 * 60000));
}

function viewAbschluss() {
  if (!S.cart.length) { location.hash = '#/menu'; return; }
  const f = S.form;
  const bind = (key, props) => el('input', { ...props, value: f[key] || '', oninput: (e) => { f[key] = e.target.value; save(); } });
  const err = el('p', { class: 'error' });
  const redraw = () => { save(); viewAbschluss(); };
  const sendBtn = el('button', { class: 'primary big', onclick: () => send(sendBtn, err) }, S.editId ? 'Änderung senden' : 'Bestellung senden');

  shell('Bestellung abschließen', [
    editBanner(),
    el('section', {}, el('h2', {}, 'Artikel'),
      S.cart.map((l) => el('div', { class: 'line' },
        el('div', { class: 'line-top' }, el('span', {}, l.name),
          el('span', { class: 'stepper' },
            el('button', { onclick: () => { chg(l.name, l.price, -1); if (S.cart.length) viewAbschluss(); else location.hash = '#/menu'; } }, '−'),
            el('b', {}, l.qty),
            el('button', { onclick: () => { chg(l.name, l.price, 1); viewAbschluss(); } }, '+')),
          el('span', { class: 'price' }, eur(l.qty * l.price))),
        el('input', { placeholder: 'Notiz (z. B. ohne Zwiebeln)', value: l.note || '', oninput: (e) => { l.note = e.target.value; save(); } }))),
      el('p', { class: 'total' }, 'Summe: ', el('b', {}, eur(cartTotal())))),
    el('section', {}, el('h2', {}, 'Abholungszeit'),
      el('div', { class: 'chips wrap' },
        el('button', { class: f.asap ? 'on' : '', onclick: () => { f.asap = true; redraw(); } }, 'Ab sofort'),
        quickTimes().map((d) => el('button', { class: !f.asap && f.time === hm(d) && f.date === dayStr(d) ? 'on' : '', onclick: () => { f.asap = false; f.date = dayStr(d); f.time = hm(d); redraw(); } }, hm(d)))),
      el('div', { class: 'row' },
        el('input', { type: 'date', value: f.date, oninput: (e) => { f.date = e.target.value; f.asap = false; save(); } }),
        el('input', { type: 'time', value: f.time, oninput: (e) => { f.time = e.target.value; f.asap = false; save(); }, onchange: () => viewAbschluss() }))),
    el('section', {}, el('h2', {}, 'Kunde (freiwillig)'),
      bind('name', { placeholder: 'Name', autocomplete: 'off' }),
      bind('phone', { placeholder: 'Telefon', type: 'tel', autocomplete: 'off' }),
      bind('note', { placeholder: 'Bemerkung zur Bestellung', autocomplete: 'off' })),
    el('section', {}, el('h2', {}, 'Bestellung über'),
      el('div', { class: 'chips wrap' }, Object.entries(SOURCE).map(([k, t]) => el('button', { class: f.source === k ? 'on' : '', onclick: () => { f.source = k; redraw(); } }, t)))),
    err, sendBtn,
    el('button', { class: 'ghost block', onclick: () => { location.hash = '#/menu'; } }, '← Zurück zum Menü'),
  ]);
}

async function send(btn, err) {
  const f = S.form; err.textContent = '';
  let pickup = null;
  if (!f.asap) {
    if (!f.date || !f.time) { err.textContent = 'Bitte eine Abholzeit wählen oder „Ab sofort“.'; return; }
    pickup = new Date(`${f.date}T${f.time}`).toISOString();
  }
  const payload = {
    pickup_at: pickup, customer_name: f.name.trim() || null, customer_phone: f.phone.trim() || null,
    note: f.note.trim() || null, source: f.source, total_cents: cartTotal(),
    items: S.cart.map((l) => ({ name: l.name, qty: l.qty, price_cents: l.price, note: (l.note || '').trim() })),
  };
  btn.disabled = true;
  const q = S.editId ? sb.from('orders').update(payload).eq('id', S.editId) : sb.from('orders').insert(payload);
  const { data, error } = await q.select().single();
  btn.disabled = false;
  if (error) {                                   // Warenkorb bleibt erhalten
    err.textContent = /fertig/.test(error.message) ? 'Diese Bestellung ist schon fertig und kann nicht mehr geändert werden.'
      : 'Senden fehlgeschlagen. Bitte Verbindung prüfen und erneut senden.';
    return;
  }
  toast(`Bestellung #${data.daily_no} ${S.editId ? 'geändert' : 'gesendet'}`);
  S.cart = []; S.form = newForm(); S.editId = null; S.cat = null; save();
  location.hash = '#/uebersicht';
}

function startEdit(o) {
  if (S.cart.length && !S.editId && !confirm('Der aktuelle Warenkorb wird ersetzt. Fortfahren?')) return;
  const d = o.pickup_at ? new Date(o.pickup_at) : null;
  S.cart = o.items.map((i) => ({ name: i.name, price: i.price_cents, qty: i.qty, note: i.note || '' }));
  S.form = { asap: !d, date: dayStr(d || new Date()), time: d ? hm(d) : '', name: o.customer_name || '', phone: o.customer_phone || '', note: o.note || '', source: o.source };
  S.editId = o.id; S.cat = null; save();
  location.hash = '#/menu';
}

function viewUebersicht() {
  shell('Übersicht', el('div', { id: 'list' }));
  startLive(() => {
    const box = $('#list'); if (!box) return;
    const all = [...live.map.values()];
    const by = (f, cmp) => all.filter(f).sort(cmp).map((o) => orderCard(o, 'kellner'));
    const open = by((o) => o.status !== 'fertig', (a, b) => sortKey(a) - sortKey(b));
    const ready = by((o) => o.status === 'fertig' && !o.picked_up_at, (a, b) => new Date(a.ready_at) - new Date(b.ready_at));
    const picked = by((o) => o.picked_up_at, (a, b) => new Date(b.picked_up_at) - new Date(a.picked_up_at));
    fill(box,
      el('h2', {}, `Offen (${open.length})`), open.length ? open : el('p', { class: 'empty' }, 'Keine offenen Bestellungen'),
      ready.length > 0 && [el('h2', {}, `Fertig, wartet auf Abholung (${ready.length})`), ready],
      picked.length > 0 && el('details', { open: S.showPicked, ontoggle: (e) => { S.showPicked = e.target.open; } },
        el('summary', {}, `Abgeholt (${picked.length})`), picked));
  }, false);
}

/* ---------- 8. Küche ---------- */
function viewKueche() {
  shell('Küche', el('div', { id: 'board' }));
  if (!actx) {
    app.append(el('div', { class: 'overlay' }, el('button', { class: 'primary big', onclick: (e) => {
      enableSound(); beep('edit'); e.target.closest('.overlay').remove();
    } }, '🔔 Ton einschalten')));
  }
  startLive(() => {
    const b = $('#board'); if (!b) return;
    const all = [...live.map.values()];
    const cols = [['neu', 'Neu'], ['in_arbeit', 'In Zubereitung'], ['fertig', 'Fertig']];
    const of = (s) => all.filter((o) => o.status === s && !o.picked_up_at).sort(s === 'fertig' ? (a, c) => new Date(c.ready_at) - new Date(a.ready_at) : (a, c) => sortKey(a) - sortKey(c));
    b.replaceChildren(
      el('div', { class: 'tabs' }, cols.map(([s, t]) => el('button', { class: S.tab === s ? 'on' : '', onclick: () => { S.tab = s; live.render(); } }, `${t} (${of(s).length})`))),
      el('div', { class: 'cols' }, cols.map(([s, t]) => el('section', { class: 'col' + (S.tab === s ? ' active' : '') },
        el('h2', {}, `${t} (${of(s).length})`),
        of(s).length ? of(s).map((o) => orderCard(o, 'kueche')) : el('p', { class: 'empty' }, '–')))));
  }, true);
}

/* ---------- 9. Admin ---------- */
function viewAdmin() {
  const today = dayStr(new Date());
  const st = { from: today, to: today, q: '', rows: [] };
  const result = el('div', {});
  const draw = () => {
    const q = st.q.trim().toLowerCase();
    const rows = st.rows.filter((o) => !q || `#${o.daily_no} ${o.customer_name || ''} ${o.customer_phone || ''} ${o.note || ''} ${o.items.map((i) => i.name).join(' ')}`.toLowerCase().includes(q));
    fill(result,
      el('p', { class: 'total' }, `${rows.length} Bestellungen · Umsatz `, el('b', {}, eur(rows.reduce((n, o) => n + o.total_cents, 0)))),
      rows.length ? rows.map((o) => el('div', {}, el('p', { class: 'meta' }, new Date(o.created_at).toLocaleDateString('de-DE')), orderCard(o, 'admin')))
        : el('p', { class: 'empty' }, 'Keine Bestellungen in diesem Zeitraum'));
    result.rows = rows;
  };
  const run = async () => {
    const from = new Date(`${st.from}T00:00:00`), to = new Date(`${st.to}T00:00:00`);
    to.setDate(to.getDate() + 1);
    const { data, error } = await sb.from('orders').select('*')
      .gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).order('created_at', { ascending: false });
    if (error) return toast('Abfrage fehlgeschlagen.', true);
    st.rows = data; draw();
  };
  const date = (key) => el('input', { type: 'date', value: st[key], onchange: (e) => { st[key] = e.target.value; run(); } });
  shell('Admin', [
    el('section', {}, el('h2', {}, 'Bestellungen suchen'),
      el('div', { class: 'row' }, el('label', {}, 'Von', date('from')), el('label', {}, 'Bis', date('to'))),
      el('input', { type: 'search', placeholder: 'Suche: Name, Nummer, Artikel …', oninput: (e) => { st.q = e.target.value; draw(); } }),
      el('button', { class: 'primary', onclick: () => exportCsv(result.rows || []) }, 'CSV exportieren')),
    result,
  ]);
  run();
}

function exportCsv(rows) {
  const safe = (v) => { v = String(v ?? ''); return /^[=+\-@]/.test(v) ? "'" + v : v; };   // Schutz vor Excel-Formeln
  const head = ['Nr', 'Datum', 'Bestellt', 'Abholung', 'Name', 'Telefon', 'Quelle', 'Status', 'Artikel', 'Notiz', 'Summe EUR', 'Bezahlt', 'Abgeholt'];
  const lines = rows.map((o) => [
    o.daily_no, new Date(o.created_at).toLocaleDateString('de-DE'), hm(o.created_at),
    o.pickup_at ? new Date(o.pickup_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'Ab sofort',
    o.customer_name, o.customer_phone, SOURCE[o.source], STATUS[o.status],
    o.items.map((i) => `${i.qty}x ${i.name}${i.note ? ' (' + i.note + ')' : ''}`).join(' | '), o.note,
    (o.total_cents / 100).toFixed(2).replace('.', ','), o.paid_at ? 'Ja' : 'Nein', o.picked_up_at ? hm(o.picked_up_at) : '',
  ]);
  const text = [head, ...lines].map((r) => r.map((v) => `"${safe(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = el('a', { href: URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })), download: 'bestellungen.csv' });
  a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- Start ---------- */
// Netlify (Gratis-Tarif) blendet unten rechts ein "Powered by Netlify"-Feld ein. Dann Platz für die Buttons schaffen.
const badgeCheck = () => document.body.classList.toggle('has-badge', !!$('#nl-badge-frame'));
new MutationObserver(badgeCheck).observe(document.body, { childList: true });
badgeCheck();
window.addEventListener('hashchange', route);
sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT' && S.user) setSession(null); });
sb.auth.getSession().then(({ data }) => setSession(data.session));
setInterval(() => { if (live.render && !document.hidden) live.render(); }, 30000);  // Farben bei Verspätung aktualisieren
