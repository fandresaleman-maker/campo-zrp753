/* Campo ZRP 753 — app web sin conexión para tomar puntos en campo.
   Mapas, nombres de mineros y puntos tomados se guardan solo en el teléfono (IndexedDB). */
'use strict';
const CTM12 = '+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const aCTM = (lat, lon) => proj4('EPSG:4326', CTM12, [lon, lat]);           // -> [Este, Norte]
const distCTM = (a, b) => { const p = aCTM(a.lat, a.lng), q = aCTM(b.lat, b.lng); return Math.hypot(q[0] - p[0], q[1] - p[1]); };   // metros en el plano CTM12
const miles = v => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dec = (v, n) => v.toFixed(n).replace('.', ',');
const $ = id => document.getElementById(id);

/* ---------------- IndexedDB ---------------- */
let DB;
function abrirDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('campo-zrp753', 2);
    r.onupgradeneeded = () => {               // v2 agrega «trazos» (líneas y áreas) sin tocar lo que ya había
      const d = r.result;
      [['teselas'], ['meta'], ['puntos', { keyPath: 'id' }], ['trazos', { keyPath: 'id' }]].forEach(([n, o]) => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o); });
    };
    r.onsuccess = () => { DB = r.result; DB.onversionchange = () => { DB.close(); location.reload(); }; res(DB); };   // cede el paso a una versión nueva
    r.onblocked = () => { $('gpsLL').textContent = 'Actualizando: cierra las otras ventanas de la app'; };
    r.onerror = () => rej(r.error);
  });
}
function tx(store, modo, fn) {
  return new Promise((res, rej) => {
    const t = DB.transaction(store, modo); const s = t.objectStore(store); let out;
    const q = fn(s); if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const metaGet = k => tx('meta', 'readonly', s => s.get(k));
const metaSet = (k, v) => tx('meta', 'readwrite', s => s.put(v, k));
const teselaGet = k => tx('teselas', 'readonly', s => s.get(k));
const puntosTodos = () => tx('puntos', 'readonly', s => s.getAll());
const puntoGuardar = p => tx('puntos', 'readwrite', s => s.put(p));
const puntoBorrar = id => tx('puntos', 'readwrite', s => s.delete(id));
const trazosTodos = () => tx('trazos', 'readonly', s => s.getAll());
const trazoGuardar = t => tx('trazos', 'readwrite', s => s.put(t));
const trazoBorrar = id => tx('trazos', 'readwrite', s => s.delete(id));

/* ---------------- mapa ---------------- */
$('map').style.background = '#000';         // negro: el borde de las teselas de zoom bajo se funde con el fondo
const map = L.map('map', { zoomControl: false, attributionControl: false, preferCanvas: true, maxZoom: 20, tap: false,
  touchZoom: 'center', scrollWheelZoom: 'center', doubleClickZoom: 'center' });   // el zoom no corre la cruz
map.fitBounds([[7.636, -74.776], [7.679, -74.701]]);
const capaZRP = L.layerGroup().addTo(map), capaAreas = L.layerGroup().addTo(map), capaLineas = L.layerGroup().addTo(map), capaUPM = L.layerGroup().addTo(map),
      capaMios = L.layerGroup().addTo(map), capaMed = L.layerGroup().addTo(map);
let VER = { puntos: true, lineas: true, areas: true };   // qué se muestra de lo tomado en campo
const TODOS = 'Todos', SIN = '— Sin asignar —', OTRO = 'Otro minero o tercero';
let FILTRO = TODOS, EXTRA = [], PROX_P = 'P01', PROX_T = 'L01';
const pasaFiltro = r => FILTRO === TODOS || r.upm === FILTRO;
const rotulo = r => r.codigo ? r.codigo + (r.nombre ? ' · ' + r.nombre : '') : (r.nombre || '');   // consecutivo y nombre corto   // solo lo tomado en campo; los puntos de UPM de oficina siempre se ven
function aplicarVer() {
  [[capaMios, 'puntos'], [capaLineas, 'lineas'], [capaAreas, 'areas']].forEach(([c, k]) => { if (VER[k]) c.addTo(map); else map.removeLayer(c); });
  [...$('filtros').querySelectorAll('button')].forEach(b => b.classList.toggle('on', !!VER[b.dataset.v]));
}
function alternarVer(k) { VER[k] = !VER[k]; aplicarVer(); metaSet('ver', VER).catch(() => {}); }
let capaCeldas = null, ZRP = null, capaBase = null, CAPAS = [], PERSONAS = [];

async function teselaBuscar(id, z, x, y) {   // la tesela pedida o, si falta, la de un nivel menor que la contiene
  for (let d = 0; d <= 3; d++) { const b = await teselaGet(`${id}/${z - d}/${x >> d}/${y >> d}`); if (b) return { b, d }; }
  return null;
}
const TeselaIDB = L.GridLayer.extend({
  createTile(c, done) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    teselaBuscar(this.options.id, c.z, c.x, c.y).then(async r => {
      if (!r) { cv.style.visibility = 'hidden'; done(null, cv); return; }
      const im = await createImageBitmap(r.b), s = 256 >> r.d, k = (1 << r.d) - 1, g = cv.getContext('2d');
      g.imageSmoothingQuality = 'high'; g.drawImage(im, (c.x & k) * s, (c.y & k) * s, s, s, 0, 0, 256, 256);
      if (im.close) im.close(); done(null, cv);
    }).catch(() => done(null, cv));
    return cv;
  }
});

async function cargarZRP() {
  try { ZRP = await (await fetch('zrp753.geojson')).json(); } catch (e) { return; }
  capaZRP.clearLayers();
  L.geoJSON(ZRP, { style: { color: '#000', weight: 6, opacity: .45, fill: false }, interactive: false }).addTo(capaZRP);
  L.geoJSON(ZRP, { style: { color: '#F9B21A', weight: 3, fill: false }, interactive: false }).addTo(capaZRP);
}
function dentro(lon, lat, ring) {            // punto en polígono (rayo)
  let ok = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ok = !ok;
  }
  return ok;
}
function alternarCeldas() {
  if (capaCeldas) { map.removeLayer(capaCeldas); capaCeldas = null; $('bCeldas').textContent = 'Mostrar celdas'; return; }
  if (!ZRP) return;
  const ring = ZRP.features[0].geometry.coordinates[0]; capaCeldas = L.layerGroup();
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  for (let lo = Math.floor(Math.min(...xs) * 1000) / 1000; lo < Math.max(...xs); lo = Math.round((lo + .001) * 1000) / 1000)
    for (let la = Math.floor(Math.min(...ys) * 1000) / 1000; la < Math.max(...ys); la = Math.round((la + .001) * 1000) / 1000)
      if (dentro(lo + .0005, la + .0005, ring))
        L.rectangle([[la, lo], [la + .001, lo + .001]], { color: '#fff', weight: .6, opacity: .7, fill: false, interactive: false }).addTo(capaCeldas);
  capaCeldas.addTo(map); $('bCeldas').textContent = 'Ocultar celdas';
}

async function cargarCapas() {
  const meta = await metaGet('capas'); CAPAS = meta || [];
  PERSONAS = (await metaGet('personas')) || [];
  const cont = $('capas'); cont.innerHTML = '';
  CAPAS.forEach((c, i) => {
    const b = document.createElement('button'); b.textContent = c.boton || c.id; b.onclick = () => verCapa(i); cont.appendChild(b);
  });
  const ir = document.createElement('button'); ir.textContent = 'Ir a ZRP'; ir.onclick = irZRP; ir.className = 'herr';
  Object.assign(ir.style, { marginTop: '8px', background: 'rgba(11,47,124,.92)', borderColor: '#F9B21A', color: '#fff' });
  cont.appendChild(ir);
  if (CAPAS.length) verCapa(0); else { $('fecha').style.display = 'block'; $('fecha').textContent = 'Sin mapas: carga el paquete en ⚙ Datos'; }
  pintarUPM(await metaGet('upm') || []);
  llenarUPM(); aplicarVer();
}
function irZRP() {                          // lleva el mapa a la ZRP desde donde esté
  seguir(false);
  const b = ZRP ? L.geoJSON(ZRP).getBounds() : L.latLngBounds([[7.641, -74.770], [7.673, -74.707]]);
  map.setView(b.getCenter(), Math.max(13, map.getBoundsZoom(b, false, L.point(16, 230))));
}
function verCapa(i) {
  if (capaBase) map.removeLayer(capaBase);
  const c = CAPAS[i];
  capaBase = new TeselaIDB({ id: c.id, minZoom: 10, maxZoom: 20, minNativeZoom: c.minzoom, maxNativeZoom: c.maxzoom, tileSize: 256 }).addTo(map);
  capaBase.bringToBack();
  [...$('capas').children].forEach((b, k) => b.classList.toggle('on', k === i && !b.classList.contains('herr')));
  $('fecha').style.display = 'block'; $('fecha').textContent = c.nombre;
}
// color de cada minero: el de sus puntos de oficina; a los que se sumen en campo se les asigna uno de esta paleta
let COLORES = {};
const PALETA = ['#FFD600', '#F06292', '#9575CD', '#4DB6AC', '#FF8A65', '#AED581', '#90A4AE'];
function colorDe(nombre) {
  if (!nombre || nombre === SIN || nombre === OTRO) return null;
  if (COLORES[nombre]) return COLORES[nombre];
  let h = 0; for (const ch of nombre) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETA[h % PALETA.length];
}
function oscuro(hex, f = 0.62) {              // mismo color, más oscuro: los puntos de campo se distinguen del punto inicial
  const n = parseInt(hex.slice(1), 16), c = k => Math.round(((n >> k) & 255) * f).toString(16).padStart(2, '0');
  return '#' + c(16) + c(8) + c(0);
}
function pintarUPM(upm) {
  COLORES = {}; upm.forEach(u => { if (u.persona && u.color && !COLORES[u.persona]) COLORES[u.persona] = u.color; });
  capaUPM.clearLayers();
  upm.forEach(u => {
    let m;
    if (u.tipo === 'ga') {
      m = L.marker([u.lat, u.lon], { icon: L.divIcon({ className: '', iconSize: [18, 16], iconAnchor: [9, 11],
        html: `<svg width="18" height="16"><polygon points="9,1 17,15 1,15" fill="#fff" stroke="#111" stroke-width="1.2"/><polygon points="9,6 13,13 5,13" fill="${u.color}"/></svg>` }), keyboard: false });
      m.on('click', e => tocar(e, () => fichaUPM(u), true));
    } else {
      m = L.circleMarker([u.lat, u.lon], { radius: 6, color: '#111', weight: 1.5, fillColor: u.color, fillOpacity: 1 });
      m.on('click', e => tocar(e, () => fichaUPM(u), false));
    }
    m.addTo(capaUPM); etiqueta([u.lat, u.lon], u.rotulo, 'der fina', () => fichaUPM(u)).addTo(capaUPM);
  });
}
function llenarUPM() {                      // listas de mineros: los del paquete más los que se sumen en campo
  const nombres = [...PERSONAS, ...EXTRA.filter(n => !PERSONAS.includes(n))];
  const llenar = (id, ops) => { const s = $(id), v = s.value; s.innerHTML = '';
    ops.forEach(n => { const o = document.createElement('option'); o.textContent = n; s.appendChild(o); }); if (ops.includes(v)) s.value = v; };
  llenar('fUpm', [SIN, ...nombres, OTRO]); llenar('tUpm', [SIN, ...nombres, OTRO]); llenar('eUpm', [SIN, ...nombres, OTRO]); llenar('fMinero', [TODOS, ...nombres, SIN]);
  $('fMinero').value = FILTRO;
}
async function otroMinero(sel) {             // pide el nombre del otro minero o tercero y lo suma al listado
  if (sel.value !== OTRO) return;
  const n = (prompt('Nombre del otro minero o tercero:') || '').trim();
  if (!n) { sel.value = SIN; return; }
  if (!PERSONAS.includes(n) && !EXTRA.includes(n)) { EXTRA.push(n); await metaSet('personasExtra', EXTRA.filter(x => !PERSONAS.includes(x))); }
  llenarUPM(); sel.value = n;
}
async function siguiente(pref) {             // consecutivo propio de cada tipo (P01, L01, A01…): no se reutiliza mientras quede alguno;
  const regs = pref === 'P' ? await puntosTodos() : (await trazosTodos()).filter(t => (t.tipo === 'area' ? 'A' : 'L') === pref);
  const c = (await metaGet('consecutivos')) || {};
  if (!regs.length) { c[pref] = 0; await metaSet('consecutivos', c); return pref + '01'; }   // si se borraron todos, vuelve a 01
  const max = Math.max(0, ...regs.map(r => new RegExp('^' + pref + '(\\d+)$').exec(r.codigo || r.nombre || '')).filter(Boolean).map(m => +m[1]));
  return pref + String(Math.max(c[pref] || 0, max) + 1).padStart(2, '0');
}
async function gastar(nombre) { const c = (await metaGet('consecutivos')) || {}; c[nombre[0]] = Math.max(c[nombre[0]] || 0, +nombre.slice(1)); await metaSet('consecutivos', c); }

/* ---------------- GPS ---------------- */
let POS = null, marcaYo = null, circYo = null, centrado = false, watchId = null, SEGUIR = false;
function seguir(on) { SEGUIR = on; $('bCentrar').classList.toggle('on', on); actualizarMira(); }
const ROSA = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
function rumbo(a, b) {                       // grados desde el norte, de a hacia b
  const f1 = a.lat * Math.PI / 180, f2 = b.lat * Math.PI / 180, dl = (b.lng - a.lng) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}
const rumboTxt = g => `${Math.round(g) % 360}° ${ROSA[Math.round(g / 45) % 8]}`;
const distTxt = m => m < 1000 ? `${Math.round(m)} m` : `${dec(m / 1000, 2)} km`;
function actualizarMira() {
  const m = $('mira');
  if (SEGUIR && POS) { m.innerHTML = '<b>✛</b> La cruz está en tu posición: el punto toma tu GPS exacto'; return; }
  const c = map.getCenter(), [E, N] = aCTM(c.lat, c.lng);
  m.innerHTML = `<b>✛ Cruz</b> E ${miles(E)} · N ${miles(N)}` +
    (POS ? `<br>a ${distTxt(distCTM(L.latLng(POS.lat, POS.lon), c))} de ti · rumbo ${rumboTxt(rumbo(L.latLng(POS.lat, POS.lon), c))}` : '');
}
function enPos(p) {
  const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
  POS = { lat, lon, acc, t: Date.now() };
  const [E, N] = aCTM(lat, lon);
  $('gpsEN').innerHTML = `<span>E</span>${miles(E)}<span>N</span>${miles(N)}`;
  const cls = acc <= 5 ? 'ok' : acc <= 15 ? 'mid' : 'bad';
  $('gpsLL').innerHTML = `<i>Lat, Lon</i>${dec(lat, 6)}, ${dec(lon, 6)} <span class="acc ${cls}">±${Math.round(acc)} m</span>`;
  if (!marcaYo) {
    marcaYo = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="yo"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    circYo = L.circle([lat, lon], { radius: acc, color: '#1a73e8', weight: 1, fillOpacity: .12, interactive: false }).addTo(map);
  } else { marcaYo.setLatLng([lat, lon]); circYo.setLatLng([lat, lon]).setRadius(acc); }
  if (!centrado) { centrado = true; map.setView([lat, lon], Math.max(map.getZoom(), 16)); seguir(true); }
  else if (SEGUIR) map.panTo([lat, lon], { animate: false });
  actualizarMira(); textoMed();
  if ($('pPunto').classList.contains('abierto')) mostrarPosicionPunto();
}
function enError(e) {
  const msg = e.code === 1 ? 'Ubicación no permitida. Actívala en Ajustes › Privacidad › Localización › Safari (Mientras se usa, ubicación exacta).'
            : 'Sin señal GPS todavía. Sal a cielo abierto y espera unos segundos.';
  $('gpsEN').textContent = 'GPS no disponible'; $('gpsLL').textContent = msg;
}
function iniciarGPS() {
  if (!('geolocation' in navigator)) { enError({ code: 2 }); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(enPos, enError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

/* ---------------- puntos ---------------- */
let ORIGEN = 'gps';
function avisar(t, ms = 2600) { const a = $('aviso'); a.textContent = t; a.style.display = 'block'; clearTimeout(a._t); a._t = setTimeout(() => a.style.display = 'none', ms); }
function abrir(id) { document.querySelectorAll('.panel').forEach(p => p.classList.remove('abierto')); if (id) $(id).classList.add('abierto'); }
function posicionActual() {
  if (ORIGEN === 'mapa') { const c = map.getCenter(); return { lat: c.lat, lon: c.lng, acc: null, origen: 'cruz del mapa' }; }
  if (!POS) return null;
  return { lat: POS.lat, lon: POS.lon, acc: POS.acc, origen: 'GPS' };
}
function mostrarPosicionPunto() {
  const p = posicionActual(); const c = $('pPosicion');
  if (!p) { c.innerHTML = 'Sin posición GPS. Espera la señal o usa «En la cruz del mapa».'; return; }
  const [E, N] = aCTM(p.lat, p.lon);
  const lejos = p.acc == null && POS ? ` · a ${distTxt(distCTM(L.latLng(POS.lat, POS.lon), L.latLng(p.lat, p.lon)))} de ti` : '';
  c.innerHTML = `<b>E</b> ${miles(E)} &nbsp; <b>N</b> ${miles(N)}<br>${dec(p.lat, 6)}, ${dec(p.lon, 6)}` + (p.acc != null ? ` · ±${Math.round(p.acc)} m (GPS)` : ' · en la cruz' + lejos);
}
async function abrirNuevoPunto() {
  PROX_P = await siguiente('P'); $('fNombre').textContent = PROX_P; $('fCorto').value = ''; $('fNota').value = '';
  if (FILTRO !== TODOS) $('fUpm').value = FILTRO;
  abrir('pPunto'); ponerOrigen(SEGUIR && POS ? 'gps' : 'mapa');
}
function ponerOrigen(o) {
  ORIGEN = o; [...$('segOrigen').children].forEach(b => b.classList.toggle('on', b.dataset.o === o));
  $('filaProm').style.display = o === 'mapa' ? 'none' : 'flex'; mostrarPosicionPunto();
}
async function guardarPunto(p) {
  if (!p) { avisar('No hay posición para guardar'); return; }
  const [E, N] = aCTM(p.lat, p.lon); const ahora = new Date();
  const reg = { id: ahora.getTime().toString(36) + Math.random().toString(36).slice(2, 6), codigo: PROX_P, nombre: $('fCorto').value.trim(),
    upm: $('fUpm').value, nota: $('fNota').value.trim(), fecha: ahora.toISOString(), local: fechaLocal(ahora),
    lat: +p.lat.toFixed(7), lon: +p.lon.toFixed(7), precision: p.acc != null ? Math.round(p.acc * 10) / 10 : null,
    este: Math.round(E), norte: Math.round(N), origen: p.origen, muestras: p.muestras || 1 };
  await puntoGuardar(reg); await gastar(reg.codigo); abrir(null); await pintarMios(); avisar(`Guardado ${rotulo(reg)} · E ${miles(E)} N ${miles(N)}`);
}
function fechaLocal(d) { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; }
function promediar() {
  if (!POS) { avisar('Espera la señal GPS para promediar'); return; }
  const b = $('bPromedio'); const muestras = []; let s = 10; b.disabled = true;
  const id = navigator.geolocation.watchPosition(p => muestras.push(p.coords), () => {}, { enableHighAccuracy: true, maximumAge: 0 });
  const tick = setInterval(() => { s--; b.textContent = `Promediando… ${s} s (${muestras.length} lecturas)`;
    if (s <= 0) {
      clearInterval(tick); navigator.geolocation.clearWatch(id); b.disabled = false; b.textContent = 'Promediar 10 s y guardar';
      if (!muestras.length) { avisar('No llegaron lecturas; guarda sin promediar'); return; }
      let w = 0, la = 0, lo = 0; muestras.forEach(c => { const k = 1 / Math.max(c.accuracy, 1) ** 2; w += k; la += c.latitude * k; lo += c.longitude * k; });
      const accs = muestras.map(c => c.accuracy).sort((x, y) => x - y);
      guardarPunto({ lat: la / w, lon: lo / w, acc: accs[Math.floor(accs.length / 2)], origen: 'GPS promediado', muestras: muestras.length });
    } }, 1000);
}
async function pintarMios() {
  const pts = (await puntosTodos()).filter(pasaFiltro); capaMios.clearLayers(); contar();
  pts.forEach(p => {
    L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2.5, fillColor: colorDe(p.upm) ? oscuro(colorDe(p.upm)) : '#C10617', fillOpacity: 1 })
      .on('click', e => tocar(e, () => fichaPunto(p), false)).addTo(capaMios);
    etiqueta([p.lat, p.lon], rotulo(p), 'der amar', () => fichaPunto(p)).addTo(capaMios);
  });
}
async function abrirLista() {
  const pts = (await puntosTodos()).filter(pasaFiltro).sort((a, b) => a.fecha < b.fecha ? 1 : -1); const l = $('lista'); l.innerHTML = '';
  const ts = (await trazosTodos()).filter(pasaFiltro).sort((a, b) => a.fecha < b.fecha ? 1 : -1);
  $('listaFiltro').textContent = FILTRO === TODOS ? 'Todo lo tomado en campo.' : `Solo lo de: ${FILTRO}. Cambia el minero en la barra de abajo para ver lo demás.`;
  if (!pts.length && !ts.length) l.innerHTML = '<p class="nota">Todavía no hay nada guardado.</p>';
  ts.forEach(t => {
    const REG = t, REG_TIPO = 'trazos';
    const d = document.createElement('div'); d.className = 'item';
    const med = t.tipo === 'area' ? `${haTxt(t.area_m2)} · perímetro ${distTxt(t.longitud_m)} · ${t.vertices.length} vértices` : `${distTxt(t.longitud_m)} · ${t.tramos_m.length} tramo(s)`;
    d.innerHTML = `<div class="t"><b>${esc(rotulo(t))}</b> · ${t.tipo === 'area' ? 'Área' : 'Línea'} · ${esc(t.que)}${t.medicion ? ' · ' + esc(t.medicion) : ''}<br>${med} · ${esc(t.upm)}<br><span class="nota">${esc(t.local)}${t.nota ? ' · ' + esc(t.nota) : ''}</span></div>`;
    const v = document.createElement('button'); v.textContent = 'Ver';
    v.onclick = () => { abrir(null); seguir(false); const k = t.tipo === 'area' ? 'areas' : 'lineas'; if (!VER[k]) alternarVer(k);
      map.fitBounds(L.latLngBounds(t.vertices), { paddingTopLeft: [20, 170], paddingBottomRight: [110, 130], maxZoom: 19 }); };
    const x = document.createElement('button'); x.textContent = 'Borrar'; x.className = 'borrar';
    x.onclick = async () => { if (confirm(`¿Borrar ${rotulo(t)}? No se puede deshacer.`)) { await trazoBorrar(t.id); await pintarTrazos(); abrirLista(); } };
    const e = document.createElement('button'); e.textContent = 'Editar'; e.onclick = () => abrirEditar(REG_TIPO, REG);
    d.append(v, e, x); l.appendChild(d);
  });
  pts.forEach(p => {
    const REG = p, REG_TIPO = 'puntos';
    const d = document.createElement('div'); d.className = 'item';
    d.innerHTML = `<div class="t"><b>${esc(rotulo(p))}</b> · ${esc(p.upm)}<br>E ${miles(p.este)} · N ${miles(p.norte)}${p.precision != null ? ' · ±' + Math.round(p.precision) + ' m' : ''}<br><span class="nota">${esc(p.local)}${p.nota ? ' · ' + esc(p.nota) : ''}</span></div>`;
    const v = document.createElement('button'); v.textContent = 'Ver'; v.onclick = () => { abrir(null); seguir(false); map.setView([p.lat, p.lon], 18); };
    const x = document.createElement('button'); x.textContent = 'Borrar'; x.className = 'borrar';
    x.onclick = async () => { if (confirm(`¿Borrar ${rotulo(p)}? No se puede deshacer.`)) { await puntoBorrar(p.id); await pintarMios(); abrirLista(); } };
    const e = document.createElement('button'); e.textContent = 'Editar'; e.onclick = () => abrirEditar(REG_TIPO, REG);
    d.append(v, e, x); l.appendChild(d);
  });
  abrir('pLista');
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- medir, líneas y áreas ---------------- */
let MIDIENDO = false, CERRADA = false, VERT = [], guiaMed = null;
const haTxt = m2 => `${dec(m2 / 10000, 2)} ha`;
const centro = vs => L.latLng(vs.reduce((a, v) => a + v.lat, 0) / vs.length, vs.reduce((a, v) => a + v.lng, 0) / vs.length);
const mitad = (a, b) => L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
function etiqueta(ll, txt, cls = '', fn) {    // rótulo sobre el mapa; con fn, al tocarlo abre la ficha
  const m = L.marker(ll, { icon: L.divIcon({ className: 'etq ' + cls + (fn ? ' clic' : ''), html: `<span>${esc(txt)}</span>`, iconSize: [0, 0] }), interactive: !!fn, keyboard: false });
  if (fn) m.on('click', e => tocar(e, fn, true));
  return m;
}
function tocar(e, fn, esMarcador) {          // al tocar abre la ficha; si se está midiendo, el toque pone un punto de medición
  if (MIDIENDO) { if (esMarcador) medirAgregar(map.mouseEventToLatLng(e.originalEvent)); return; }
  fn();
}
function ficha(ll, html, editar, extra = []) {   // recuadro con los datos, sin ir al listado
  seguir(false);
  const d = document.createElement('div'); d.className = 'ficha'; d.innerHTML = html;
  [...(editar ? [['Editar', editar]] : []), ...extra].forEach(([t, f]) => {
    const b = document.createElement('button'); b.textContent = t; b.onclick = () => { map.closePopup(); f(); }; d.appendChild(b); });
  L.popup({ maxWidth: 270, autoPanPaddingTopLeft: L.point(10, 170), autoPanPaddingBottomRight: L.point(10, 150) }).setLatLng(ll).setContent(d).openOn(map);
}
const pie = r => `<br>${esc(r.local)}` + (r.nota ? `<br><i>${esc(r.nota)}</i>` : '') + (r.editado ? `<br><span class="nota">Editado ${esc(r.editado)}</span>` : '');
function fichaPunto(p) {
  ficha([p.lat, p.lon], `<b>${esc(rotulo(p))}</b><br>${esc(p.upm)}<br>E ${miles(p.este)} · N ${miles(p.norte)}<br>${dec(p.lat, 6)}, ${dec(p.lon, 6)}` +
    (p.precision != null ? ` · ±${Math.round(p.precision)} m` : '') + ` · ${esc(p.origen)}` + pie(p), () => abrirEditar('puntos', p, true));
}
function fichaTrazo(t, ll) {
  const med = t.tipo === 'area' ? `${haTxt(t.area_m2)} · perímetro ${distTxt(t.longitud_m)} · ${t.vertices.length} vértices` : `${distTxt(t.longitud_m)} · ${t.tramos_m.length} tramo(s)`;
  ficha(ll, `<b>${esc(rotulo(t))}</b><br>${t.tipo === 'area' ? 'Área' : 'Línea'} · ${esc(t.que)}${t.medicion ? ' · ' + esc(t.medicion) : ''}<br>${esc(t.upm)}<br>${med}<br>Tramos: ${t.tramos_m.map(distTxt).join(' · ')}` + pie(t),
    () => abrirEditar('trazos', t, true), t.tipo === 'area' ? [['Calcular anterioridad', () => abrirCalc(t)]] : []);
}
function fichaUPM(u) {
  const [E, N] = aCTM(u.lat, u.lon);
  ficha([u.lat, u.lon], `<b>${esc(u.persona)}</b><br>${esc(u.rotulo)}<br>${u.tipo === 'ga' ? 'Caracterización de la Gobernación de Antioquia' : 'Identificación ANM'}<br>E ${miles(E)} · N ${miles(N)}<br>${dec(u.lat, 6)}, ${dec(u.lon, 6)}`);
}
function medidas(vs, cerrada) {              // tramos, total y área, planos en CTM12 (Origen Nacional)
  const tramos = [];
  for (let i = 1; i < vs.length; i++) tramos.push(distCTM(vs[i - 1], vs[i]));
  if (cerrada && vs.length > 2) tramos.push(distCTM(vs[vs.length - 1], vs[0]));
  let area = 0;
  if (cerrada && vs.length > 2) {
    const p = vs.map(v => aCTM(v.lat, v.lng));
    for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; area += x1 * y2 - x2 * y1; }
    area = Math.abs(area) / 2;
  }
  return { tramos, total: tramos.reduce((a, b) => a + b, 0), area };
}
function medirAbrir() {
  MIDIENDO = true; CERRADA = false; VERT = []; abrir(null);
  $('pMedir').classList.add('abierto'); $('mira').style.display = 'none'; marcarArea(); pintarMed();
}
function medirFin(preguntar) {
  if (preguntar && VERT.length > 1 && !confirm('¿Salir sin guardar esta medición?')) return;
  MIDIENDO = false; VERT = []; capaMed.clearLayers(); if (guiaMed) { map.removeLayer(guiaMed); guiaMed = null; }
  $('pMedir').classList.remove('abierto'); $('mira').style.display = ''; actualizarMira();
}
function marcarArea() { const b = $('bMedArea'); b.classList.toggle('on', CERRADA); b.textContent = CERRADA ? 'Dejar como línea' : 'Cerrar área'; }
function medirAgregar(ll) { VERT.push(L.latLng(ll)); pintarMed(); }
function pintarMed() {
  capaMed.clearLayers();
  const area = CERRADA && VERT.length > 2, m = medidas(VERT, area);
  if (area) {
    L.polygon(VERT, { color: '#F9B21A', weight: 3, fillColor: '#F9B21A', fillOpacity: .15, interactive: false }).addTo(capaMed);
    etiqueta(centro(VERT), haTxt(m.area), 'grande').addTo(capaMed);
  } else if (VERT.length > 1) {
    L.polyline(VERT, { color: '#000', weight: 6, opacity: .4, interactive: false }).addTo(capaMed);
    L.polyline(VERT, { color: '#F9B21A', weight: 3, interactive: false }).addTo(capaMed);
  }
  m.tramos.forEach((d, i) => etiqueta(mitad(VERT[i], VERT[(i + 1) % VERT.length]), distTxt(d)).addTo(capaMed));
  VERT.forEach((v, i) => L.circleMarker(v, { radius: i ? 5 : 6, color: '#111', weight: 1.5, fillColor: i ? '#F9B21A' : '#fff', fillOpacity: 1, interactive: false }).addTo(capaMed));
  textoMed();
}
function textoMed() {                       // totales, último tramo y línea guía hasta la cruz
  if (!MIDIENDO) return;
  const c = map.getCenter(), area = CERRADA && VERT.length > 2, m = medidas(VERT, area);
  let h;
  if (area) h = `<b>${haTxt(m.area)}</b> · perímetro ${distTxt(m.total)} · ${VERT.length} vértices`;
  else {
    h = `<b>${distTxt(m.total)}</b> en total · ${m.tramos.length} tramo(s)`;
    if (CERRADA) h += '<br>Para cerrar un área hacen falta al menos 3 puntos.';
    else if (VERT.length > 1) { const p = VERT[VERT.length - 2], u = VERT[VERT.length - 1]; h += `<br>Último tramo: ${distTxt(m.tramos[m.tramos.length - 1])} · rumbo ${rumboTxt(rumbo(p, u))}`; }
  }
  if (VERT.length) {
    const u = VERT[VERT.length - 1];
    h += `<br>Del último punto a la cruz: ${distTxt(distCTM(u, c))} · rumbo ${rumboTxt(rumbo(u, c))}`;
    if (guiaMed) guiaMed.setLatLngs([u, c]); else guiaMed = L.polyline([u, c], { color: '#fff', weight: 2, dashArray: '6 6', interactive: false }).addTo(map);
  } else {
    h += '<br>Toca el mapa, o pon el primer punto en la cruz o en tu posición.';
    if (guiaMed) { map.removeLayer(guiaMed); guiaMed = null; }
  }
  $('medTxt').innerHTML = h;
}
const MEDICION = ['En campo (recorrida)', 'Sobre la imagen (no visitada)'], HUELLA = 'Huella en imagen anterior al corte';
const QUE = { area: ['Área', 'Frente de explotación', 'Área intervenida o removida', HUELLA, 'Entable o planta de beneficio', 'Piscina o sedimentador', 'Botadero o estéril', 'Campamento', 'Otro'],
              linea: ['Distancia entre puntos', 'Recorrido o acceso', 'Canal o drenaje', 'Frente lineal', 'Otro'] };   // el primero es el predeterminado
async function medirGuardar() {              // pregunta qué es antes de guardar
  const tipo = CERRADA ? 'area' : 'linea';
  if (VERT.length < (tipo === 'area' ? 3 : 2)) { avisar(tipo === 'area' ? 'Para un área hacen falta al menos 3 puntos' : 'Pon al menos 2 puntos'); return; }
  const m = medidas(VERT, tipo === 'area'); PROX_T = await siguiente(tipo === 'area' ? 'A' : 'L');
  $('tTitulo').innerHTML = (tipo === 'area' ? 'Guardar área ' : 'Guardar línea ') + `<span>${PROX_T}</span>`;
  $('tResumen').innerHTML = (tipo === 'area' ? `<b>Área:</b> ${haTxt(m.area)} · <b>Perímetro:</b> ${distTxt(m.total)} · ${VERT.length} vértices`
                                             : `<b>Longitud:</b> ${distTxt(m.total)} · ${m.tramos.length} tramo(s)`) + `<br>Tramos: ${m.tramos.map(distTxt).join(' · ')}`;
  $('tCorto').value = ''; $('tNota').value = ''; if (FILTRO !== TODOS) $('tUpm').value = FILTRO;
  const q = $('tQue'); q.innerHTML = ''; QUE[tipo].forEach(t => { const o = document.createElement('option'); o.textContent = t; q.appendChild(o); });
  abrir('pTrazo');
}
async function trazoConfirmar() {
  const tipo = CERRADA && VERT.length > 2 ? 'area' : 'linea', m = medidas(VERT, tipo === 'area'), ahora = new Date();
  const reg = { id: ahora.getTime().toString(36) + Math.random().toString(36).slice(2, 6), tipo, codigo: PROX_T, nombre: $('tCorto').value.trim(),
    que: $('tQue').value, medicion: $('tQue').value === HUELLA ? MEDICION[1] : $('tMed').value,
    upm: $('tUpm').value, nota: $('tNota').value.trim(), fecha: ahora.toISOString(), local: fechaLocal(ahora),
    vertices: VERT.map(v => [+v.lat.toFixed(7), +v.lng.toFixed(7)]), ctm: VERT.map(v => aCTM(v.lat, v.lng).map(Math.round)),
    tramos_m: m.tramos.map(d => Math.round(d * 10) / 10), longitud_m: Math.round(m.total * 10) / 10, area_m2: tipo === 'area' ? Math.round(m.area) : null };
  await trazoGuardar(reg); await gastar(reg.codigo); abrir(null); medirFin(false);
  const k = tipo === 'area' ? 'areas' : 'lineas'; if (!VER[k]) alternarVer(k);
  await pintarTrazos(); avisar(`Guardada ${rotulo(reg)} · ` + (tipo === 'area' ? haTxt(reg.area_m2) : distTxt(m.total)));
}
let EDIT = null;
function ponerValor(sel, v) {                // selecciona v aunque no esté en la lista (registros viejos)
  if (v && ![...sel.options].some(o => o.text === v)) { const o = document.createElement('option'); o.textContent = v; sel.insertBefore(o, sel.lastChild); }
  sel.value = v || SIN;
}
function abrirEditar(almacen, r, desdeMapa = false) {
  EDIT = { almacen, r, desdeMapa };
  $('eCodigo').textContent = r.codigo || r.nombre || '';
  $('eResumen').innerHTML = almacen === 'puntos' ? `<b>Punto</b> · E ${miles(r.este)} · N ${miles(r.norte)}${r.precision != null ? ' · ±' + Math.round(r.precision) + ' m' : ''}<br>${esc(r.local)}`
    : (r.tipo === 'area' ? `<b>Área</b> · ${haTxt(r.area_m2)} · perímetro ${distTxt(r.longitud_m)}` : `<b>Línea</b> · ${distTxt(r.longitud_m)} · ${r.tramos_m.length} tramo(s)`) + `<br>${esc(r.local)}`;
  $('eCorto').value = r.nombre || '';
  $('eQueFila').style.display = almacen === 'trazos' ? '' : 'none';
  if (almacen === 'trazos') { const q = $('eQue'); q.innerHTML = ''; QUE[r.tipo].forEach(t => { const o = document.createElement('option'); o.textContent = t; q.appendChild(o); }); if (r.que && !QUE[r.tipo].includes(r.que)) { const o = document.createElement('option'); o.textContent = r.que; q.appendChild(o); } q.value = r.que || QUE[r.tipo][0]; }
  $('eMedFila').style.display = almacen === 'trazos' ? '' : 'none';
  if (almacen === 'trazos') { const e = $('eMed'); e.innerHTML = ''; [...MEDICION, ...(r.medicion ? [] : ['— Sin dato —'])].forEach(t => { const o = document.createElement('option'); o.textContent = t; e.appendChild(o); }); e.value = r.medicion || '— Sin dato —'; }
  ponerValor($('eUpm'), r.upm); $('eNota').value = r.nota || '';
  abrir('pEditar');
}
async function guardarEdicion() {
  const { almacen, r } = EDIT;
  const nuevo = { ...r, nombre: $('eCorto').value.trim() || (r.codigo ? '' : r.nombre), upm: $('eUpm').value, nota: $('eNota').value.trim(), editado: fechaLocal(new Date()) };
  if (almacen === 'trazos') { nuevo.que = $('eQue').value; const md = nuevo.que === HUELLA ? MEDICION[1] : $('eMed').value; if (MEDICION.includes(md)) nuevo.medicion = md; }
  if (almacen === 'puntos') { await puntoGuardar(nuevo); await pintarMios(); } else { await trazoGuardar(nuevo); await pintarTrazos(); }
  avisar(`Editado ${rotulo(nuevo)}`); if (EDIT.desdeMapa) abrir(null); else abrirLista();
}
/* ---------------- cambio en Sentinel-2 (mismo sensor, 2023 frente a 2026) ---------------- */
let SENT = null;
async function cargarSentinel() {            // grilla de 10 m: valor/17 = bit0 válido 2023, bit1 intervenido 2023, bit2 válido 2026, bit3 intervenido 2026
  if (SENT) return SENT;
  const meta = await (await fetch('sentinel_cambio.json')).json();
  const img = new Image(); await new Promise((ok, mal) => { img.onload = ok; img.onerror = mal; img.src = 'sentinel_cambio.png'; });
  const cv = document.createElement('canvas'); cv.width = meta.w; cv.height = meta.h;
  const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, meta.w, meta.h).data, cod = new Uint8Array(meta.w * meta.h);
  for (let i = 0; i < cod.length; i++) cod[i] = Math.round(px[i * 4] / 17);
  SENT = { meta, cod }; return SENT;
}
function cambioSentinel(S, polys) {          // polys: listas de [lat, lon]; cuenta cada píxel una sola vez
  const { lon0, lat1, d, w, h } = S.meta, vistos = new Set();
  let n = 0, v = 0, b26 = 0, b23 = 0, ambos = 0, solo23 = 0;
  polys.forEach(p => {
    const ring = p.map(([la, lo]) => [lo, la]);
    const x0 = Math.max(0, Math.floor((Math.min(...ring.map(q => q[0])) - lon0) / d)), x1 = Math.min(w - 1, Math.ceil((Math.max(...ring.map(q => q[0])) - lon0) / d));
    const y0 = Math.max(0, Math.floor((lat1 - Math.max(...ring.map(q => q[1]))) / d)), y1 = Math.min(h - 1, Math.ceil((lat1 - Math.min(...ring.map(q => q[1]))) / d));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = y * w + x; if (vistos.has(k)) continue;
      if (!dentro(lon0 + (x + 0.5) * d, lat1 - (y + 0.5) * d, ring)) continue;
      vistos.add(k); n++; const c = S.cod[k];
      if (!((c & 1) && (c & 4))) continue;      // solo píxeles válidos en las dos fechas
      v++; const i23 = (c & 2) > 0, i26 = (c & 8) > 0;
      if (i26) b26++; if (i23) b23++; if (i23 && i26) ambos++; if (i23 && !i26) solo23++;
    }
  });
  const celda = (d * 111320 * Math.cos(7.656 * Math.PI / 180)) * (d * 110574) / 10000;   // ha por píxel
  return { n, v, r: b26 > 0 ? ambos / b26 : null, ha26: b26 * celda, ha23: b23 * celda, haAmbos: ambos * celda, haSolo23: solo23 * celda, f23: S.meta.fecha2023, f26: S.meta.fecha2026 };
}

/* ---------------- calculadora de anterioridad ---------------- */
const CAUDAL = { 2: 20, 3: 45, 4: 80, 6: 180, 8: 320 };   // m³/h de agua por motobomba según pulgadas: orden de magnitud
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const CAMPOS = ['cProf', 'cBombas', 'cPulg', 'cCaudal', 'cRel', 'cHoras', 'cDias', 'cParAnual', 'cParPost', 'cParPre', 'cManif', 'cInicio', 'cA1', 'cImg', 'cCorte', 'cVisita'];
let CALC = null, RESUMEN = '';
const hoyISO = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const num = id => parseFloat(String($(id).value).replace(',', '.')) || 0;
const paramsCalc = () => Object.fromEntries(['cArea', ...CAMPOS].map(id => [id, $(id).value]));
async function abrirCalc(trazo) {            // desde un área, o desde «Guardado» con la suma de las áreas del filtro
  CALC = { trazo: trazo || null };
  const base = { cProf: 4, cBombas: 1, cPulg: 4, cCaudal: 80, cRel: 15, cHoras: 8, cDias: 6, cParAnual: 1, cParPost: 0, cParPre: 0, cManif: '', cImg: '2023-07-12', cCorte: '2023-08-15' };
  const v = { ...base, ...((await metaGet('calcUltimo')) || {}), ...((trazo && trazo.calc && trazo.calc.params) || {}) };
  if (!(trazo && trazo.calc)) { v.cVisita = hoyISO(); v.cA1 = ''; v.cInicio = v.cInicio || ''; }
  CAMPOS.forEach(id => { $(id).value = v[id] ?? ''; });
  if (!$('cImg').value) $('cImg').value = '2023-07-12';
  const ha = m2 => dec(m2 / 10000, 2);
  let polys = [];
  if (trazo) { $('cArea').value = (trazo.area_m2 / 10000).toFixed(2); $('cOrigen').textContent = `${rotulo(trazo)} · ${trazo.upm}${trazo.medicion ? ' · ' + trazo.medicion : ''}`; if (trazo.que !== HUELLA) polys = [trazo.vertices]; }
  else {                                     // áreas del minero filtrado: las de hoy (campo + imagen) y aparte la huella anterior al corte
    const ts = (await trazosTodos()).filter(t => t.tipo === 'area' && pasaFiltro(t));
    const hoy = ts.filter(t => t.que !== HUELLA), hu = ts.filter(t => t.que === HUELLA), suma = l => l.reduce((a, t) => a + t.area_m2, 0);
    const campo = suma(hoy.filter(t => t.medicion === MEDICION[0])), img = suma(hoy.filter(t => t.medicion === MEDICION[1])), otro = suma(hoy) - campo - img;
    $('cArea').value = (suma(hoy) / 10000).toFixed(2); if (hu.length) $('cA1').value = (suma(hu) / 10000).toFixed(2); polys = hoy.map(t => t.vertices);
    $('cOrigen').textContent = hoy.length || hu.length
      ? `${FILTRO === TODOS ? 'Todas las áreas' : FILTRO}: hoy ${ha(suma(hoy))} ha (${ha(campo)} en campo + ${ha(img)} sobre imagen${otro > 0 ? ' + ' + ha(otro) + ' sin dato' : ''})` + (hu.length ? ` · huella anterior al corte ${ha(suma(hu))} ha` : '') + '. Puede cambiarlas.'
      : 'Escriba el área intervenida en hectáreas.';
  }
  $('bCGuardar').style.display = trazo ? '' : 'none';
  CALC.sent = null; abrir('pCalc'); calcular();
  if (polys.length) { try { CALC.sent = cambioSentinel(await cargarSentinel(), polys); } catch (e) { CALC.sent = { error: true }; } calcular(); }
}
function calcular() {
  const A = num('cArea') * 10000, h = num('cProf'), rel = num('cRel') || 15, dps = Math.min(7, num('cDias')), mpa = Math.min(11.9, num('cParAnual'));
  const DIA = 86400000, MES = 30.44, fac = dps / 7 * (1 - mpa / 12);
  const corte = new Date($('cCorte').value + 'T00:00'), visita = new Date($('cVisita').value + 'T00:00'), entre = (visita - corte) / DIA;
  const calPost = Math.max(0, entre - num('cParPost') * MES), Dpost = calPost * fac;
  const V = A * h, rBomba = num('cCaudal') / rel * num('cHoras');
  const esc_ = [['Según equipos', num('cBombas') * rBomba]]; if (num('cManif') > 0) esc_.push(['Según lo manifestado', num('cManif')]);
  const fmes = d => `${MESES[d.getMonth()]}-${d.getFullYear()}`;
  let html = `<div class="caja"><b>Volumen removido:</b> ${miles(V)} m³ (${dec(A / 10000, 2)} ha × ${dec(h, 1)} m)<br><b>Tiempo desde el corte:</b> ${dec(entre / 365.25, 1)} años · ${miles(Dpost)} días de trabajo</div>`;
  // al revés: horas de bombeo al día que harían falta para abrir el área desde el inicio manifestado
  let lineaInicio = '';
  const ini = $('cInicio').value ? new Date($('cInicio').value + '-01T00:00') : null, porHora = num('cBombas') * num('cCaudal') / rel;
  if (ini && ini < visita && porHora > 0 && V > 0 && fac > 0) {
    const calIni = (visita - ini) / DIA, diasTrab = Math.max(1, (calIni - (num('cParPre') + num('cParPost')) * MES) * fac);
    const hNec = V / porHora / diasTrab, prom = V / (calIni / 365.25);
    let juicio = hNec <= 10 ? '<b class="si">cuadra con lo manifestado</b>' : hNec <= 16 ? '<b>exigente: confirme turnos y equipos</b>'
      : '<b class="no">no alcanza: pregunte por equipos anteriores, otros frentes, un inicio más antiguo o área de terceros</b>';
    if (ini >= corte) juicio = '<b class="no">el inicio manifestado es posterior al corte</b>; ' + juicio;
    html += `<div class="caja calc"><b>Con el inicio manifestado (${fmes(ini)}):</b> habrían tenido que bombear <b>${dec(hNec, 1)} h al día</b> en ${miles(diasTrab)} días de trabajo; ${juicio}.<br>` +
      `Producción promedio desde el inicio: ${miles(prom)} m³/año ${prom > 165000 ? '<b class="no">(supera 165.000)</b>' : '(umbral 165.000)'}</div>`;
    lineaInicio = `Con el inicio manifestado (${fmes(ini)}) habrían tenido que bombear ${dec(hNec, 1)} h al día en ${miles(diasTrab)} días de trabajo; producción promedio ${miles(prom)} m³/año.`;
  }
  const lineas = [`Cálculo de anterioridad (estimado) · ${$('cOrigen').textContent}`, `Área ${dec(A / 10000, 2)} ha × profundidad ${dec(h, 1)} m = ${miles(V)} m³.`,
    `Equipos: ${dec(num('cBombas'), 1)} motobomba(s) de chorro de ${$('cPulg').value}" (${miles(num('cCaudal'))} m³/h, ${dec(rel, 0)} m³ de agua por m³), ${dec(num('cHoras'), 1)} h/día, ${dec(dps, 1)} días/semana, ${dec(mpa, 1)} meses parados al año; otras paradas: ${dec(num('cParPre'), 1)} meses antes y ${dec(num('cParPost'), 1)} después del corte.`];
  const st = CALC && CALC.sent;
  if (st && st.error) html += '<div class="caja calc"><b>Según Sentinel:</b> no se pudieron leer las máscaras.</div>';
  else if (st && A > 0) {
    const fm = f => { const [y, mo, dd] = f.split('-'); return `${+dd}-${MESES[+mo - 1]}-${y}`; };
    if (st.n < 20 || st.v < 0.8 * st.n) html += `<div class="caja calc"><b>Según Sentinel:</b> el polígono es muy pequeño o tiene nubes (${st.n} píxeles de 10 m); use la alta resolución y lo visto en campo.</div>`;
    else if (!st.r) html += `<div class="caja calc"><b>Según Sentinel:</b> no ve intervención dentro de los polígonos (frentes pequeños o lineales, o bajo cobertura); use la alta resolución y lo visto en campo.</div>`;
    else {
      const k = (A / 10000) / st.ha26, a1s = st.haAmbos * k * 10000;      // corrección Google 2026 ÷ Sentinel 2026 en el mismo polígono
      const avisoK = k > 2.5 || k < 0.6 ? '<br><b class="no">Corrección grande:</b> Sentinel no distingue bien estos frentes; tómelo con cautela y apóyelo en la alta resolución.' : '';
      html += `<div class="caja calc"><b>Según Sentinel (mismo sensor, ${fm(st.f23)} frente a ${fm(st.f26)}):</b><br>` +
        `Corrección: Google 2026 ${dec(A / 10000, 2)} ha ÷ Sentinel 2026 ${dec(st.ha26, 2)} ha = <b>k ${dec(k, 2)}</b>.<br>` +
        `Intervenido en las dos fechas según Sentinel: ${dec(st.haAmbos, 2)} ha × k = <b>${dec(a1s / 10000, 2)} ha (${Math.round(a1s / A * 100)} %) ya intervenidas en julio de 2023</b> → anteriores al corte por evidencia satelital.<br>` +
        `Sentinel veía ${dec(st.ha23, 2)} ha en 2023 dentro de los polígonos` + (st.haSolo23 > 0.05 ? `; ${dec(st.haSolo23, 2)} ha de entonces hoy están revegetadas (también anteriores, si son del responsable).` : '.') + avisoK +
        `<br><button id="bUsarSent" class="mini">Usar ${dec(a1s / 10000, 2)} ha como área antes del corte</button></div>`;
      lineas.push(`Según Sentinel (${st.f23} frente a ${st.f26}, mismo sensor): corrección k = Google 2026 ${dec(A / 10000, 2)} ha ÷ Sentinel 2026 ${dec(st.ha26, 2)} ha = ${dec(k, 2)}; intervenido en ambas fechas ${dec(st.haAmbos, 2)} ha × k = ${dec(a1s / 10000, 2)} ha (${Math.round(a1s / A * 100)} %) anteriores al corte.` + (st.haSolo23 > 0.05 ? ` Revegetadas desde 2023: ${dec(st.haSolo23, 2)} ha.` : ''));
      CALC.a1sent = a1s;
    }
  }
  // evidencia en imágenes: lo que ya estaba antes del corte es directo; lo nuevo da un ritmo mínimo
  const A1 = num('cA1') * 10000;
  if (A1 > 0 && A > 0) {
    const fImg = new Date($('cImg').value + 'T00:00'), anos = Math.max(0.1, (visita - fImg) / DIA / 365.25), nomImg = fImg.getFullYear() === 2021 ? '20-ene-2021' : '12-jul-2023';
    const directa = Math.min(A1, A), nueva = Math.max(0, A - A1), ritmoM2 = nueva / anos, ritmoM3 = ritmoM2 * h;
    const capacidad = num('cBombas') * rBomba * 365.25 * fac;
    let alerta;
    if (A1 > A * 1.05) alerta = '<b>El área de hoy es menor que la de la imagen:</b> revegetación o relleno; la evidencia es la imagen.';
    else if (nueva < 0.10 * A) alerta = '<b class="si">Casi no creció:</b> trabajan sobre la misma área (profundización o retrabajo). Favorece la anterioridad; la escala se juzga con los equipos y lo manifestado.';
    else if (capacidad > 0 && ritmoM3 > capacidad * 1.2) alerta = '<b class="no">Creció más de lo que sus equipos explican:</b> pregunte por otros equipos, frentes o terceros (F7).';
    else alerta = capacidad > 0 ? '<b class="si">Coherente con sus equipos.</b>' : '';
    let inicioImg = ritmoM2 > 0 && nueva >= 0.10 * A ? new Date(fImg - directa / ritmoM2 * 365.25 * DIA) : null;
    if (inicioImg && inicioImg.getFullYear() < 1990) inicioImg = null;   // un ritmo muy bajo no permite estimar el inicio
    html += `<div class="caja calc"><b>Según imágenes (evidenciado):</b><br>Anterior al corte por evidencia directa: <b>${dec(directa / 10000, 2)} ha (${Math.round(directa / A * 100)} %)</b>, imagen del ${nomImg}.<br>` +
      `Área nueva desde esa imagen: ${dec(nueva / 10000, 2)} ha en ${dec(anos, 1)} años → ritmo <b>mínimo</b> de ${miles(ritmoM3)} m³/año (no ve profundización ni relleno).<br>` +
      (inicioImg ? `Inicio orientativo con ese ritmo: ${fmes(inicioImg)}.<br>` : 'Inicio orientativo: no se estima, el área casi no creció.<br>') + alerta + `</div>`;
    lineas.push(`Según imágenes (evidenciado): ${dec(directa / 10000, 2)} ha (${Math.round(directa / A * 100)} %) anteriores al corte por evidencia directa (imagen del ${nomImg}); área nueva ${dec(nueva / 10000, 2)} ha en ${dec(anos, 1)} años, ritmo mínimo ${miles(ritmoM3)} m³/año` + (inicioImg ? `; inicio orientativo ${fmes(inicioImg)}.` : '.'));
  }
  esc_.forEach(([nombre, R]) => {
    if (!(R > 0) || !(V > 0) || !(fac > 0) || !(h > 0)) { html += `<div class="caja calc"><b>${nombre}:</b> faltan datos.</div>`; return; }
    const Wd = V / R, cal = Wd <= Dpost ? Wd / fac + num('cParPost') * MES : entre + (Wd - Dpost) / fac + num('cParPre') * MES;
    const inicio = new Date(visita - cal * DIA), anual = R * 365.25 * fac;
    const Amax = Math.min(A, R * Dpost / h), Aprev = A - Amax, Rnec = Dpost > 0 ? V / Dpost : Infinity;
    const veredicto = Aprev > 0.5 ? `<b class="si">Al menos ${dec(Aprev / 10000, 2)} ha (${Math.round(Aprev / A * 100)} %) tendrían que ser anteriores al corte.</b>`
                                   : `<b class="no">Con estos datos toda el área pudo abrirse después del corte: no aporta a la anterioridad.</b>`;
    html += `<div class="caja calc"><b>${nombre}:</b> ${miles(R)} m³/día · ${miles(anual)} m³/año ${anual > 165000 ? '<b class="no">(supera 165.000)</b>' : '(umbral 165.000)'}<br>` +
      `Inicio estimado: <b>${fmes(inicio)}</b><br>Área máxima posible después del corte: ${dec(Amax / 10000, 2)} ha<br>${veredicto}<br>` +
      `Para abrir toda el área después del corte habría hecho falta ${miles(Rnec)} m³/día` + (rBomba > 0 ? `, unas ${dec(Rnec / rBomba, 1)} motobombas de ${$('cPulg').value}" trabajando así.` : '.') + `</div>`;
    lineas.push(`${nombre}: ${miles(R)} m³/día (${miles(anual)} m³/año). Inicio estimado ${fmes(inicio)}. Área máxima posible después del corte ${dec(Amax / 10000, 2)} ha; ` +
      (Aprev > 0.5 ? `al menos ${dec(Aprev / 10000, 2)} ha (${Math.round(Aprev / A * 100)} %) anteriores al corte.` : 'toda el área pudo abrirse después del corte.') + ` Para abrirla toda después del corte: ${miles(Rnec)} m³/día.`);
  });
  if (lineaInicio) lineas.splice(3, 0, lineaInicio);
  lineas.splice(1, 0, 'Fuentes: área y corte, evidenciados (en campo o mediante imagen); equipos, régimen, paradas, inicio y producción, manifestados salvo que se hayan visto; inicio estimado y áreas máximas, calculados por la ANM.');
  $('cRes').innerHTML = html; RESUMEN = lineas.join('\n');
  const bu = $('bUsarSent'); if (bu) bu.onclick = () => { $('cA1').value = (CALC.a1sent / 10000).toFixed(2); $('cImg').value = '2023-07-12'; calcular(); };
}
async function calcGuardar() {
  const t = CALC && CALC.trazo; if (!t) return;
  const nuevo = { ...t, calc: { params: paramsCalc(), resumen: RESUMEN, fecha: fechaLocal(new Date()) } };
  await trazoGuardar(nuevo); CALC.trazo = nuevo; await metaSet('calcUltimo', paramsCalc()); await pintarTrazos(); avisar(`Cálculo guardado en ${rotulo(nuevo)}`);
}
async function calcCopiar() {
  await metaSet('calcUltimo', paramsCalc());
  try { await navigator.clipboard.writeText(RESUMEN); avisar('Resumen copiado'); } catch (e) { avisar('No se pudo copiar'); }
}

async function pintarTrazos() {              // en el color del minero asignado; sin minero, líneas celestes y áreas blancas
  const ts = (await trazosTodos()).filter(pasaFiltro); capaLineas.clearLayers(); capaAreas.clearLayers();
  ts.forEach(t => {
    const vs = t.vertices.map(([a, b]) => L.latLng(a, b));
    if (t.tipo === 'area') {
      const col = colorDe(t.upm) || '#ffffff', hu = t.que === HUELLA;   // la huella anterior al corte va punteada
      L.polygon(vs, { color: '#000', weight: 5, opacity: .35, fill: false, interactive: false }).addTo(capaAreas);
      L.polygon(vs, { color: col, weight: 3, dashArray: hu ? '10 8' : null, fillColor: col, fillOpacity: hu ? .08 : .18, interactive: false }).addTo(capaAreas);
      etiqueta(centro(vs), `${rotulo(t)} · ${haTxt(t.area_m2)}`, 'grande', () => fichaTrazo(t, centro(vs))).addTo(capaAreas);
    } else {
      L.polyline(vs, { color: '#000', weight: 5, opacity: .35, interactive: false }).addTo(capaLineas);
      L.polyline(vs, { color: colorDe(t.upm) || '#4DD0E1', weight: 4 }).on('click', e => tocar(e, () => fichaTrazo(t, e.latlng), false)).addTo(capaLineas);
      etiqueta(vs[vs.length - 1], `${rotulo(t)} · ${distTxt(t.longitud_m)}`, 'der', () => fichaTrazo(t, vs[vs.length - 1])).addTo(capaLineas);
    }
  });
  contar();
}
async function contar() { $('nPuntos').textContent = (await puntosTodos()).length + (await trazosTodos()).length; }

/* ---------------- exportar ---------------- */
async function datosExport() {
  const pts = (await puntosTodos()).sort((a, b) => a.fecha < b.fecha ? -1 : 1), ts = (await trazosTodos()).sort((a, b) => a.fecha < b.fecha ? -1 : 1);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`, c = v => String(v).replace('.', ',');
  const cab = ['n', 'consecutivo', 'nombre', 'upm', 'nota', 'fecha_hora', 'latitud', 'longitud', 'precision_m', 'este_ctm12', 'norte_ctm12', 'origen', 'lecturas'];
  const filas = pts.map((p, i) => [i + 1, p.codigo || '', q(p.nombre), q(p.upm), q(p.nota), p.local, c(p.lat.toFixed(6)), c(p.lon.toFixed(6)), p.precision != null ? c(p.precision) : '', p.este, p.norte, q(p.origen), p.muestras].join(';'));
  const csv = '﻿' + cab.join(';') + '\n' + filas.join('\n') + '\n';
  const cabT = ['n', 'consecutivo', 'nombre', 'tipo', 'que_es', 'upm', 'nota', 'fecha_hora', 'longitud_o_perimetro_m', 'area_ha', 'area_m2', 'vertices', 'tramos_m', 'vertices_ctm12_este_norte', 'como_se_midio', 'calculo_anterioridad'];
  const filasT = ts.map((t, i) => [i + 1, t.codigo || '', q(t.nombre), t.tipo === 'area' ? 'área' : 'línea', q(t.que), q(t.upm), q(t.nota), t.local, c(t.longitud_m),
    t.area_m2 != null ? c((t.area_m2 / 10000).toFixed(2)) : '', t.area_m2 ?? '', t.vertices.length, q(t.tramos_m.map(c).join(' | ')), q(t.ctm.map(([e, n]) => `${e} ${n}`).join(' | ')), q(t.medicion || ''), q(t.calc ? t.calc.resumen.replace(/\n/g, ' ') : '')].join(';'));
  const csvT = '﻿' + cabT.join(';') + '\n' + filasT.join('\n') + '\n';
  const kc = vs => vs.map(([la, lo]) => `${lo},${la},0`).join(' ');
  const descT = t => `${t.que} · ${t.upm} · ${t.local} · ` + (t.tipo === 'area' ? `${haTxt(t.area_m2)} · perímetro ${t.longitud_m} m` : `${t.longitud_m} m`) + ` · tramos (m): ${t.tramos_m.join(', ')}${t.nota ? ' · ' + t.nota : ''}`;
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Campo ZRP 753</name>` +
    `<Style id="area"><LineStyle><color>ffffffff</color><width>2</width></LineStyle><PolyStyle><color>33ffffff</color></PolyStyle></Style>` +
    `<Style id="linea"><LineStyle><color>ffe1d04d</color><width>3</width></LineStyle></Style>` +
    pts.map(p => `<Placemark><name>${esc(rotulo(p))}</name><description>${esc(`${p.upm} · ${p.local} · E ${p.este} N ${p.norte} (CTM12) · ±${p.precision ?? '-'} m · ${p.origen}${p.nota ? ' · ' + p.nota : ''}`)}</description><Point><coordinates>${p.lon},${p.lat},0</coordinates></Point></Placemark>`).join('') +
    ts.map(t => `<Placemark><name>${esc(rotulo(t))}</name><styleUrl>#${t.tipo}</styleUrl><description>${esc(descT(t))}</description>` + (t.tipo === 'area'
      ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kc([...t.vertices, t.vertices[0]])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
      : `<LineString><coordinates>${kc(t.vertices)}</coordinates></LineString>`) + `</Placemark>`).join('') +
    `</Document></kml>\n`;
  const lonlat = vs => vs.map(([la, lo]) => [lo, la]);
  const gj = JSON.stringify({ type: 'FeatureCollection', features: [
    ...pts.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { ...p } })),
    ...ts.map(t => ({ type: 'Feature', geometry: t.tipo === 'area' ? { type: 'Polygon', coordinates: [lonlat([...t.vertices, t.vertices[0]])] } : { type: 'LineString', coordinates: lonlat(t.vertices) },
      properties: { id: t.id, tipo: t.tipo, consecutivo: t.codigo || null, nombre: t.nombre, que_es: t.que, upm: t.upm, nota: t.nota, fecha: t.fecha, local: t.local, longitud_o_perimetro_m: t.longitud_m,
        area_m2: t.area_m2, area_ha: t.area_m2 != null ? +(t.area_m2 / 10000).toFixed(2) : null, tramos_m: t.tramos_m, vertices_ctm12: t.ctm, como_se_midio: t.medicion || null, calculo_anterioridad: t.calc ? t.calc.resumen : null } }))] }, null, 1);
  const d = new Date(), z = n => String(n).padStart(2, '0');
  const base = `ZRP753_campo_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
  return { pts, ts, csv, csvT, kml, gj, base };
}
async function compartir(archivos) {
  if (navigator.canShare && navigator.canShare({ files: archivos })) {
    try { await navigator.share({ files: archivos, title: archivos[0].name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  archivos.forEach(f => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); });
}
async function exportarZip() {
  const x = await datosExport(); if (!x.pts.length && !x.ts.length) { avisar('No hay nada para exportar'); return; }
  const z = new JSZip(); z.file(x.base + '_puntos.csv', x.csv); if (x.ts.length) z.file(x.base + '_lineas_y_areas.csv', x.csvT);
  z.file(x.base + '.kml', x.kml); z.file(x.base + '.geojson', x.gj);
  const blob = await z.generateAsync({ type: 'blob' });
  await compartir([new File([blob], x.base + '.zip', { type: 'application/zip' })]);
}
async function exportarCsv() {
  const x = await datosExport(); if (!x.pts.length && !x.ts.length) { avisar('No hay nada para exportar'); return; }
  const fs = [new File([x.csv], x.base + '_puntos.csv', { type: 'text/csv' })];
  if (x.ts.length) fs.push(new File([x.csvT], x.base + '_lineas_y_areas.csv', { type: 'text/csv' }));
  await compartir(fs);
}
async function copiarTexto() {
  const x = await datosExport(); if (!x.pts.length && !x.ts.length) { avisar('No hay nada para copiar'); return; }
  try { await navigator.clipboard.writeText((x.csv + (x.ts.length ? '\n' + x.csvT : '')).replace(/﻿/g, '')); avisar('Copiado: pégalo en WhatsApp o en un correo'); }
  catch (e) { avisar('No se pudo copiar; usa «Compartir solo CSV»'); }
}

/* ---------------- paquete de datos ---------------- */
async function estadoDatos() {
  const capas = (await metaGet('capas')) || [], upm = (await metaGet('upm')) || [], pts = await puntosTodos(), ts = await trazosTodos();
  let est = '';
  try { const e = await navigator.storage.estimate(); est = ` · ${(e.usage / 1e6).toFixed(0)} MB usados`; } catch (e) {}
  $('estadoDatos').innerHTML = capas.length ? `<b>Mapas:</b> ${capas.map(c => c.boton).join(', ')}<br><b>Puntos de UPM:</b> ${upm.length}<br><b>Tus puntos:</b> ${pts.length} · <b>Líneas y áreas:</b> ${ts.length}${est}`
                                            : `Sin mapas cargados. Tus puntos: ${pts.length} · líneas y áreas: ${ts.length}${est}`;
}
async function importarZip(buf) {
  const pr = $('progreso'); pr.style.display = 'block'; pr.textContent = 'Abriendo el paquete…';
  const z = await JSZip.loadAsync(buf);
  const meta = JSON.parse(await z.file('meta.json').async('string'));
  const nombres = Object.keys(z.files).filter(n => n.startsWith('teselas/') && !z.files[n].dir);
  let hechas = 0;
  for (let i = 0; i < nombres.length; i += 150) {
    const lote = await Promise.all(nombres.slice(i, i + 150).map(async n => [n.slice(8).replace(/\.(jpg|png)$/, ''), new Blob([await z.file(n).async('uint8array')], { type: n.endsWith('.png') ? 'image/png' : 'image/jpeg' })]));
    await tx('teselas', 'readwrite', s => { lote.forEach(([k, b]) => s.put(b, k)); });
    hechas += lote.length; pr.textContent = `Cargando mapas… ${hechas} de ${nombres.length} teselas`;
  }
  if (meta.capas) {
    const m = new Map(((await metaGet('capas')) || []).map(c => [c.id, c]));
    meta.capas.forEach(c => m.set(c.id, { ...(m.get(c.id) || {}), ...c })); await metaSet('capas', [...m.values()]);
  }
  if (meta.upm) await metaSet('upm', meta.upm); if (meta.personas) await metaSet('personas', meta.personas);
  pr.textContent = `Listo: ${nombres.length} teselas` + (meta.upm ? ` y ${meta.upm.length} puntos de UPM.` : '.');
  await cargarCapas(); await estadoDatos(); avisar('Paquete cargado');
}
window.app = { importarZipURL: async u => importarZip(await (await fetch(u)).arrayBuffer()), simular: (lat, lon, acc = 6) => enPos({ coords: { latitude: lat, longitude: lon, accuracy: acc } }) };

/* ---------------- eventos ---------------- */
$('bCentrar').onclick = () => { if (POS) { map.setView([POS.lat, POS.lon], Math.max(map.getZoom(), 17)); seguir(true); } else { iniciarGPS(); avisar('Buscando GPS…'); } };
map.on('dragstart', () => { if (SEGUIR) seguir(false); });
map.on('move', () => { actualizarMira(); textoMed(); });
map.on('click', e => { if (MIDIENDO) medirAgregar(e.latlng); });
$('bMedCruz').onclick = () => medirAgregar(map.getCenter());
$('bMedYo').onclick = () => { if (POS) medirAgregar([POS.lat, POS.lon]); else avisar('Sin GPS todavía'); };
$('bMedDeshacer').onclick = () => { VERT.pop(); pintarMed(); };
$('bMedFin').onclick = () => medirFin(true);
$('bMedArea').onclick = () => { CERRADA = !CERRADA; marcarArea(); pintarMed(); };
$('bMedGuardar').onclick = medirGuardar;
$('bTCancelar').onclick = () => abrir(null); $('bTGuardar').onclick = trazoConfirmar;
$('bMedir').onclick = medirAbrir;
$('filtros').onclick = e => { const v = e.target.dataset.v; if (v) alternarVer(v); };
$('fMinero').onchange = async e => { FILTRO = e.target.value; await pintarMios(); await pintarTrazos(); };
$('fUpm').onchange = e => otroMinero(e.target); $('tUpm').onchange = e => otroMinero(e.target); $('eUpm').onchange = e => otroMinero(e.target);
$('bCalc').onclick = () => abrirCalc(null);
$('pCalc').addEventListener('input', calcular);
$('cPulg').onchange = () => { $('cCaudal').value = CAUDAL[$('cPulg').value] || ''; calcular(); };
$('bCCopiar').onclick = calcCopiar; $('bCGuardar').onclick = calcGuardar;
$('bCCerrar').onclick = async () => { await metaSet('calcUltimo', paramsCalc()); abrir(null); };
$('bECancelar').onclick = () => { if (EDIT && EDIT.desdeMapa) abrir(null); else abrirLista(); }; $('bEGuardar').onclick = guardarEdicion;
$('bPunto').onclick = abrirNuevoPunto;
$('bCancelar').onclick = () => abrir(null);
$('bGuardar').onclick = () => guardarPunto(posicionActual());
$('bPromedio').onclick = promediar;
$('segOrigen').onclick = e => { const o = e.target.dataset.o; if (o) ponerOrigen(o); };
$('bLista').onclick = abrirLista; $('bCerrarLista').onclick = () => abrir(null);
$('bExportar').onclick = () => abrir('pExportar'); $('bCerrarExp').onclick = () => abrir(null);
$('bZip').onclick = exportarZip; $('bCsv').onclick = exportarCsv; $('bCopiar').onclick = copiarTexto;
$('bDatos').onclick = async () => { await estadoDatos(); abrir('pDatos'); }; $('bCerrarDatos').onclick = () => abrir(null);
$('bCeldas').onclick = alternarCeldas;
$('fZip').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await importarZip(await f.arrayBuffer()); } catch (err) { $('progreso').textContent = 'Error al cargar: ' + err.message; } e.target.value = ''; };
$('bBorrarMapas').onclick = async () => { if (!confirm('¿Borrar los mapas y los puntos de UPM de este teléfono? Tus puntos no se borran.')) return;
  await tx('teselas', 'readwrite', s => s.clear()); await tx('meta', 'readwrite', s => s.clear()); location.reload(); };
$('bBorrarPuntos').onclick = async () => { if (!confirm('¿Borrar TODOS tus puntos, líneas y áreas? Exporta antes. No se puede deshacer.')) return;
  await tx('puntos', 'readwrite', s => s.clear()); await tx('trazos', 'readwrite', s => s.clear()); await pintarMios(); await pintarTrazos(); estadoDatos(); };

(async () => {
  await abrirDB();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  await cargarZRP(); VER = { ...VER, ...((await metaGet('ver')) || {}) };
  for (const p of await puntosTodos()) if (!p.codigo && /^P\d+$/.test(p.nombre || '')) await puntoGuardar({ ...p, codigo: p.nombre, nombre: '' });   // registros de antes: «P01» pasa a consecutivo
  for (const t of await trazosTodos()) if (!t.codigo && /^[LA]\d+$/.test(t.nombre || '')) await trazoGuardar({ ...t, codigo: t.nombre, nombre: '' });
  EXTRA = (await metaGet('personasExtra')) || [];   // más los nombres ya usados en lo tomado, por si se borró el paquete
  [...(await puntosTodos()), ...(await trazosTodos())].forEach(r => { if (r.upm && r.upm !== SIN && r.upm !== OTRO && !EXTRA.includes(r.upm)) EXTRA.push(r.upm); });
  await cargarCapas(); await pintarMios(); await pintarTrazos(); aplicarVer(); actualizarMira(); iniciarGPS();
  if ('serviceWorker' in navigator) {        // al publicar una versión nueva, recarga una vez para estrenarla
    const habia = !!navigator.serviceWorker.controller; let recargada = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (habia && !recargada) { recargada = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
