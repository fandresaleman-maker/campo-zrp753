/* Campo ZRP 753 — app web sin conexión para tomar puntos en campo.
   Mapas, nombres de mineros y puntos tomados se guardan solo en el teléfono (IndexedDB). */
'use strict';
const CTM12 = '+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const aCTM = (lat, lon) => proj4('EPSG:4326', CTM12, [lon, lat]);           // -> [Este, Norte]
const distCTM = (a, b) => { const p = aCTM(a.lat, a.lng), q = aCTM(b.lat, b.lng); return Math.hypot(q[0] - p[0], q[1] - p[1]); };   // metros en el plano CTM12
const miles = v => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function centroCTM(t) {                     // centro de un área en CTM12 (centroide del polígono): la coordenada del frente para el acta
  const P = t.ctm && t.ctm.length ? t.ctm : t.vertices.map(([la, lo]) => aCTM(la, lo)), [x0, y0] = P[0];
  let A = 0, cx = 0, cy = 0;
  P.forEach(([xa, ya], i) => { const [xb, yb] = P[(i + 1) % P.length], a = xa - x0, b = ya - y0, c = xb - x0, d = yb - y0, f = a * d - c * b; A += f; cx += (a + c) * f; cy += (b + d) * f; });
  if (Math.abs(A) < 1e-6) return [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length].map(Math.round);
  return [x0 + cx / (3 * A), y0 + cy / (3 * A)].map(Math.round);
}
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
const rotulo = r => r.codigo ? r.codigo + (esFrente(r) && r.estado ? ' · ' + r.estado.toLowerCase() : '') + (r.nombre ? ' · ' + r.nombre : '') : (r.nombre || '');   // consecutivo y nombre corto   // solo lo tomado en campo; los puntos de UPM de oficina siempre se ven
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
  const regs = pref === 'P' ? await puntosTodos() : (await trazosTodos()).filter(t => (t.tipo === 'area' ? 'A' : 'L') === pref && !esFrente(t));   // los frentes van aparte, F1, F2… por minero
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
  if (FILTRO !== TODOS) {                   // resumen del minero filtrado: anterioridad de sus frentes, inicio y escala
    const r = document.createElement('div'); r.className = 'caja'; r.style.marginBottom = '6px'; r.innerHTML = 'Calculando el resumen del minero…'; l.appendChild(r);
    (async () => { const eq = await equiposDe(FILTRO); const s = resumenMinero(FILTRO, analizar(await frentesDe(FILTRO), eq), eq); r.innerHTML = s.html + avisosHtml(s.avisos, 2); })().catch(() => { r.textContent = 'No se pudo calcular el resumen.'; });
  }
  if (!pts.length && !ts.length) l.insertAdjacentHTML('beforeend', '<p class="nota">Todavía no hay nada guardado.</p>');
  ts.forEach(t => {
    const REG = t, REG_TIPO = 'trazos';
    const d = document.createElement('div'); d.className = 'item';
    const med = t.tipo === 'area' ? `${areaTxt(t)} · perímetro ${distTxt(t.longitud_m)} · ${t.vertices.length} vértices · centro E ${miles(centroCTM(t)[0])} N ${miles(centroCTM(t)[1])}` : `${distTxt(t.longitud_m)} · ${t.tramos_m.length} tramo(s)`;
    d.innerHTML = `<div class="t"><b>${esc(rotulo(t))}</b> · ${t.tipo === 'area' ? 'Área' : 'Línea'} · ${esc(queTxt(t))}${t.medicion ? ' · ' + esc(t.medicion) : ''}<br>${med} · ${esc(t.upm)}<br><span class="nota">${esc(t.local)}${t.nota ? ' · ' + esc(t.nota) : ''}</span></div>`;
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
  const bs = [...(editar ? [['Editar', editar]] : []), ...extra], fila = document.createElement('div'); fila.className = 'botones';   // dos columnas; el último va ancho si sobra
  bs.forEach(([t, f], i) => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { map.closePopup(); f(); };
    if (i === bs.length - 1 && bs.length % 2) b.className = 'ancho'; fila.appendChild(b); });
  if (bs.length) d.appendChild(fila);
  const pop = L.popup({ maxWidth: 270, maxHeight: Math.round(innerHeight * 0.55), autoPanPaddingTopLeft: L.point(10, 170), autoPanPaddingBottomRight: L.point(10, 150) }).setLatLng(ll).setContent(d).openOn(map);
  return { d, pop };
}
const pie = r => `<br>${esc(r.local)}` + (r.nota ? `<br><i>${esc(r.nota)}</i>` : '') + (r.editado ? `<br><span class="nota">Editado ${esc(r.editado)}</span>` : '');
function fichaPunto(p) {
  ficha([p.lat, p.lon], `<b>${esc(rotulo(p))}</b><br>${esc(p.upm)}<br>E ${miles(p.este)} · N ${miles(p.norte)}<br>${dec(p.lat, 6)}, ${dec(p.lon, 6)}` +
    (p.precision != null ? ` · ±${Math.round(p.precision)} m` : '') + ` · ${esc(p.origen)}` + pie(p), () => abrirEditar('puntos', p, true));
}
function fichaTrazo(t, ll) {                 // corta: quién, qué, cuánto, dónde y lo que dicen las imágenes
  const fr = esFrente(t), area = t.tipo === 'area', pr = profGuardada(t), novis = t.medicion === MEDICION[1] ? ' · no visitado' : '';
  let h = `<b>${esc(t.codigo || t.nombre || '')}</b> · ${esc(t.upm)}<br>`;
  if (fr) h += `${esc(queTxt(t))} · ${haTxt(t.area_m2)} · ` + (pr ? `${dec(pr, 1)} m de profundidad` : '<span class="no">sin profundidad</span>') + novis;
  else h += area ? `${esc(t.que || 'Área')} · ${haTxt(t.area_m2)}${novis}` : `${esc(t.que || 'Línea')} · ${distTxt(t.longitud_m)}`;
  if (t.nombre && t.codigo) h += `<br>${esc(t.nombre)}`;
  if (area) { const [E, N] = centroCTM(t); h += `<br>Centro: E ${miles(E)} · N ${miles(N)}`; }
  if (t.nota) h += `<br>Nota: ${esc(t.nota)}`;
  const { d, pop } = ficha(ll, h + (fr ? '<div class="lmin" data-ant>Mirando las imágenes…</div>' : area ? '<div class="lmin">No es frente: no lleva anterioridad. Si lo es, márquelo con «Editar».</div>' : ''),
    null, [[fr ? 'Editar frente' : 'Editar', () => abrirEditar('trazos', t, true)],
      ...(fr ? [['Anterioridad', () => abrirCalc(t)]] : []),
      ...(t.tipo === 'area' && !t.veg_m2 ? [['Quitar árboles del área', () => proponerVeg(t.vertices, t.area_m2, r => aceptarVegTrazo(t, r))]] : [])]);
  if (fr) fichaAnt(t, d.querySelector('[data-ant]'), pop).catch(() => { d.querySelector('[data-ant]').textContent = 'No se pudo calcular la anterioridad.'; });
}
async function aceptarVegTrazo(t, r) {       // guarda el área sin la vegetación aceptada
  const base = (await trazoGet(t.id)) || t, A0 = base.area_trazada_m2 || base.area_m2, veg = Math.round(A0 * r.frac);
  const nuevo = { ...base, area_trazada_m2: A0, area_m2: A0 - veg, veg_m2: veg, veg_url: r.url, veg_bounds: r.bounds, veg_manchas: r.manchas, editado: fechaLocal(new Date()) };
  await trazoGuardar(nuevo); await pintarTrazos(); avisar(`${rotulo(nuevo)}: ${haTxt(nuevo.area_m2)} sin árboles`);
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
  MIDIENDO = true; CERRADA = false; VERT = []; VEG = null; abrir(null);
  $('pMedir').classList.add('abierto'); $('mira').style.display = 'none'; marcarArea(); pintarMed();
}
function medirFin(preguntar) {
  if (preguntar && VERT.length > 1 && !confirm('¿Salir sin guardar esta medición?')) return;
  MIDIENDO = false; VERT = []; VEG = null; capaMed.clearLayers(); capaVeg.clearLayers(); $('pVeg').classList.remove('abierto'); if (guiaMed) { map.removeLayer(guiaMed); guiaMed = null; }
  $('pMedir').classList.remove('abierto'); $('mira').style.display = ''; actualizarMira();
}
function marcarArea() { const b = $('bMedArea'); b.classList.toggle('on', CERRADA); b.textContent = CERRADA ? 'Dejar como línea' : 'Cerrar área'; }
function medirAgregar(ll) { VERT.push(L.latLng(ll)); VEG = null; pintarMed(); }
function pintarMed() {
  capaMed.clearLayers();
  const area = CERRADA && VERT.length > 2, m = medidas(VERT, area);
  $('filaVeg').style.display = area ? 'flex' : 'none';
  if (area) {
    L.polygon(VERT, { color: '#F9B21A', weight: 3, fillColor: '#F9B21A', fillOpacity: .15, interactive: false }).addTo(capaMed);
    if (VEG) L.imageOverlay(VEG.url, VEG.bounds, { interactive: false }).addTo(capaMed);
    etiqueta(centro(VERT), VEG ? haTxt(m.area * (1 - VEG.frac)) : haTxt(m.area), 'grande').addTo(capaMed);
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
  if (area) h = (VEG ? `<b>${haTxt(m.area * (1 - VEG.frac))}</b> sin árboles (${haTxt(m.area)} trazadas)` : `<b>${haTxt(m.area)}</b>`) + ` · perímetro ${distTxt(m.total)} · ${VERT.length} vértices`;
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
const MEDICION = ['En campo (recorrida)', 'Sobre la imagen (no visitada)'], HUELLA = 'Huella en imagen anterior al corte';   // la huella ya no se ofrece; queda para registros de antes
const FRENTE = 'Frente de explotación';
const NOFRENTE = ['— Elija —', 'Área intervenida o removida (no es frente)', 'Entable o planta de beneficio', 'Piscina o sedimentador', 'Botadero o estéril', 'Campamento', 'Vía o acceso', 'Otro'];
const QUE = { linea: ['Distancia entre puntos', 'Recorrido o acceso', 'Canal o drenaje', 'Frente lineal', 'Otro'] };   // el primero es el predeterminado
const esFrente = t => t.tipo === 'area' && (t.frente != null ? t.frente : t.que === FRENTE);
const queTxt = t => esFrente(t) ? `Frente ${t.estado ? t.estado.toLowerCase() : '(estado sin dato)'}` + (t.estado === 'Inactivo' && t.parado_desde ? `, parado desde ${fmesISO(t.parado_desde)}` : '') : (t.que || '');
const areaTxt = t => t.veg_m2 ? `${haTxt(t.area_m2)} (${haTxt(t.area_trazada_m2)} trazadas − ${haTxt(t.veg_m2)} de árboles)` : haTxt(t.area_m2);
async function numeroLibre(upm, sinId) {     // frentes por minero: F1, F2…; el número de un frente borrado se vuelve a usar
  const usados = new Set((await trazosTodos()).filter(t => esFrente(t) && t.upm === upm && t.id !== sinId).map(t => t.frente_n));
  let n = 1; while (usados.has(n)) n++; return n;
}
function segPoner(id, v) { const g = $(id); g.dataset.v = v || ''; [...g.children].forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
function frPoner(x, t) {                     // llena el bloque «¿Es un frente?» del panel x ('t' nuevo, 'e' editar)
  const fr = t ? esFrente(t) : null;
  segPoner(x + 'EsFr', fr == null ? '' : fr ? 'si' : 'no');
  segPoner(x + 'Estado', fr && t.estado ? t.estado : '');
  $(x + 'Parado').value = (t && t.parado_desde) || '';
  $(x + 'Prof').value = t ? (profGuardada(t) || '') : '';
  const s = $(x + 'Tipo'), ops = [...NOFRENTE]; s.innerHTML = '';
  if (t && !fr && t.que && !ops.includes(t.que)) ops.splice(1, 0, t.que);   // tipos de registros viejos («Área», huella)
  ops.forEach(o => { const e = document.createElement('option'); e.textContent = o; s.appendChild(e); });
  s.value = t && !fr && t.que ? t.que : NOFRENTE[0];
  frRefrescar(x);
}
function frRefrescar(x) {
  const es = $(x + 'EsFr').dataset.v;
  $(x + 'SiFr').style.display = es === 'si' ? '' : 'none'; $(x + 'NoFr').style.display = es === 'no' ? '' : 'none';
  $(x + 'ParadoFila').style.display = $(x + 'Estado').dataset.v === 'Inactivo' ? '' : 'none';
  alertasPanel(x); if (x === 't') tituloT();
}
function frLeer(x) {                         // los campos del bloque, o el aviso de lo que falta responder
  const es = $(x + 'EsFr').dataset.v;
  if (!es) return { falta: 'Indique si es un frente de explotación' };
  if (es === 'si') {
    const estado = $(x + 'Estado').dataset.v; if (!estado) return { falta: 'Indique si el frente está activo o inactivo' };
    const prof = nv($(x + 'Prof').value); if (!(prof > 0)) return { falta: 'Anote la profundidad del frente (altura del talud + profundidad de la poza)' };
    return { frente: true, que: FRENTE, estado, parado_desde: estado === 'Inactivo' ? ($(x + 'Parado').value || null) : null, prof };
  }
  const que = $(x + 'Tipo').value; if (que === NOFRENTE[0]) return { falta: 'Elija qué tipo de área es' };
  return { frente: false, que, estado: null, parado_desde: null, prof: null };
}
async function tituloT() {                   // el título dice si se guarda como frente (F de su minero) o como área (A)
  if (!CERRADA) return;
  if ($('tEsFr').dataset.v === 'si') { const u = $('tUpm').value, n = await numeroLibre(u); $('tTitulo').innerHTML = `Guardar frente <span>F${n}</span> · ${esc(u)}`; }
  else $('tTitulo').innerHTML = `Guardar área <span>${PROX_T}</span>`;
}
async function medirGuardar() {              // pregunta qué es antes de guardar
  const tipo = CERRADA ? 'area' : 'linea';
  if (VERT.length < (tipo === 'area' ? 3 : 2)) { avisar(tipo === 'area' ? 'Para un área hacen falta al menos 3 puntos' : 'Pon al menos 2 puntos'); return; }
  const m = medidas(VERT, tipo === 'area'); PROX_T = await siguiente(tipo === 'area' ? 'A' : 'L');
  $('tTitulo').innerHTML = (tipo === 'area' ? 'Guardar área ' : 'Guardar línea ') + `<span>${PROX_T}</span>`;
  const neta = tipo === 'area' && VEG ? m.area * (1 - VEG.frac) : m.area;
  $('tResumen').innerHTML = (tipo === 'area' ? `<b>Área:</b> ${VEG ? `${haTxt(m.area)} − ${haTxt(m.area - neta)} de árboles = <b>${haTxt(neta)}</b>` : haTxt(m.area)} · <b>Perímetro:</b> ${distTxt(m.total)} · ${VERT.length} vértices`
                                             : `<b>Longitud:</b> ${distTxt(m.total)} · ${m.tramos.length} tramo(s)`) + `<br>Tramos: ${m.tramos.map(distTxt).join(' · ')}`;
  $('tCorto').value = ''; $('tNota').value = ''; if (FILTRO !== TODOS) $('tUpm').value = FILTRO;
  $('tFrBloque').style.display = tipo === 'area' ? '' : 'none'; $('tQueFila').style.display = tipo === 'area' ? 'none' : '';
  PANEL_SENT.t = null; $('tSent').style.display = 'none';
  if (tipo === 'area') { frPoner('t', null); vistaSentinel('t', VERT.map(v => [v.lat, v.lng]), neta); }
  else { $('tAlerta').innerHTML = ''; const q = $('tQue'); q.innerHTML = ''; QUE.linea.forEach(t => { const o = document.createElement('option'); o.textContent = t; q.appendChild(o); }); }
  abrir('pTrazo');
}
async function trazoConfirmar() {
  const tipo = CERRADA && VERT.length > 2 ? 'area' : 'linea', m = medidas(VERT, tipo === 'area'), ahora = new Date();
  const fr = tipo === 'area' ? frLeer('t') : { que: $('tQue').value };
  if (fr.falta) { avisar(fr.falta); return; }
  let codigo = PROX_T, extra = {};
  if (fr.frente) { const n = await numeroLibre($('tUpm').value); codigo = 'F' + n; extra.frente_n = n; }
  if (tipo === 'area' && VEG) extra = { ...extra, area_trazada_m2: Math.round(m.area), veg_m2: Math.round(m.area * VEG.frac), veg_url: VEG.url, veg_bounds: VEG.bounds, veg_manchas: VEG.manchas };
  const d = PANEL_SENT.t, al = fr.frente && d ? alertasFrente(fr, d.st, d.A, null, d.g21).map(avisoTxt) : [];
  const reg = { id: ahora.getTime().toString(36) + Math.random().toString(36).slice(2, 6), tipo, codigo, nombre: $('tCorto').value.trim(),
    ...fr, medicion: $('tMed').value,
    upm: $('tUpm').value, nota: $('tNota').value.trim(), fecha: ahora.toISOString(), local: fechaLocal(ahora),
    vertices: VERT.map(v => [+v.lat.toFixed(7), +v.lng.toFixed(7)]), ctm: VERT.map(v => aCTM(v.lat, v.lng).map(Math.round)),
    tramos_m: m.tramos.map(d => Math.round(d * 10) / 10), longitud_m: Math.round(m.total * 10) / 10,
    area_m2: tipo === 'area' ? Math.round(VEG ? m.area * (1 - VEG.frac) : m.area) : null, ...extra, ...(al.length ? { alertas_al_guardar: al } : {}) };
  await trazoGuardar(reg); if (!fr.frente) await gastar(reg.codigo); abrir(null); medirFin(false);
  const k = tipo === 'area' ? 'areas' : 'lineas'; if (!VER[k]) alternarVer(k);
  await pintarTrazos(); avisar(`Guardado ${rotulo(reg)} · ` + (tipo === 'area' ? haTxt(reg.area_m2) : distTxt(m.total)));
}
let EDIT = null;
function ponerValor(sel, v) {                // selecciona v aunque no esté en la lista (registros viejos)
  if (v && ![...sel.options].some(o => o.text === v)) { const o = document.createElement('option'); o.textContent = v; sel.insertBefore(o, sel.lastChild); }
  sel.value = v || SIN;
}
function abrirEditar(almacen, r, desdeMapa = false) {
  EDIT = { almacen, r, desdeMapa };
  const area = almacen === 'trazos' && r.tipo === 'area';
  $('eCodigo').textContent = r.codigo || r.nombre || '';
  $('eResumen').innerHTML = almacen === 'puntos' ? `<b>Punto</b> · E ${miles(r.este)} · N ${miles(r.norte)}${r.precision != null ? ' · ±' + Math.round(r.precision) + ' m' : ''}<br>${esc(r.local)}`
    : (r.tipo === 'area' ? `<b>Área</b> · ${haTxt(r.area_m2)} · centro E ${miles(centroCTM(r)[0])} · N ${miles(centroCTM(r)[1])}` : `<b>Línea</b> · ${distTxt(r.longitud_m)}`) + `<br>${esc(r.local)}`;
  $('eCorto').value = r.nombre || '';
  $('eFrBloque').style.display = area ? '' : 'none';
  $('eQueFila').style.display = almacen === 'trazos' && !area ? '' : 'none';
  PANEL_SENT.e = null; $('eSent').style.display = 'none'; $('eAlerta').innerHTML = '';
  if (area) { frPoner('e', r); vistaSentinel('e', r.vertices, r.area_m2); }
  else if (almacen === 'trazos') { const q = $('eQue'); q.innerHTML = ''; QUE.linea.forEach(t => { const o = document.createElement('option'); o.textContent = t; q.appendChild(o); }); if (r.que && !QUE.linea.includes(r.que)) { const o = document.createElement('option'); o.textContent = r.que; q.appendChild(o); } q.value = r.que || QUE.linea[0]; }
  $('eMedFila').style.display = almacen === 'trazos' ? '' : 'none';
  if (almacen === 'trazos') { const e = $('eMed'); e.innerHTML = ''; [...MEDICION, ...(r.medicion ? [] : ['— Sin dato —'])].forEach(t => { const o = document.createElement('option'); o.textContent = t; e.appendChild(o); }); e.value = r.medicion || '— Sin dato —'; }
  ponerValor($('eUpm'), r.upm); $('eNota').value = r.nota || '';
  abrir('pEditar');
}
async function guardarEdicion() {
  const { almacen, r } = EDIT;
  const nuevo = { ...r, nombre: $('eCorto').value.trim() || (r.codigo ? '' : r.nombre), upm: $('eUpm').value, nota: $('eNota').value.trim(), editado: fechaLocal(new Date()) };
  if (almacen === 'trazos') {
    if (r.tipo === 'area') {
      const f = frLeer('e'); if (f.falta) { avisar(f.falta); return; } Object.assign(nuevo, f);
      if (f.frente && (!esFrente(r) || r.upm !== nuevo.upm || !r.frente_n)) { const n = await numeroLibre(nuevo.upm, r.id); nuevo.frente_n = n; nuevo.codigo = 'F' + n; }   // pasa a frente o cambia de minero
      if (!f.frente && esFrente(r)) { const c = await siguiente('A'); nuevo.codigo = c; nuevo.frente_n = null; await gastar(c); }       // deja de ser frente: vuelve a la serie A
      const d = PANEL_SENT.e, al = f.frente && d ? alertasFrente(f, d.st, d.A, null, d.g21).map(avisoTxt) : [];
      if (al.length) nuevo.alertas_al_guardar = al; else delete nuevo.alertas_al_guardar;
    }
    else nuevo.que = $('eQue').value;
    const md = $('eMed').value; if (MEDICION.includes(md)) nuevo.medicion = md;
  }
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

/* ---------------- método relativo: Google define la minería; Sentinel compara ese sitio en 2023 y 2026 ---------------- */
let NDVI = null;
async function cargarNDVI() {                // rojo = NDVI 2023, verde = NDVI 2026 (0 = sin dato)
  if (NDVI) return NDVI;
  const meta = await (await fetch('sentinel_ndvi.json')).json();
  const img = new Image(); await new Promise((ok, mal) => { img.onload = ok; img.onerror = mal; img.src = 'sentinel_ndvi.png'; });
  const cv = document.createElement('canvas'); cv.width = meta.w; cv.height = meta.h;
  const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, meta.w, meta.h).data, n = meta.w * meta.h, a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const r = px[i * 4], v = px[i * 4 + 1]; a[i] = r ? (r - 1) / 254 * 1.2 - 0.2 : NaN; b[i] = v ? (v - 1) / 254 * 1.2 - 0.2 : NaN; }
  const p80z = arr => { const v = []; for (let i = 0; i < n; i += 7) if (!isNaN(arr[i])) v.push(arr[i]); v.sort((x, y) => x - y); return v[Math.floor(0.8 * (v.length - 1))]; };
  NDVI = { meta, n23: a, n26: b, z23: p80z(a), z26: p80z(b) }; return NDVI;   // z: bosque típico de la ZRP en cada fecha (≈0,90)
}
function relativoSentinel(S, polys) {
  const { lon0, lat1, d, w, h } = S.meta, AN = 8;             // anillo de bosque de referencia: 8 píxeles (≈80 m) alrededor
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  polys.forEach(p => p.forEach(([la, lo]) => { a0 = Math.min(a0, lo); a1 = Math.max(a1, lo); b0 = Math.min(b0, la); b1 = Math.max(b1, la); }));
  const x0 = Math.max(0, Math.floor((a0 - lon0) / d) - AN - 2), x1 = Math.min(w - 1, Math.ceil((a1 - lon0) / d) + AN + 2);
  const y0 = Math.max(0, Math.floor((lat1 - b1) / d) - AN - 2), y1 = Math.min(h - 1, Math.ceil((lat1 - b0) / d) + AN + 2);
  const W = x1 - x0 + 1, H = y1 - y0 + 1; if (W < 3 || H < 3) return { fuera: true };
  const rings = polys.map(p => p.map(([la, lo]) => [lo, la])), M = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (rings.some(r => dentro(lon0 + (x0 + x + 0.5) * d, lat1 - (y0 + y + 0.5) * d, r))) M[y * W + x] = 1;
  let Dl = M.slice();
  for (let k = 0; k < AN; k++) { const N = Dl.slice(); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!Dl[i] && ((x > 0 && Dl[i - 1]) || (x < W - 1 && Dl[i + 1]) || (y > 0 && Dl[i - W]) || (y < H - 1 && Dl[i + W]))) N[i] = 1; } Dl = N; }
  const gi = (x, y) => (y0 + y) * w + (x0 + x), r23 = [], r26 = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (Dl[i] && !M[i]) { const a = S.n23[gi(x, y)], b = S.n26[gi(x, y)]; if (!isNaN(a) && !isNaN(b)) { r23.push(a); r26.push(b); } } }
  const p80 = arr => { const t = arr.slice().sort((p, q) => p - q), k = 0.8 * (t.length - 1), i = Math.floor(k); return t[i] + (t[Math.min(i + 1, t.length - 1)] - t[i]) * (k - i); };
  let f23 = r23.length >= 20 ? p80(r23) : NaN, f26 = r26.length >= 20 ? p80(r26) : NaN, refZona = false;
  if (!(f23 >= 0.75)) { f23 = S.z23; refZona = true; }   // si alrededor no hay bosque (todo intervenido o sin datos), se compara con el bosque típico de la ZRP
  if (!(f26 >= 0.75)) { f26 = S.z26; refZona = true; }
  const calc = (dx, dy, interior) => {         // la máscara corrida dx, dy píxeles simula un desfase entre Google y Sentinel
    let num = 0, den = 0, n = 0, alt = 0, rev = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const xs = x - dx, ys = y - dy; if (xs < 0 || ys < 0 || xs >= W || ys >= H) continue;
      const j = ys * W + xs; if (!M[j]) continue;
      if (interior && !(xs > 0 && xs < W - 1 && ys > 0 && ys < H - 1 && M[j - 1] && M[j + 1] && M[j - W] && M[j + W])) continue;
      const a = S.n23[gi(x, y)], b = S.n26[gi(x, y)]; if (isNaN(a) || isNaN(b)) continue;
      n++; const d26 = Math.max(0, f26 - b), d23 = Math.max(0, f23 - a);
      if (d26 > 0.05) { alt++; num += Math.min(d23, d26); den += d26; } else if (d23 > 0.15) rev++;
    }
    return { R: den > 0 ? num / den : null, n, alt, rev };
  };
  const base = calc(0, 0, false), vals = [base.R];
  [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]].forEach(([dx, dy]) => vals.push(calc(dx, dy, false).R));
  vals.push(calc(0, 0, true).R);
  const ok = vals.filter(v => v != null);
  return { R: base.R, Rmin: ok.length ? Math.min(...ok) : null, Rmax: ok.length ? Math.max(...ok) : null, n: base.n, alt: base.alt, rev: base.rev, f23, f26, refZona, fecha23: S.meta.fecha2023, fecha26: S.meta.fecha2026 };
}

/* ---------------- imágenes de Google en el teléfono: verdor de 2021 y árboles dentro de un trazo ---------------- */
const mercX = (lon, Z) => (lon + 180) / 360 * 256 * 2 ** Z;
const mercY = (lat, Z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** Z; };
const mercLon = (x, Z) => x / (256 * 2 ** Z) * 360 - 180;
const mercLat = (y, Z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (256 * 2 ** Z)))) * 180 / Math.PI;
async function mosaicoGoogle(capa, Z, vertices, margenM) {   // recorte de la capa alrededor del trazo y máscara del trazo, con las teselas del teléfono
  const mpp = 156543.03 * Math.cos(vertices[0][0] * Math.PI / 180) / 2 ** Z, mg = Math.ceil(margenM / mpp) + 2;
  const P = vertices.map(([la, lo]) => [mercX(lo, Z), mercY(la, Z)]);
  const X0 = Math.floor(Math.min(...P.map(p => p[0]))) - mg, X1 = Math.ceil(Math.max(...P.map(p => p[0]))) + mg;
  const Y0 = Math.floor(Math.min(...P.map(p => p[1]))) - mg, Y1 = Math.ceil(Math.max(...P.map(p => p[1]))) + mg;
  const W = X1 - X0, H = Y1 - Y0; if (W * H > 6e6) return null;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d', { willReadFrequently: true });
  let n = 0;
  for (let tx = Math.floor(X0 / 256); tx <= Math.floor((X1 - 1) / 256); tx++) for (let ty = Math.floor(Y0 / 256); ty <= Math.floor((Y1 - 1) / 256); ty++) {
    const b = await teselaGet(`${capa}/${Z}/${tx}/${ty}`); if (!b) continue;
    const im = await createImageBitmap(b); g.drawImage(im, tx * 256 - X0, ty * 256 - Y0); if (im.close) im.close(); n++;
  }
  if (!n) return null;
  const rgba = g.getImageData(0, 0, W, H).data;
  const mc = document.createElement('canvas'); mc.width = W; mc.height = H; const h = mc.getContext('2d', { willReadFrequently: true });
  h.fillStyle = '#fff'; h.beginPath(); P.forEach(([x, y], i) => i ? h.lineTo(x - X0, y - Y0) : h.moveTo(x - X0, y - Y0)); h.closePath(); h.fill();
  const md = h.getImageData(0, 0, W, H).data, dentro = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) dentro[i] = md[i * 4 + 3] > 127 ? 1 : 0;
  return { W, H, X0, Y0, Z, mpp, rgba, dentro };
}
function suavizar(M) {                       // R, G, B promediados 3×3 (sin contar lo que no tiene imagen); NaN sin dato
  const { W, H, rgba } = M, N = W * H, ok = new Uint8Array(N), out = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  for (let i = 0; i < N; i++) { const r = rgba[i * 4], v = rgba[i * 4 + 1], b = rgba[i * 4 + 2]; ok[i] = rgba[i * 4 + 3] >= 128 && r + v + b >= 15 ? 1 : 0; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!ok[i]) { out[0][i] = out[1][i] = out[2][i] = NaN; continue; }
    let r = 0, v = 0, b = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const j = yy * W + xx; if (!ok[j]) continue; r += rgba[j * 4]; v += rgba[j * 4 + 1]; b += rgba[j * 4 + 2]; c++; }
    out[0][i] = r / c; out[1][i] = v / c; out[2][i] = b / c;
  }
  return out;
}
const verdorDe = (r, v) => (v - r) / (v + r + 1);
function componentes(sel, W, H, fn) {        // recorre las manchas conectadas (4 vecinos) de sel = 1; fn(lista de píxeles)
  const vis = new Uint8Array(W * H), pila = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!sel[s] || vis[s]) continue;
    let n = 0, top = 0; const lista = []; pila[top++] = s; vis[s] = 1;
    while (top) { const i = pila[--top]; lista.push(i); n++; const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < W * H && sel[j] && !vis[j]) { vis[j] = 1; pila[top++] = j; } }
    fn(lista);
  }
}
function morfo(m, W, H, dilatar) {           // dilata o erosiona 3×3
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = dilatar ? 0 : 1;
    for (let dy = -1; dy <= 1 && r === (dilatar ? 0 : 1); dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy;
      const q = xx < 0 || yy < 0 || xx >= W || yy >= H ? (dilatar ? 0 : 1) : m[yy * W + xx]; if (dilatar ? q : !q) { r = dilatar ? 1 : 0; break; } }
    o[y * W + x] = r;
  }
  return o;
}
const CACHE_21 = new Map();
async function verde21(vertices) {           // Google ene-2021: parte del trazo que ya se veía sin bosque (arena, agua, suelo); orientativo
  if (!CAPAS.some(c => c.id === 'ge21')) return { sin: true };
  const k = JSON.stringify(vertices); if (CACHE_21.has(k)) return CACHE_21.get(k);
  let res = { sin: true };
  const M = await mosaicoGoogle('ge21', 17, vertices, 3);
  if (M) {                                    // regla fija calibrada contra Sentinel 2023: marca 4 % del bosque y 82 % del suelo
    const [r, v, b] = suavizar(M), N = r.length, des = new Uint8Array(N); let nin = 0, vin = 0, alt = 0;
    for (let i = 0; i < N; i++) { if (isNaN(r[i])) continue; const g = verdorDe(r[i], v[i]), L = (r[i] + v[i] + b[i]) / 3; des[i] = (r[i] - b[i] > 4 && g < 0.07) || (L > 150 && g < 0.05) || g < 0.06 ? 1 : 0; }
    componentes(des, M.W, M.H, l => { if (l.length * M.mpp * M.mpp < 4) l.forEach(i => { des[i] = 0; }); });   // brillos sueltos en el bosque
    for (let i = 0; i < N; i++) if (M.dentro[i]) { nin++; if (!isNaN(r[i])) { vin++; if (des[i]) alt++; } }
    res = nin && vin / nin >= 0.6 ? { pct: alt / vin, cob: vin / nin } : { sin: true, cob: nin ? vin / nin : 0 };
  }
  CACHE_21.set(k, res); return res;
}
function texto21(g) {
  if (!g || g.sin) return 'Imagen de enero de 2021: no cubre este sitio.';
  const p = Math.round(g.pct * 100);
  return 'Imagen de enero de 2021: ' + (p >= 30 ? `ya se veía intervenido (cerca del ${p} %).` : p >= 10 ? `se veía algo intervenido (cerca del ${p} %), no es claro.` : 'todavía era bosque.');
}
async function vegetacion(vertices, modo) {  // modo 'todo': deja solo arena, agua y suelo; 'arboles': quita solo copas
  let M = await mosaicoGoogle('g26', 18, vertices, 2); if (!M) M = await mosaicoGoogle('g26', 17, vertices, 2); if (!M) return null;
  const { W, H, dentro, mpp } = M, N = W * H, [r, v, b] = suavizar(M), m2px = mpp * mpp;
  let veg = new Uint8Array(N);
  if (modo === 'arboles') {
    for (let i = 0; i < N; i++) veg[i] = dentro[i] && verdorDe(r[i], v[i]) >= 0.18 ? 1 : 0;
    veg = morfo(morfo(veg, W, H, true), W, H, false);
  } else {                                    // desnudo: amarillento o claro y sin verdor (calibrado: 0,1 % del bosque cae aquí)
    let des = new Uint8Array(N);
    for (let i = 0; i < N; i++) { if (isNaN(r[i])) continue; const g = verdorDe(r[i], v[i]), L = (r[i] + v[i] + b[i]) / 3; des[i] = (r[i] - b[i] > 4 && g < 0.07) || (L > 150 && g < 0.05) ? 1 : 0; }
    des = morfo(morfo(des, W, H, true), W, H, false);
    componentes(des, W, H, l => { if (l.length * m2px < 4) l.forEach(i => { des[i] = 0; }); });   // brillos sueltos en el bosque
    for (let i = 0; i < N; i++) veg[i] = dentro[i] && !isNaN(r[i]) && !des[i] ? 1 : 0;
  }
  for (let i = 0; i < N; i++) if (!dentro[i]) veg[i] = 0;
  const minimo = modo === 'arboles' ? 15 : 4;  // m²: lo menor no se quita
  componentes(veg, W, H, l => { if (l.length * m2px < minimo) l.forEach(i => { veg[i] = 0; }); });
  const hueco = new Uint8Array(N); for (let i = 0; i < N; i++) hueco[i] = dentro[i] && !veg[i] ? 1 : 0;
  componentes(hueco, W, H, l => { if (l.length * m2px < minimo && l.every(i => { const x = i % W; return dentro[i - 1] && dentro[i + 1] && dentro[i - W] && dentro[i + W] && x > 0 && x < W - 1; })) l.forEach(i => { veg[i] = 1; }); });
  let nin = 0, nveg = 0, manchas = 0; for (let i = 0; i < N; i++) { if (dentro[i]) nin++; if (veg[i]) nveg++; }
  componentes(veg, W, H, () => { manchas++; });
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'), im = g.createImageData(W, H);
  for (let i = 0; i < N; i++) if (veg[i]) { im.data[i * 4] = 255; im.data[i * 4 + 1] = 0; im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = 165; }
  g.putImageData(im, 0, 0);
  return { frac: nin ? nveg / nin : 0, manchas, modo, z: M.Z, url: cv.toDataURL('image/png'),
    bounds: [[mercLat(M.Y0 + H, M.Z), mercLon(M.X0, M.Z)], [mercLat(M.Y0, M.Z), mercLon(M.X0 + W, M.Z)]] };
}
let VEG = null, VEG_PROP = null;
const capaVeg = L.layerGroup().addTo(map);
async function proponerVeg(vertices, areaM2, alAceptar, modo = 'todo') {   // muestra en morado lo que se quitaría; se acepta o se descarta
  $('vegTxt').innerHTML = 'Buscando vegetación en la imagen de Google…'; $('bVegSi').style.display = 'none'; $('pVeg').classList.add('abierto');
  let r = null; try { r = await vegetacion(vertices, modo); } catch (e) { r = null; }
  capaVeg.clearLayers();
  if (!r) { $('vegTxt').innerHTML = 'No hay imagen de Google 2026 en este sitio dentro del teléfono.'; return; }
  L.imageOverlay(r.url, r.bounds, { interactive: false }).addTo(capaVeg);
  const q = areaM2 * r.frac, seg = `<div class="seg" id="vegModo" style="margin:8px 0"><button data-m="todo" class="${modo === 'todo' ? 'on' : ''}">Toda la vegetación</button><button data-m="arboles" class="${modo === 'arboles' ? 'on' : ''}">Solo árboles</button></div>`;
  $('vegTxt').innerHTML = seg + (r.manchas ? `<b>En morado, lo que se quitaría:</b> ${haTxt(q)} en ${r.manchas} mancha(s).<br>Área: ${haTxt(areaM2)} → <b>${haTxt(areaM2 - q)}</b>${r.z < 18 ? ' <i>(con la imagen de menos detalle)</i>' : ''}.<br><span class="nota">${modo === 'todo' ? 'Deja solo arena, agua y suelo. El rastrojo de huecos viejos también es área intervenida: si lo quita, la anterioridad queda por lo bajo.' : 'Quita solo copas de árboles; deja rastrojo y vegetación baja.'}</span>` : 'No encontré vegetación para quitar dentro del trazo.');
  $('vegModo').onclick = e => { const m = e.target.dataset.m; if (m && m !== modo) proponerVeg(vertices, areaM2, alAceptar, m); };
  VEG_PROP = { r, alAceptar }; $('bVegSi').style.display = r.manchas ? '' : 'none';
}
/* ---------------- anterioridad: Sentinel por frente; equipos, inicio y escala por minero ---------------- */
const CAUDAL = { 2: 20, 3: 45, 4: 80, 6: 180, 8: 320 };   // m³/h de agua por motobomba según pulgadas: orden de magnitud
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const EQUIPO = ['cRel', 'cHoras', 'cDias', 'cManif', 'cInicio', 'cCorte', 'cVisita'];
const HIST_BASE = [{ desde: '', n: 1, pulg: '4', caudal: 80 }];   // historia de equipos: la primera fila corre desde el inicio; las demás, desde su fecha
const EQ_BASE = { cRel: 15, cHoras: 8, cDias: 6, cManif: '', cInicio: '', cCorte: '2023-08-15', paradas: [], hist: HIST_BASE };
const PROF = 3, DIA = 86400000, UMBRAL = 165000, CORTE = '2023-08-15';
let CALC = null, RESUMEN = '';
const CACHE_S = new Map();
const hoyISO = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const nv = v => parseFloat(String(v ?? '').replace(',', '.')) || 0;
const num = id => nv($(id).value);
const fmes = d => `${MESES[d.getMonth()]}-${d.getFullYear()}`;
const mesISO = s => s ? new Date(s + '-01T00:00') : null;
const fmesISO = s => s ? fmes(mesISO(s)) : '';
const isoMes = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function paradoDias(P, a, b) {             // días de paradas puntuales con fecha que caen entre a y b
  let s = 0;
  (P || []).forEach(p => { if (!p.mes || !(nv(p.semanas) > 0)) return; const i = mesISO(p.mes), f = new Date(+i + nv(p.semanas) * 7 * DIA); s += Math.max(0, Math.min(+f, +b) - Math.max(+i, +a)) / DIA; });
  return s;
}
const sinFecha = P => (P || []).filter(p => !p.mes && nv(p.semanas) > 0).reduce((a, p) => a + nv(p.semanas) * 7, 0);   // días de paradas sin fecha
function histDe(eq) {                       // la historia de las filas, o la de los campos de antes de la v20
  if (Array.isArray(eq.hist) && eq.hist.length) return eq.hist;
  if (eq.cBombas != null) return [{ desde: '', n: eq.cBombas, pulg: String(eq.cPulg || 4), caudal: eq.cCaudal || CAUDAL[eq.cPulg] || 80 }];
  return HIST_BASE;
}
function periodos(eq) {                      // tramos con su número de motobombas y m³ de grava por hora de cada una; el primero viene desde siempre
  const rel = nv(eq.cRel) || 15, H = histDe(eq), fila = r => ({ n: nv(r.n), q: nv(r.caudal) / rel, pulg: r.pulg });
  const cambios = H.slice(1).filter(r => r.desde).map(r => ({ t0: mesISO(r.desde), ...fila(r) })).sort((a, b) => a.t0 - b.t0);
  const out = [{ t0: new Date(1900, 0, 1), ...fila(H[0]) }, ...cambios];
  return out.map((p, i) => ({ ...p, t1: i < out.length - 1 ? out[i + 1].t0 : new Date(2100, 0, 1) }));
}
function qDias(Pe, P, fac, a, b) {           // m³ de grava que mueven sus equipos de cada época entre a y b, bombeando una hora al día
  let s = 0;
  Pe.forEach(p => { const x = Math.max(+a, +p.t0), y = Math.min(+b, +p.t1); if (y <= x) return;
    s += Math.max(0, (y - x) / DIA - paradoDias(P, new Date(x), new Date(y))) * fac * p.n * p.q; });
  return s;
}
function inicioCon(Pe, P, fac, horas, fin, V) { // desde cuándo sus equipos de cada época alcanzan a mover V hasta fin
  if (!(V > 0) || !(horas > 0) || !(fac > 0)) return null;
  const cap = a => qDias(Pe, P, fac, a, fin) * horas, lim = new Date(1950, 0, 1);
  if (cap(lim) < V) return null;
  let lo = +lim, hi = +fin;
  for (let k = 0; k < 60 && hi - lo > DIA / 2; k++) { const m = (lo + hi) / 2; if (cap(new Date(m)) >= V) lo = m; else hi = m; }
  const ini = new Date(lo - sinFecha(P) * DIA);
  return ini.getFullYear() < 1950 ? null : ini;
}
const histTxt = eq => histDe(eq).map((r, i) => (i ? `desde ${r.desde ? fmesISO(r.desde) : 'sin fecha'}` : 'al empezar') + ` ${dec(nv(r.n), 1).replace(',0', '')} de ${r.pulg}"`).join('; ');
const paradasTxt = P => (P || []).filter(p => nv(p.semanas) > 0).map(p => `${p.mes ? fmesISO(p.mes) : 'sin fecha'} · ${dec(nv(p.semanas), 1)} semanas${p.causa ? ' · ' + p.causa : ''}`).join('; ');
const sinHtml = s => s.replace(/<br>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
function difTxt(dice, calc) {                // cuánto antes o después del calculado está el inicio que dice
  const m = Math.round((calc - dice) / DIA / 30.44);
  if (m === 0) return 'igual al calculado';
  const t = Math.abs(m) >= 24 ? `${dec(Math.abs(m) / 12, 1)} años` : `${Math.abs(m)} mes${Math.abs(m) === 1 ? '' : 'es'}`;
  return m > 0 ? `${t} antes que el calculado` : `${t} después del calculado`;
}
// datos del minero en tres partes que se guardan por separado: equipos, paradas puntuales e inicio manifestado
const PARTES = { eq: { ids: ['cRel', 'cHoras', 'cDias'], nombre: 'equipos' }, man: { ids: ['cManif'], nombre: 'lo que dice remover' },
                 par: { ids: [], nombre: 'paradas' }, ini: { ids: ['cInicio'], nombre: 'inicio manifestado' } };
const PARTES_K = ['eq', 'man', 'par', 'ini'];
const fechasDe = e => { if (!e) return { eq: null, man: null, par: null, ini: null }; const una = !e.guardado_eq && !e.guardado_par && !e.guardado_ini ? e.fecha : null;   // antes de la v19 se guardaba todo de una vez
  const man = 'guardado_man' in e ? e.guardado_man : nv(e.cManif) > 0 ? (e.guardado_eq || una) : null;   // antes de la v28 iba con los equipos
  return { eq: e.guardado_eq || una, man, par: e.guardado_par || una, ini: e.guardado_ini || una }; };
async function equiposDe(upm) {              // datos anotados del minero, o los predeterminados
  const e = ((await metaGet('equipos')) || {})[upm], corte = ((await metaGet('calcUltimo')) || {}).cCorte, partes = fechasDe(e);
  return { ...EQ_BASE, ...(corte ? { cCorte: corte } : {}), cVisita: hoyISO(), ...(e || {}), guardado: !!partes.eq, partes };
}
async function equiposGuardar(upm, eq, cuales = PARTES_K) {   // guarda solo las partes pedidas; las demás quedan como estaban
  const todos = (await metaGet('equipos')) || {}, prev = todos[upm] || {}, f = fechaLocal(new Date()), antes = fechasDe(todos[upm]);
  const nuevo = { ...prev, guardado_eq: antes.eq, guardado_man: antes.man, guardado_par: antes.par, guardado_ini: antes.ini, cCorte: eq.cCorte, cVisita: eq.cVisita, fecha: f };
  cuales.forEach(k => { PARTES[k].ids.forEach(id => { nuevo[id] = eq[id]; }); if (k === 'par') nuevo.paradas = eq.paradas; if (k === 'eq') nuevo.hist = eq.hist; nuevo['guardado_' + k] = f; });
  if (cuales.includes('man') && !(nv(eq.cManif) > 0)) { nuevo.cManif = ''; nuevo.guardado_man = null; }   // sin cifra no queda guardada
  todos[upm] = nuevo; await metaSet('equipos', todos);
  return nuevo;
}
function bloquearParte(k, on) {              // lo ya anotado queda precargado y fijo; «Editar» lo abre para corregirlo
  CALC.bloq[k] = on;
  if (k === 'par') { $('cParadas').querySelectorAll('input').forEach(i => { i.disabled = on; }); $('cParadas').querySelectorAll('button').forEach(b => { b.style.visibility = on ? 'hidden' : ''; }); $('bCParada').style.display = on ? 'none' : ''; }
  else { PARTES[k].ids.forEach(id => { $(id).disabled = on; });
    if (k === 'eq') { $('cHist').querySelectorAll('input, select').forEach(i => { i.disabled = on; }); $('cHist').querySelectorAll('button').forEach(b => { b.style.visibility = on ? 'hidden' : ''; }); limiteHist(); } }
  const b = $('bG' + k), quien = CALC.upm.split(' ')[0];
  b.textContent = on ? `✎ Editar ${PARTES[k].nombre}` : `Guardar ${PARTES[k].nombre} de ${quien}`; b.classList.toggle('prim', !on);
  if (k === 'man') $('bXman').style.display = on ? '' : 'none';
}
function notaEquipos() {
  const p = CALC.eq.partes, d = x => x ? x.slice(0, 10) : 'sin anotar';
  $('cEqNota').textContent = p.eq || p.man || p.par || p.ini ? 'Ya anotado: vale para todos sus frentes. Para cambiarlo, toque «✎ Editar».' : 'Se anota una vez y vale para todos sus frentes, activos e inactivos.';
}
async function eliminarDice() {             // borra lo que dice remover: el cálculo vuelve a sus equipos
  $('cManif').value = ''; const g = await equiposGuardar(CALC.upm, eqForm(), ['man']); CALC.eq.partes = fechasDe(g);
  bloquearParte('man', false); notaEquipos(); calcular(); avisar('Eliminado: el cálculo vuelve a sus equipos');
}
async function guardarParte(k) {
  if (CALC.bloq[k]) { bloquearParte(k, false); return; }   // estaba fijo: lo abre para editar
  const g = await equiposGuardar(CALC.upm, eqForm(), [k]); CALC.eq.partes = fechasDe(g); CALC.eq.guardado = !!CALC.eq.partes.eq;
  bloquearParte(k, true); notaEquipos(); calcular(); avisar(`Guardado: ${PARTES[k].nombre} de ${CALC.upm}`);
}
const trazoGet = id => tx('trazos', 'readonly', s => s.get(id));
async function sentDe(t) {                   // Sentinel del frente; se recalcula solo si cambia el trazo
  const k = t.id + ':' + t.vertices.length + ':' + t.area_m2;
  if (CACHE_S.has(k)) return CACHE_S.get(k);
  let st; try { st = relativoSentinel(await cargarNDVI(), [t.vertices]); } catch (e) { st = { error: true }; }
  CACHE_S.set(k, st); return st;
}
function evalSent(st, A) {                   // ✓ ✗ ? y área ya intervenida en jul-2023 con el límite bajo del margen («al menos»)
  const ok = st && !st.error && !st.fuera && !st.sinAnillo && st.R != null && st.alt >= 15;
  if (!ok) return { est: 'nc', A23: 0 };
  return { est: st.Rmin >= 0.10 ? 'si' : st.Rmax < 0.10 ? 'no' : 'duda', A23: A * Math.max(0, st.Rmin) };
}
const SIMB = { si: '<b class="si">✓</b>', no: '<b class="no">✗</b>', duda: '<b>?</b>', nc: '<b>?</b>' };
const EST_T = { si: 'sí', no: 'no', duda: 'dudoso', nc: 'no concluyente' };
function textoEst(f) {                      // lo que dice el satélite de julio de 2023, en una frase
  const p = f.A > 0 ? Math.round(f.A23 / f.A * 100) : 0;
  if (f.est === 'si') return `${SIMB.si} En julio de 2023 ya estaba intervenido: al menos ${dec(f.A23 / 10000, 2)} ha (${p} %).`;
  if (f.est === 'no') return `${SIMB.no} En julio de 2023 este sitio todavía era bosque: el frente se abrió después.`;
  if (f.est === 'duda') return `${SIMB.duda} Las imágenes de satélite no permiten decir si ya estaba en julio de 2023.`;
  return `${SIMB.nc} El frente es muy pequeño o angosto para las imágenes de satélite.`;
}
function cautelas(st) {                      // solo para la calculadora: por qué el cálculo con Sentinel es menos preciso
  const out = []; if (!st || st.error || st.fuera || st.sinAnillo || st.R == null || st.alt < 15) return out;
  if (st.Rmax - st.Rmin > 0.2) out.push(`Menos preciso: el trazo es pequeño o angosto y el porcentaje cambia entre ${Math.round(st.Rmin * 100)} y ${Math.round(st.Rmax * 100)} % si se corre 10 m.`);
  if (st.refZona) out.push('Menos preciso: alrededor del trazo no hay bosque (todo está intervenido), así que se comparó con el bosque típico de la ZRP.');
  else if (Math.abs(st.f23 - st.f26) > 0.05) out.push(`Menos preciso: el bosque de alrededor no se ve igual en las dos fechas (NDVI ${dec(st.f23, 2)} en 2023 y ${dec(st.f26, 2)} en 2026), por nubes, bruma o tala.`);
  return out;
}
const AV = (tipo, titulo, que, pregunta, hacer) => ({ tipo, titulo, que, pregunta, hacer });   // tipo: no, falta, duda, ok
function avisoHtml(a) {                      // ✗ rojo, ? y faltantes en ámbar, ✓ verde; siempre: qué pasa, qué preguntarle, qué hacer
  if (typeof a === 'string') return `<div class="cautela">${esc(a)}</div>`;
  const cls = { no: 'alerta', ok: 'okv', duda: 'cautela', falta: 'cautela' }[a.tipo];
  return `<div class="${cls}"><b>${esc(a.titulo)}</b><br>${esc(a.que)}` + (a.pregunta ? `<br><b>Pregúntele:</b> «${esc(a.pregunta)}»` : '') + (a.hacer ? `<br><b>Qué hacer:</b> ${esc(a.hacer)}` : '') + '</div>';
}
const avisoTxt = a => typeof a === 'string' ? a : `${a.titulo}: ${a.que}` + (a.pregunta ? ` Pregúntele: «${a.pregunta}»` : '') + (a.hacer ? ` Qué hacer: ${a.hacer}` : '');
function contraste(fr, st, A, corteISO, g21) { // lo marcado frente a lo que ven las imágenes: avisos y un veredicto
  const out = alertasFrente(fr, st, A, corteISO, g21), e = evalSent(st, A);
  if (!(fr && (fr.frente || esFrente(fr))) || !fr.estado) return out;
  const p21 = g21 && !g21.sin ? Math.round(g21.pct * 100) : null, viejo21 = p21 != null && p21 >= 30;
  if (e.est === 'no' && viejo21) out.push(AV('duda', '? Las imágenes no coinciden entre sí', 'En enero de 2021 este sitio ya estaba intervenido, en julio de 2023 se veía cubierto de monte y después se volvió a abrir.',
    '¿Trabajó este sitio antes de 2021?', 'Si dice que sí, anótelo en la nota del frente: la imagen de 2021 lo respalda y es anterior al corte.'));
  if (out.some(a => a.tipo === 'no')) return out;
  if (e.est === 'si') out.push(AV('ok', '✓ Cuadra', 'Lo que usted marcó coincide con las imágenes' + (viejo21 ? ': el frente ya existía en 2021 y en 2023.' : ': el frente ya existía en julio de 2023.')));
  else if (e.est === 'no' && !viejo21) out.push(AV('ok', '✓ Cuadra, pero no sirve para anterioridad', 'Las imágenes muestran que este frente se abrió después de julio de 2023.',
    '¿Dónde trabajaba antes de 2023?', 'Si tiene frentes más viejos, trácelos: son los que pueden probar la anterioridad.'));
  else if (e.est !== 'no') out.push(AV('duda', '? No se puede saber con el satélite', (e.est === 'nc' ? 'El frente es muy pequeño o angosto para las imágenes de satélite.' : 'Las imágenes de satélite no permiten decir si ya estaba en julio de 2023.') +
    (viejo21 ? ' La imagen de enero de 2021 sí lo muestra intervenido, lo que indica que es anterior al corte.' : p21 != null ? ' En la imagen de enero de 2021 todavía era bosque.' : ''),
    '¿Desde cuándo trabaja este frente?', 'Anote lo que diga y tome fotos con Timestamp: aquí la prueba es lo que se vea en campo.'));
  return out;
}
async function frentesDe(upm, incluir) {     // frentes del minero (activos e inactivos) con su resultado de Sentinel
  const ts = (await trazosTodos()).filter(t => esFrente(t) && t.upm === upm);
  if (incluir && !ts.some(t => t.id === incluir.id)) ts.push(incluir);
  ts.sort((a, b) => (a.frente_n || 99) - (b.frente_n || 99));
  const out = []; for (const t of ts) out.push({ t, st: await sentDe(t) }); return out;
}
const profGuardada = t => t.prof || (t.ant && t.ant.prof) || null;   // obligatoria por frente; sin ella no se calcula su volumen
function analizar(frs, eq, profDe = profGuardada) {
  const fecha = (s, def) => { const d = new Date((s || def) + 'T00:00'); return isNaN(d) ? new Date(def + 'T00:00') : d; };
  const corte = fecha(eq.cCorte, CORTE), visita = fecha(eq.cVisita, hoyISO());
  const T = Math.max(0.01, (visita - corte) / DIA / 365.25);
  const sem = 0, fac = Math.min(7, nv(eq.cDias)) / 7, P = eq.paradas || [];   // fracción de la semana que trabaja; lluvias y crecientes van como paradas
  const Pe = periodos(eq), hoy = Pe[Pe.length - 1];   // la última fila sigue hasta hoy
  const dHoy = hoy.n * hoy.q * nv(eq.cHoras), D = nv(eq.cManif), kd = D > 0 && dHoy > 0 ? D / dHoy : 1;   // m³ por día de trabajo con sus equipos de hoy; si dice cuánto remueve, se usa esa cifra
  const horas = nv(eq.cHoras) * kd;                                            // horas efectivas: lo manifestado (equipos, o lo que dice remover)
  const capHoy = hoy.n * hoy.q * horas * 365.25 * fac;                         // m³/año con lo manifestado hoy
  const F = frs.map(({ t, st }) => {
    const A = t.area_m2, h = profDe(t) || 0, e = evalSent(st, A), V = A * h, Vn = (A - e.A23) * h;
    const inactivo = t.estado === 'Inactivo', fin = inactivo && t.parado_desde ? mesISO(t.parado_desde) : visita;
    const ini = inicioCon(Pe, P, fac, horas, fin, V);   // a más tardar: todos los equipos solo en este frente
    return { t, st, A, h, V, Vn, fin, ini, inactivo, sinProf: !(h > 0), ...e };
  });
  const S = k => F.reduce((a, f) => a + f[k], 0);
  const A = S('A'), A23 = S('A23'), V = S('V'), Vn = S('Vn'), nAct = F.filter(f => !f.inactivo).length;
  const fin = nAct || !F.length ? visita : new Date(Math.max(...F.map(f => +f.fin)));
  const ini = inicioCon(Pe, P, fac, horas, fin, V);   // todo el volumen de sus frentes con los equipos de cada época
  const Aprof = F.filter(f => !f.sinProf).reduce((a, f) => a + f.A, 0), iniM = mesISO(eq.cInicio), hMed = Aprof > 0 ? V / Aprof : PROF;
  const capPost = fin > corte ? qDias(Pe, P, fac, corte, fin) * horas : 0;   // m³ que pudo mover después del corte, con los equipos que tuvo desde entonces
  const AmaxPost = Math.min(A, capPost / hMed);
  // ritmo desde el corte: lo abierto según las imágenes (× profundidad) frente a lo que sus equipos mueven en teoría;
  // si hay base para compararlos, la capacidad de sus equipos se ajusta a lo observado y con eso se cuenta hacia atrás
  const diasPost = fin > corte ? Math.max(1, ((fin - corte) / DIA - paradoDias(P, corte, fin)) * fac) : 0;
  const rObs = diasPost ? Vn / diasPost : 0, rEq = diasPost ? capPost / diasPost : 0;   // m³ por día de trabajo
  let k = null, sinCal = '';
  if (!F.length) sinCal = 'no hay frentes dibujados';
  else if (!(fin > corte)) sinCal = 'sus frentes pararon antes del corte';
  else if (F.some(f => f.sinProf)) sinCal = 'falta la profundidad de algún frente';
  else if (!F.some(f => f.est !== 'nc')) sinCal = 'sus frentes son muy pequeños para el satélite';
  else if (!(capPost > 0)) sinCal = 'faltan los equipos';
  else if (Vn < Math.max(1000, 0.1 * V)) sinCal = 'desde 2023 casi no abrió área nueva';
  else if (Vn / capPost < 0.2) sinCal = 'lo abierto desde 2023 es menos de la quinta parte de lo que dan sus equipos';
  else k = Vn / capPost;
  const todoNuevo = F.length > 0 && F.every(f => f.est === 'no');   // todo lo trazado se abrió después de jul-2023: no hay inicio anterior que estimar
  const iniCal = k && !todoNuevo ? inicioCon(Pe, P, fac, horas * k, fin, V) : null;   // «a más tardar»: lo nuevo se cuenta por lo alto, así que no infla la anterioridad
  let hNec = null, diasTrab = 0;
  if (iniM && iniM < fin && fac > 0 && V > 0) {   // horas de bombeo al día que harían falta desde el inicio que dice
    const cal = (fin - iniM) / DIA, qd = qDias(Pe, P, fac, iniM, fin) * Math.max(0, 1 - sinFecha(P) / Math.max(1, cal));
    diasTrab = Math.max(1, cal - paradoDias(P, iniM, fin) - sinFecha(P)) * fac; if (qd > 0) hNec = V / qd;
  }
  const avisosHist = [];
  histDe(eq).slice(1).forEach(r => { if (!r.desde) avisosHist.push(AV('falta', 'Falta un dato', 'Un cambio de equipos no tiene fecha, así que no se tuvo en cuenta.', '¿Desde cuándo tiene esas motobombas?', 'Anote el mes y el año en esa fila.'));
    else if (iniM && mesISO(r.desde) <= iniM) avisosHist.push(AV('no', '✗ Las fechas no cuadran', `Anotó un cambio de equipos en ${fmesISO(r.desde)}, antes del inicio que él dice (${fmes(iniM)}).`, '¿Cuándo empezó a trabajar y cuándo cambió de motobombas?', 'Corrija la fecha que esté mal.')); });
  return { F, A, A23, V, Vn, T, fac, sem, hoy, capHoy, corte, visita, fin, ini, iniM, hMed, capPost, AmaxPost, AeqPre: A - AmaxPost, hNec, diasTrab, avisosHist,
    diasPost, rObs, rEq, rDice: D, kd, dHoy, k, sinCal, iniCal, todoNuevo, eq, horasDia: nv(eq.cHoras),
    nAct, nIn: F.length - nAct, nSi: F.filter(f => f.est === 'si').length, sinProf: F.filter(f => f.sinProf).map(f => f.t.codigo || '?'),
    prodHoy: nAct || !F.length ? capHoy : 0, prodDice: nv(eq.cManif) * 365.25 * fac, prodObs: Vn / T };
}
function veredicto(f, g21) {                 // lo que muestran las imágenes de este frente, en una frase clara
  const p21 = g21 && !g21.sin ? Math.round(g21.pct * 100) : null, viejo21 = p21 != null && p21 >= 30, ha = m2 => dec(m2 / 10000, 2);
  if (f.est === 'si') return `<b class="si">✓ Ya existía antes del corte:</b> en la imagen de julio de 2023 ya se ve intervenido, al menos ${ha(f.A23)} de ${ha(f.A)} ha` + (viejo21 ? ', y en enero de 2021 también.' : '.');
  if (f.est === 'no' && viejo21) return '<b>? Las imágenes no coinciden:</b> en enero de 2021 ya estaba intervenido, en julio de 2023 se veía con monte y después se volvió a abrir.';
  if (f.est === 'no') return '<b class="no">✗ Se abrió después del corte:</b> en la imagen de julio de 2023 este sitio todavía era bosque.';
  if (viejo21) return `<b class="si">✓ Ya existía antes del corte:</b> en la imagen de enero de 2021 ya se ve intervenido (cerca del ${p21} %); el satélite de 2023 no alcanza a verlo bien.`;
  return '<b>? No se puede saber con las imágenes:</b> ' + (f.est === 'nc' ? 'el frente es muy pequeño o angosto para el satélite.' : 'en julio de 2023 no se distingue si ya estaba.') +
    (p21 != null && p21 < 10 ? ' En enero de 2021 todavía era bosque.' : '');
}
function conclusion(R) {                     // conclusión de la UPM: ¿tiene anterioridad? ¿es pequeña minería?
  const ha = m2 => dec(m2 / 10000, 2), nF = R.F.length;
  if (!nF) return { ant: 'sin frentes dibujados.', esc: 'sin frentes dibujados.' };
  const ant = R.nSi ? `<b class="si">✓ Sí.</b> ${R.nSi} de ${nF} frente${nF > 1 ? 's' : ''} ya existía${R.nSi === 1 ? '' : 'n'} antes del corte: al menos ${ha(R.A23)} ha intervenidas en julio de 2023.`
    : R.F.every(f => f.est === 'no') ? '<b class="no">✗ No, con lo trazado.</b> Todos sus frentes se abrieron después del corte.'
    : !R.k && R.fin > R.corte && R.AeqPre > 500 && !(R.Vn > R.capPost * 1.2) ? `<b>? Probable, por sus equipos.</b> Las imágenes no alcanzan, pero después del corte sus equipos solo explican ${ha(R.AmaxPost)} ha; al menos ${ha(R.AeqPre)} ha serían anteriores.`
    : '<b>? No se puede concluir con las imágenes.</b> Depende de lo visto en campo y de los documentos.';
  const esc = R.sinProf.length ? `<b>? Falta la profundidad de ${R.sinProf.join(', ')}</b> para concluir.`
    : R.prodObs > UMBRAL ? '<b class="no">✗ Supera la pequeña minería</b> (más de 165.000 m³/año según las imágenes).'
    : '<b class="si">✓ Pequeña minería</b> (menos de 165.000 m³/año según las imágenes).';
  return { ant, esc };
}
function escalaLineas(R, como) {             // las dos cifras de escala: la evidenciada (decide) y la manifestada (contraste); con «como», de dónde sale cada una
  const nueva = R.A - R.A23, hN = nueva > 0 ? R.Vn / nueva : 0, man = R.rDice > 0 ? 'lo que dice remover' : 'sus equipos';
  const ev = `· según las imágenes (evidenciado): ${miles(R.prodObs)} m³/año` + (como && nueva > 0 ? ` = ${dec(nueva / 10000, 2)} ha nuevas desde jul-2023 × ${dec(hN, 1)} m ÷ ${dec(R.T, 1)} años` : '');
  const ma = !R.nAct ? `· según ${man} (manifestado): no tiene frentes activos` : `· según ${man} (manifestado): ${miles(R.prodHoy)} m³/año` +
    (como ? ` = ${miles(R.rDice > 0 ? R.rDice : R.dHoy)} m³/día` + (R.rDice > 0 ? '' : ` (${esc(histTxt({ hist: [histDe(R.eq).slice(-1)[0]] }).replace('al empezar ', ''))} × ${dec(R.horasDia, 1)} h)`) + ` × ${dec(R.fac * 7, 1)} días a la semana todo el año` : '');
  return ev + '<br>' + ma;
}
const mesCorte = (d, R) => d ? fmes(d) + (d >= R.corte ? ' (después del corte)' : '') : '—';
function desdeCuando(R, eq, br = '<br>', tit = 'Desde cuándo trabaja (toda la UPM):') {   // con imágenes y equipos, solo con equipos, y lo que él dice
  return `${tit}${br}· según imágenes y equipos: ${R.todoNuevo ? 'después del corte (todo lo trazado se abrió desde julio de 2023)' : R.iniCal ? mesCorte(R.iniCal, R) : 'no se puede ajustar'}` +
    `${br}· ${R.rDice > 0 ? 'con lo que dice remover' : 'solo con sus equipos'}: ${R.ini ? mesCorte(R.ini, R) : '—'}${eq.guardado || R.rDice > 0 ? '' : ' (equipos sin anotar)'}${br}· lo que él dice: ${R.iniM ? fmes(R.iniM) : 'sin dato'}`;
}
const GRAVE = { no: 0, falta: 1, duda: 2, ok: 3 };
function avisosHtml(lista, max) {            // los más graves primero; los demás, plegados
  const s = [...lista].sort((a, b) => GRAVE[a.tipo] - GRAVE[b.tipo]), ver = s.slice(0, max), mas = s.slice(max);
  return ver.map(avisoHtml).join('') + (mas.length ? `<details class="mas"><summary>Ver ${mas.length} aviso${mas.length > 1 ? 's' : ''} más</summary>${mas.map(avisoHtml).join('')}</details>` : '');
}
const avisoCorto = a => `<div class="${{ no: 'alerta', ok: 'okv', duda: 'cautela', falta: 'cautela' }[a.tipo]}"><b>${esc(a.titulo)}:</b> ${esc(a.que)}` + (a.pregunta ? ` Pregúntele: «${esc(a.pregunta)}»` : '') + '</div>';
function resumenMinero(upm, R, eq) {         // resultado del minero en pocas líneas: imágenes, ritmo, desde cuándo y escala; avisos aparte
  const ha = m2 => dec(m2 / 10000, 2), nF = R.F.length;
  if (!nF) return { html: `<b>${esc(upm)}</b>: sin frentes dibujados. Dibuje sus frentes, activos e inactivos, y márquelos como frente.`, txt: `${upm}: sin frentes dibujados.`, avisos: [] };
  const p = R.A > 0 ? Math.round(R.A23 / R.A * 100) : 0, cc = conclusion(R);
  const l0 = `<b>Anterioridad:</b> ${cc.ant}<div class="sub">${desdeCuando(R, eq, '<br>', 'Desde cuándo trabaja:')}</div><b>Escala:</b> ${cc.esc}<div class="sub">${escalaLineas(R, true)}</div>`;
  const man = R.rDice > 0 ? 'lo que dice remover' : 'sus equipos';
  const aj = !R.k ? `No se ajusta: ${R.sinCal}.` : R.k >= 0.5 && R.k <= 2 ? `Las imágenes y ${man} coinciden.`
    : R.k < 1 ? `Las imágenes muestran el ${Math.round(R.k * 100)} % de ${man}: el cálculo se ajusta a lo que muestran.`
    : `Las imágenes muestran ${dec(R.k, 1)} veces ${man}: el cálculo se ajusta a lo que muestran.`;
  const l2 = `<b>Ritmo desde el corte</b>, en m³ por día de trabajo: ` + (R.diasPost ? `imágenes ${miles(R.rObs)} · ${man} ${miles(R.rEq)}. ${aj}` : `no aplica: ${R.sinCal}.`);

  const fr = R.F.map(f => `${esc(f.t.codigo || '?')}${f.inactivo ? ' inactivo' : ''} ${SIMB[f.est]}`).join(' · ');
  const l5 = `<b>Frentes:</b> ${fr}` + (eq.guardado ? '' : '. Equipos sin anotar: se usan valores por defecto.');
  const av = [...R.avisosHist];
  if (R.sinProf.length) av.push(AV('falta', 'Falta un dato', `Falta la profundidad de ${R.sinProf.join(', ')}: sin ella no se calcula su volumen ni entra en la escala.`, '¿Qué altura tiene el talud y qué profundidad la poza?', 'Anótela con «Editar frente».'));
  if (R.prodObs > UMBRAL) av.push(AV('no', '✗ Supera la pequeña minería', `Lo observado en las imágenes da ${miles(R.prodObs)} m³/año, más de 165.000.`, '¿Toda esta área es suya? ¿Desde cuándo trabaja estos frentes?', 'Revise que el trazo no incluya áreas de terceros o viejas y que la profundidad esté bien medida; si se confirma, la figura no aplica.'));
  else if (R.prodHoy > UMBRAL) av.push(AV('duda', '? La escala no cuadra', `Lo observado está bajo 165.000 m³/año, pero sus equipos de hoy lo superan (${miles(R.prodHoy)}).`, '¿Trabajan todos los equipos a la vez? ¿Cuántas horas al día?', 'Revise con él los equipos; la escala se decide con lo observado.'));
  if (R.iniM && R.iniM < R.corte && !R.F.some(f => f.est === 'si') && R.F.some(f => f.est === 'no'))
    av.push(AV('no', '✗ No cuadra con lo que él dice', `Dice que empezó en ${fmes(R.iniM)}, pero todos los frentes que usted trazó se abrieron después de julio de 2023.`, '¿Dónde trabajaba antes de 2023? ¿Me muestra esos frentes?', 'Trace esos frentes viejos: sin ellos no hay prueba de anterioridad.'));
  if (R.fin > R.corte && R.capPost > 0 && R.Vn > R.capPost * 1.2)
    av.push(AV('no', '✗ No cuadra con los equipos', 'Desde 2023 abrió más de lo que pueden mover las motobombas que dice tener.', '¿Cuántas motobombas tuvo trabajando desde 2023? ¿Alguien más trabaja estos frentes?', 'Corrija la historia de equipos con lo que diga; si hay otro minero, saque sus frentes.'));
  if (!R.k && R.capPost > 0 && R.Vn >= Math.max(1000, 0.1 * R.V) && R.Vn / R.capPost < 0.2)
    av.push(AV('duda', '? Trabaja menos de lo que dan sus equipos', 'Desde 2023 abrió menos de la quinta parte de lo que pueden mover las motobombas que dice.', '¿Cuántas horas al día bombean de verdad? ¿Trabajan todas a la vez?', 'Corrija horas, días o equipos con lo que diga.'));
  const ref = R.iniCal || R.ini;
  if (R.iniM && ref && R.iniM - ref > 365 * DIA && R.iniM < R.fin)
    av.push(AV('no', '✗ No le alcanza el tiempo', `Dice que empezó en ${fmes(R.iniM)}, pero para abrir todo esto a su ritmo tendría que haber empezado hacia ${fmes(ref)}.`, '¿Empezó antes? ¿Tuvo más motobombas en algún momento?', 'Corrija el inicio o la historia de equipos con lo que diga. Si parte del área es de otro, sáquela.'));
  if (R.iniM && R.iniM >= R.corte) av.push(AV('no', '✗ Su propio inicio es después del corte', `Él mismo dice que empezó en ${fmes(R.iniM)}, después de agosto de 2023.`, '¿Trabajó en esta zona antes de agosto de 2023, aunque fuera en otro frente?', 'Si dice que no, anótelo así: su declaración no respalda la anterioridad.'));
  if (R.iniM && R.iniM >= R.fin) av.push(AV('no', '✗ Las fechas no cuadran', `Dice que empezó en ${fmes(R.iniM)}, pero según lo que usted marcó sus frentes ya estaban parados desde ${fmes(R.fin)}.`, '¿Cuándo empezó a trabajar aquí y cuándo dejó cada frente?', 'Corrija el inicio o las fechas de «Parado desde».'));
  // sin ajuste con imágenes, el techo de sus equipos acota lo que pudo abrir después del corte: el resto tendría que ser anterior
  const lin = [l0, l2, l5];
  return { html: l0 + l2 + '<br>' + l5, txt: `${upm}. ` + sinHtml(lin.join(' ').replace(/<div class="sub">|<\/div>/g, ' ')).replace(/\s+/g, ' '), avisos: av };
}
async function abrirCalc(trazo) {            // desde un frente, o desde «Guardado» para todos los frentes del minero filtrado
  if (!trazo && FILTRO === TODOS) { avisar('Elija primero un minero en la barra de abajo'); return; }
  const upm = trazo ? trazo.upm : FILTRO, eq = await equiposDe(upm);
  CALC = { trazo: trazo || null, upm, eq, frs: null, bloq: {} };
  EQUIPO.forEach(id => { $(id).value = eq[id] ?? ''; }); pintarParadas(eq.paradas || []); pintarHist(histDe(eq));
  $('cTitMin').textContent = 'Lo que dice el minero'; notaEquipos();
  PARTES_K.forEach(k => bloquearParte(k, !!eq.partes[k])); $('cFrente').style.display = trazo ? '' : 'none';
  $('cDet').open = false; $('cResFrente').innerHTML = ''; equivPrellenar(eq);
  $('cRes').innerHTML = '<p class="nota">Calculando con Sentinel…</p>';
  if (trazo) {
    $('cArea').value = dec(trazo.area_m2 / 10000, 2); $('cProf').value = profGuardada(trazo) || ''; $('cA1').value = '…'; $('cNueva').value = '…';
    $('cOrigen').innerHTML = `${esc(trazo.codigo || '')} · ${esc(queTxt(trazo))} · ${esc(upm)}${trazo.medicion === MEDICION[1] ? ' · no visitado' : ''}`;
  } else $('cOrigen').innerHTML = `${esc(upm)}: todos sus frentes, activos e inactivos.`;
  abrir('pCalc');
  CALC.frs = await frentesDe(upm, trazo); CALC.g21 = null; calcular();
  if (trazo) { try { CALC.g21 = await verde21(trazo.vertices); } catch (e) {} calcular(); }
}
function pintarHist(H) { $('cHist').innerHTML = ''; H.forEach((r, i) => agregarHist(r, i === 0)); limiteHist(); }
function agregarHist(r = {}, primera = false) {   // primera: «al empezar», sin fecha; las demás, desde su mes y año
  const d = document.createElement('div'); d.className = 'hist';
  d.innerHTML = (primera ? '<div class="et">Al empezar<span class="nota" data-ini></span></div>' : '<input type="month" class="h-desde" aria-label="Desde (mes y año)">') +
    '<span class="u" data-u="motobombas"><input inputmode="decimal" class="h-n" aria-label="Motobombas a la vez"></span>' + (primera ? '<span></span>' : '<button aria-label="Quitar cambio">×</button>') +
    `<select class="h-pulg" aria-label="Pulgadas">${[2, 3, 4, 6, 8].map(p => `<option value="${p}">${p} pulgadas</option>`).join('')}</select><span class="h-dia"></span><input type="hidden" class="h-q">`;
  const q = c => d.querySelector(c), n = q('.h-n'), pu = q('.h-pulg'), ca = q('.h-q');
  if (!primera) q('.h-desde').value = r.desde || ''; n.value = r.n ?? 1; pu.value = String(r.pulg || 4); ca.value = r.caudal ?? CAUDAL[pu.value];
  pu.onchange = () => { ca.value = CAUDAL[pu.value] || ''; calcular(); };
  if (!primera) q('button').onclick = () => { d.remove(); limiteHist(); calcular(); };
  $('cHist').appendChild(d);
}
function diaHist() {                      // lo que mueve cada fila, en m³ de material por día de trabajo
  const rel = num('cRel') || 15, H = num('cHoras');
  [...$('cHist').children].forEach(d => { const s = d.querySelector('.h-dia'), m = nv(d.querySelector('.h-n').value) * nv(d.querySelector('.h-q').value) / rel * H; s.textContent = m > 0 ? `≈ ${miles(m)} m³/día` : ''; });
}
function limiteHist() { $('bCHist').style.display = CALC && CALC.bloq && CALC.bloq.eq || $('cHist').children.length >= 5 ? 'none' : ''; }   // al empezar y hasta 4 cambios
const leerHist = () => [...$('cHist').children].map((d, i) => { const q = c => d.querySelector(c); return { desde: i ? q('.h-desde').value : '', n: q('.h-n').value, pulg: q('.h-pulg').value, caudal: q('.h-q').value }; });
function pintarParadas(P) {                 // filas de paradas puntuales: mes y año, semanas y por qué
  const c = $('cParadas'); c.innerHTML = '';
  P.forEach(p => agregarParada(p));
}
function agregarParada(p = {}) {
  const d = document.createElement('div'); d.className = 'parada';
  d.innerHTML = `<input type="month" class="p-mes" aria-label="Desde (mes y año)"><span class="u" data-u="semanas"><input inputmode="decimal" class="p-sem" aria-label="Semanas"></span><button aria-label="Quitar parada">×</button><input class="causa p-causa" placeholder="por qué: paro, operativo, daño, combustible…" aria-label="Causa">`;
  const q = c => d.querySelector(c); q('.p-mes').value = p.mes || ''; q('.p-sem').value = p.semanas ?? ''; q('.p-causa').value = p.causa || '';
  q('button').onclick = () => { d.remove(); calcular(); };
  $('cParadas').appendChild(d);
}
const leerParadas = () => [...$('cParadas').children].map(d => ({ mes: d.querySelector('.p-mes').value, semanas: d.querySelector('.p-sem').value, causa: d.querySelector('.p-causa').value.trim() })).filter(p => p.mes || nv(p.semanas) > 0 || p.causa);
const eqForm = () => ({ ...Object.fromEntries(EQUIPO.map(id => [id, $(id).value])), paradas: leerParadas(), hist: leerHist(), guardado: CALC.eq.guardado });
const QV = { orden: ['qN', 'qPulg'] };     // equivalencia: el último que se tocó queda fijo y se calcula el otro
function equivPrellenar(eq) {
  const H = histDe(eq), hoy = H[H.length - 1] || {};
  $('qPulg').value = String(hoy.pulg || 4); $('qN').value = ''; QV.orden = ['qN', 'qPulg'];
}
function equivalencia(eq) {                  // a cuántas motobombas de chorro, de cuántas pulgadas, equivale lo que dice remover
  const D = nv(eq.cManif), H = nv(eq.cHoras), rel = nv(eq.cRel) || 15;
  $('cEquiv').style.display = D > 0 ? '' : 'none'; if (!(D > 0)) return;
  const calc = QV.orden[0]; ['qN', 'qPulg'].forEach(id => $(id).classList.toggle('calcd', id === calc));
  if (!(H > 0)) { $('qTxt').innerHTML = avisoHtml('Anote las horas de bombeo al día para calcular la equivalencia.'); return; }
  const porBomba = p => CAUDAL[p] / rel * H;   // m³ por día de trabajo que mueve una motobomba de p pulgadas
  let nota = '';
  if (calc === 'qN') $('qN').value = dec(D / porBomba($('qPulg').value), 1);
  else { const n = nv($('qN').value); if (n > 0) {
    const cada = D / n, p = Object.keys(CAUDAL).reduce((a, b) => Math.abs(Math.log(porBomba(b) / cada)) < Math.abs(Math.log(porBomba(a) / cada)) ? b : a);
    $('qPulg').value = p; nota = `Cada una tendría que mover unos ${miles(cada)} m³/día; una de ${p}" mueve unos ${miles(porBomba(p))}.`; } }
  const Hs = histDe(eq), hoy = Hs[Hs.length - 1] || {}, Dhoy = nv(hoy.n) * nv(hoy.caudal) / rel * H, r = Dhoy > 0 ? D / Dhoy : null;
  const eqs = `${dec(nv(hoy.n), 1).replace(',0', '')} de ${hoy.pulg}"`;
  const msg = r == null ? '' : r > 1.5 ? avisoHtml(AV('no', '✗ No cuadra con sus equipos de hoy', `Con ${eqs} saldrían unos ${miles(Dhoy)} m³/día, y él dice ${miles(D)}.`, '¿Con qué equipos mueve eso? ¿Tiene más motobombas trabajando?', null))
    : r < 0.5 ? avisoHtml(AV('duda', '? Dice menos de lo que dan sus equipos de hoy', `Con ${eqs} saldrían unos ${miles(Dhoy)} m³/día, y él dice ${miles(D)}.`, '¿Cuántas horas al día bombean de verdad?', null))
    : avisoHtml(AV('ok', '✓ Cuadra con sus equipos de hoy', `Con ${eqs} saldrían unos ${miles(Dhoy)} m³/día; él dice ${miles(D)}.`));
  $('qTxt').innerHTML = (nota ? `<p class="nota">${nota}</p>` : '') + msg;
}
function cajaSentinel(st, A) {               // detalle del método relativo para el frente abierto
  const fm = f => { const [y, mo, dd] = f.split('-'); return `${+dd}-${MESES[+mo - 1]}-${y}`; }, ha = m2 => dec(m2 / 10000, 2);
  let t = `<b>Calculado automáticamente con Sentinel</b>${st.fecha23 ? ` (${fm(st.fecha23)} frente a ${fm(st.fecha26)})` : ''}<br><span class="nota">Lo que es minería lo define tu trazo en Google; Sentinel solo compara ese mismo sitio en las dos fechas contra el bosque de alrededor.</span><br>`;
  if (st.error) return t + 'No se pudieron leer las imágenes de Sentinel.';
  if (st.fuera) return t + 'El área está fuera de la zona con datos de Sentinel.';
  if (st.sinAnillo) return t + 'No hay bosque alrededor para tomar como referencia (nubes o borde de la zona).';
  if (st.R == null || st.alt < 15) return t + `Dentro del área, Sentinel ve alterados en 2026 solo ${st.alt} de ${st.n} píxeles de 10 m: frente muy angosto o pequeño para Sentinel. No es concluyente; use la alta resolución y lo visto en campo.`;
  return t + `<table class="tsent"><tr><td>Área en Google 2026 (lo trazado)</td><td><b>${ha(A)} ha</b></td></tr>` +
    `<tr><td>Píxeles de 10 m dentro · alterados en 2026</td><td>${st.n} · ${st.alt} (${Math.round(st.alt / st.n * 100)} %)</td></tr>` +
    `<tr><td>Bosque de referencia (NDVI) 2023 · 2026${st.refZona ? ' (el típico de la ZRP)' : ''}</td><td>${dec(st.f23, 2)} · ${dec(st.f26, 2)}</td></tr>` +
    `<tr><td>Ya alterado en jul-2023 (valor central)</td><td>${Math.round(st.R * 100)} % → ${ha(A * st.R)} ha</td></tr>` +
    `<tr><td>Margen (desfase de 10 m y bordes)</td><td>${Math.round(st.Rmin * 100)}–${Math.round(st.Rmax * 100)} %</td></tr>` +
    `<tr><td>Se toma el límite bajo: al menos</td><td><b class="si">${ha(A * Math.max(0, st.Rmin))} ha</b></td></tr></table>` +
    cautelas(st).map(c => `<div class="cautela">${esc(c)}</div>`).join('');
}
function calcular() {
  if (!CALC || !CALC.frs) return;
  const eq = eqForm(), tr = CALC.trazo, upm = CALC.upm, ha = m2 => dec(m2 / 10000, 2); diaHist();
  const R = analizar(CALC.frs, eq, t => tr && t.id === tr.id ? num('cProf') : profGuardada(t)); CALC.R = R;
  const lineas = [`Cálculo de anterioridad (estimado) · ${upm} · ${fechaLocal(new Date()).slice(0, 16)}`,
    'Fuentes: áreas trazadas sobre Google y en campo (evidenciado); proporción ya intervenida en julio de 2023 calculada con Sentinel-2, con el límite bajo del margen; equipos, régimen, paradas, inicio y producción, manifestados salvo que se hayan visto; ritmo desde el corte medido con las imágenes y la profundidad de campo, usado para ajustar la capacidad teórica de los equipos; inicio calculado, capacidad y escala, calculados por la ANM.'];
  const et = $('cHist').querySelector('[data-ini]'); if (et) et.textContent = eq.cInicio ? ` (${fmesISO(eq.cInicio)})` : '';
  if (tr) {
    const f = R.F.find(x => x.t.id === tr.id);
    $('cA1').value = f.est === 'nc' ? 'no se sabe' : ha(f.A23); $('cNueva').value = f.est === 'nc' ? 'no se sabe' : ha(f.A - f.A23);
    $('cSent').innerHTML = cajaSentinel(f.st, f.A);
    const h = `<div class="caja calc">${veredicto(f, CALC.g21)}<br>` + (f.sinProf ? '<b class="no">Falta la profundidad</b> (altura del talud + profundidad de la poza): sin ella no se calcula su volumen.' : `Volumen del frente: ${miles(f.V)} m³ (${ha(f.A)} ha × ${dec(f.h, 1)} m).`) + '</div>';
    $('cResFrente').innerHTML = h + avisosHtml([...noCuadraEquipos(f, R), ...alertasFrente(tr, f.st, f.A, eq.cCorte, CALC.g21)], 1);
    lineas.push(`Frente ${tr.codigo || ''} (${queTxt(tr).toLowerCase()}): ${ha(f.A)} ha trazadas. ` +
      (f.st && f.st.R != null && f.est !== 'nc' ? `Sentinel ${f.st.fecha23} frente a ${f.st.fecha26}, método relativo al bosque de alrededor (valor central ${Math.round(f.st.R * 100)} %, margen ${Math.round(f.st.Rmin * 100)}–${Math.round(f.st.Rmax * 100)} %): ` : '') + sinHtml(veredicto(f, CALC.g21)) +
      ` Profundidad ${dec(f.h, 1)} m, volumen ${miles(f.V)} m³.` +
      (tr.veg_m2 ? ` Área trazada ${ha(tr.area_trazada_m2)} ha, sin ${ha(tr.veg_m2)} ha de vegetación detectada en Google.` : ''));
  }
  const res = resumenMinero(upm, R, eq);
  $('cRes').innerHTML = `<div class="caja calc">${res.html}</div>` + avisosHtml(res.avisos, 2);
  equivalencia(eq);
  lineas.push(res.txt);
  lineas.push(`Equipos (manifestados): motobombas de chorro a la vez ${histTxt(eq)} (${dec(nv(eq.cRel) || 15, 0)} m³ de agua por m³ de grava), ${dec(nv(eq.cHoras), 1)} h/día, ${dec(nv(eq.cDias), 1)} días/semana` + (paradasTxt(eq.paradas) ? `; paradas: ${paradasTxt(eq.paradas)}.` : '.') +
    (R.rDice > 0 ? ` Material que dice remover: ${miles(R.rDice)} m³ por día de trabajo (con sus equipos de hoy serían ${miles(R.dHoy)}); el cálculo usa esa cifra.` : ''));
  if (R.F.length) lineas.push(`Ajuste con las imágenes: ` + (R.k ? `lo abierto desde jul-2023 (${miles(R.Vn)} m³) es el ${Math.round(R.k * 100)} % de lo que sus equipos movían en teoría en ese tiempo (${miles(R.capPost)} m³); con ese factor, inicio a más tardar ${R.todoNuevo ? 'después del corte (todo lo trazado se abrió desde julio de 2023)' : R.iniCal ? fmes(R.iniCal) : 'sin estimar'}.` : `no se hizo (${R.sinCal}).`));
  if (res.avisos.length) lineas.push('Avisos: ' + res.avisos.map(avisoTxt).join(' | '));
  RESUMEN = lineas.join('\n');
}
async function calcGuardar() {               // guarda los equipos del minero y, si viene de un frente, su profundidad y resultado
  if (!CALC || !CALC.R) return;
  if (CALC.trazo && !(num('cProf') > 0)) { avisar('Anote la profundidad del frente (altura del talud + profundidad de la poza)'); $('cProf').focus(); return; }
  const eq = eqForm(), tr = CALC.trazo, g = await equiposGuardar(CALC.upm, eq); CALC.eq.partes = fechasDe(g); CALC.eq.guardado = true;
  PARTES_K.forEach(k => bloquearParte(k, k === 'man' ? nv(eq.cManif) > 0 : true)); notaEquipos();
  await metaSet('calcUltimo', { cCorte: eq.cCorte });
  let msg = `Equipos de ${CALC.upm} guardados`;
  if (tr) {
    const f = CALC.R.F.find(x => x.t.id === tr.id), fecha = fechaLocal(new Date()), st = f.st || {};
    const nuevo = { ...((await trazoGet(tr.id)) || tr), prof: f.h, ant: { prof: f.h, fecha, sentinel: f.est, area_ha: +(f.A / 10000).toFixed(2), al_menos_ha: +(f.A23 / 10000).toFixed(2),
      pct: f.A > 0 ? Math.round(f.A23 / f.A * 100) : 0, R: st.R ?? null, Rmin: st.Rmin ?? null, Rmax: st.Rmax ?? null, inicio: f.ini ? isoMes(f.ini) : null }, calc: { resumen: RESUMEN, fecha } };
    await trazoGuardar(nuevo); CALC.trazo = nuevo; CALC.frs = CALC.frs.map(x => x.t.id === nuevo.id ? { ...x, t: nuevo } : x);
    msg = `Guardado en ${rotulo(nuevo)} y equipos de ${CALC.upm}`;
  }
  await pintarTrazos(); calcular(); avisar(msg);
}
async function calcCopiar() {
  try { await navigator.clipboard.writeText(RESUMEN); avisar('Resumen copiado'); } catch (e) { avisar('No se pudo copiar'); }
}
async function fichaAnt(t, el, pop) {        // en la ficha del frente: lo que dicen las imágenes, desde cuándo trabaja y, si hay, el aviso más importante
  const eq = await equiposDe(t.upm), R = analizar(await frentesDe(t.upm, t), eq), f = R.F.find(x => x.t.id === t.id);
  let g21 = null; try { g21 = await verde21(t.vertices); } catch (e) {}
  const av = [...noCuadraEquipos(f, R), ...alertasFrente(t, f.st, f.A, eq.cCorte, g21)].sort((a, b) => GRAVE[a.tipo] - GRAVE[b.tipo]);
  const cc = conclusion(R);
  el.innerHTML = `<b>Este frente:</b> ${veredicto(f, g21)}<div class="lmin"><b>Conclusión de la UPM</b><br>· Anterioridad: ${cc.ant}<div class="sub">${desdeCuando(R, eq, '<br>', 'Desde cuándo trabaja:')}</div>` +
    `· Escala: ${cc.esc}<div class="sub">${escalaLineas(R, false)}</div></div>` + (av.length ? avisoCorto(av[0]) : '');
  if (pop && pop.isOpen()) pop.update();
}
const noCuadraEquipos = (f, R) => f.est === 'no' && f.ini && f.ini < R.corte ? [AV('no', '✗ No cuadra con los equipos', 'Las imágenes muestran que este frente se abrió después de 2023, pero con las motobombas que dice no le alcanzaba el tiempo para abrirlo.', '¿Cuántas motobombas trabajaron este frente? ¿Qué tan hondo es el corte?', 'Corrija la historia de equipos o la profundidad con lo que diga.')] : [];

const PANEL_SENT = { t: null, e: null };
function alertasFrente(fr, st, A, corteISO, g21) { // lo marcado que contradice las imágenes; no bloquea, guía
  const out = []; if (!fr || !(fr.frente || esFrente(fr))) return out;
  const corte = new Date((corteISO || CORTE) + 'T00:00'), ok = st && !st.error && !st.fuera && !st.sinAnillo;
  const p21 = g21 && !g21.sin ? Math.round(g21.pct * 100) : null;
  if (!(fr.prof || (fr.ant && fr.ant.prof))) out.push(AV('falta', 'Falta un dato', 'No tiene anotada la profundidad del frente, y sin ella no se calcula su volumen.', '¿Qué altura tiene el talud y qué profundidad la poza?', 'Anótela con «Editar frente».'));
  if (fr.estado === 'Inactivo') {
    if (!fr.parado_desde) out.push(AV('falta', 'Falta un dato', 'No anotó desde cuándo está parado este frente, y sin eso no se puede comparar con las imágenes.', '¿Desde cuándo no trabaja este frente?', 'Anótelo en «Parado desde» con «Editar frente».'));
    else {
      if (ok && st.R != null && st.alt >= 15 && mesISO(fr.parado_desde) < corte) {
        const nuevo = A * (1 - st.Rmax);
        if (nuevo >= Math.max(1000, 0.15 * A)) out.push(AV('no', '✗ No cuadra', `Usted lo marcó parado desde ${fmesISO(fr.parado_desde)}, pero las imágenes muestran que después de 2023 se abrieron unas ${dec(nuevo / 10000, 2)} ha más.`,
          '¿Este frente se volvió a trabajar después de 2023? ¿Quién lo trabajó?', 'Si él lo reactivó, márquelo activo. Si lo trabajó otro, saque esa parte del trazo.'));
      }
      if (p21 != null && p21 < 10 && mesISO(fr.parado_desde) < new Date('2021-01-20T00:00')) out.push(AV('no', '✗ No cuadra', `Usted lo marcó parado desde ${fmesISO(fr.parado_desde)}, pero en enero de 2021 ese sitio todavía era bosque.`,
        '¿Cuándo dejó de trabajar este frente?', 'Corrija la fecha de «Parado desde» con lo que él diga.'));
    }
  }
  if (fr.estado === 'Activo' && ok && st.n >= 30) {
    if (st.alt / st.n < 0.2) out.push(AV('no', '✗ No cuadra', 'Usted lo marcó activo, pero en las imágenes de 2026 no se ve tierra removida en este sitio.',
      '¿Cuándo trabajó aquí por última vez?', 'Si no se trabaja hace meses, márquelo inactivo con esa fecha. Solo un frente de menos de 20 m de ancho se le escapa al satélite.'));
    else if (st.rev / st.n >= 0.4) out.push(AV('no', '✗ No cuadra', 'Usted lo marcó activo, pero las imágenes muestran que entre 2023 y 2026 este sitio se fue llenando de monte.',
      '¿Sigue trabajando aquí? ¿Desde cuándo está quieto?', 'Si está quieto, márquelo inactivo con esa fecha.'));
  }
  return out;
}
async function vistaSentinel(x, vertices, A) { // al guardar o editar un área: lo que ven las imágenes antes de elegir
  const box = $(x + 'Sent'); box.style.display = ''; box.innerHTML = 'Mirando el trazo en las imágenes…';
  let st; try { st = relativoSentinel(await cargarNDVI(), [vertices]); } catch (e) { st = { error: true }; }
  let g21 = null; try { g21 = await verde21(vertices); } catch (e) {}
  PANEL_SENT[x] = { st, A, g21 }; const e = evalSent(st, A);
  const nuevo = e.est === 'nc' ? 0 : A * (1 - st.Rmax);
  box.innerHTML = '<b>Lo que muestran las imágenes:</b> ' + (e.est === 'nc' ? 'el trazo es muy pequeño o angosto para el satélite.'
    : `en julio de 2023 ya estaba intervenido cerca del ${Math.round(st.R * 100)} %` + (nuevo >= 500 ? `; después se abrieron unas ${dec(nuevo / 10000, 2)} ha más.` : '; después casi no creció.')) + ' ' + texto21(g21);
  alertasPanel(x);
}
function alertasPanel(x) {
  const el = $(x + 'Alerta'), d = PANEL_SENT[x]; if (!el) return; if (!d) { el.innerHTML = ''; return; }
  const fr = frLeer(x); el.innerHTML = fr.falta || !fr.frente ? '' : contraste(fr, d.st, d.A, null, d.g21).filter(a => a.titulo !== '✓ Cuadra').map(avisoHtml).join('');   // el ✓ simple ya lo dice el recuadro de imágenes
}
async function pintarTrazos() {              // en el color del minero asignado; sin minero, líneas celestes y áreas blancas
  const ts = (await trazosTodos()).filter(pasaFiltro); capaLineas.clearLayers(); capaAreas.clearLayers();
  ts.forEach(t => {
    const vs = t.vertices.map(([a, b]) => L.latLng(a, b));
    if (t.tipo === 'area') {
      const col = colorDe(t.upm) || '#ffffff', hu = t.que === HUELLA || (esFrente(t) && t.estado === 'Inactivo');   // frentes inactivos (y huellas viejas) punteados
      L.polygon(vs, { color: '#000', weight: 5, opacity: .35, fill: false, interactive: false }).addTo(capaAreas);
      L.polygon(vs, { color: col, weight: 3, dashArray: hu ? '10 8' : null, fillColor: col, fillOpacity: hu ? .08 : .18, interactive: false }).addTo(capaAreas);
      if (t.veg_url) L.imageOverlay(t.veg_url, t.veg_bounds, { opacity: .7, interactive: false }).addTo(capaAreas);   // vegetación que se quitó del área
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
  const AN = {};                              // análisis de cada minero con frentes, con lo guardado en el teléfono
  for (const u of [...new Set(ts.filter(esFrente).map(t => t.upm))]) { const eq = await equiposDe(u); AN[u] = { eq, R: analizar(await frentesDe(u), eq) }; }
  const fi = t => esFrente(t) && AN[t.upm] ? AN[t.upm].R.F.find(f => f.t.id === t.id) : null;
  const cabT = ['n', 'consecutivo', 'nombre', 'tipo', 'que_es', 'upm', 'nota', 'fecha_hora', 'longitud_o_perimetro_m', 'area_ha', 'area_m2', 'vertices', 'tramos_m', 'vertices_ctm12_este_norte', 'centro_ctm12_este', 'centro_ctm12_norte', 'como_se_midio',
    'area_trazada_ha', 'arboles_quitados_ha', 'es_frente', 'estado_frente', 'parado_desde', 'google_2021_intervenido_pct', 'profundidad_m', 'sentinel_anterior_al_corte', 'intervenida_jul2023_al_menos_ha', 'intervenida_jul2023_pct', 'inicio_frente_a_mas_tardar', 'alertas', 'alertas_al_guardar', 'anterioridad_guardada', 'calculo_anterioridad'];
  const G21 = {}; for (const t of ts.filter(esFrente)) { try { G21[t.id] = await verde21(t.vertices); } catch (e) {} }
  const filasT = ts.map((t, i) => { const f = fi(t), g = G21[t.id]; return [i + 1, t.codigo || '', q(t.nombre), t.tipo === 'area' ? 'área' : 'línea', q(t.que), q(t.upm), q(t.nota), t.local, c(t.longitud_m),
    t.area_m2 != null ? c((t.area_m2 / 10000).toFixed(2)) : '', t.area_m2 ?? '', t.vertices.length, q(t.tramos_m.map(c).join(' | ')), q(t.ctm.map(([e, n]) => `${e} ${n}`).join(' | ')), t.tipo === 'area' ? centroCTM(t)[0] : '', t.tipo === 'area' ? centroCTM(t)[1] : '', q(t.medicion || ''),
    t.area_trazada_m2 ? c((t.area_trazada_m2 / 10000).toFixed(2)) : '', t.veg_m2 ? c((t.veg_m2 / 10000).toFixed(2)) : '',
    t.tipo === 'area' ? (esFrente(t) ? 'sí' : 'no') : '', q(t.estado || ''), t.parado_desde || '', g && !g.sin ? Math.round(g.pct * 100) : (esFrente(t) ? 'sin imagen' : ''), f ? c(f.h) : '', f ? EST_T[f.est] : '', f ? c((f.A23 / 10000).toFixed(2)) : '', f && f.A ? Math.round(f.A23 / f.A * 100) : '',
    f && f.ini ? isoMes(f.ini) : '', q(f ? alertasFrente(t, f.st, f.A, AN[t.upm].eq.cCorte, G21[t.id]).map(avisoTxt).join(' | ') : ''), q((t.alertas_al_guardar || []).join(' | ')), t.ant ? q(t.ant.fecha) : '', q(t.calc ? t.calc.resumen.replace(/\n/g, ' ') : '')].join(';'); });
  const csvT = '﻿' + cabT.join(';') + '\n' + filasT.join('\n') + '\n';
  const cabM = ['minero', 'frentes', 'activos', 'inactivos', 'area_frentes_ha', 'intervenida_jul2023_al_menos_ha', 'intervenida_jul2023_pct', 'frentes_con_anterioridad', 'inicio_calculado', 'inicio_manifestado',
    'produccion_hoy_m3_ano', 'material_que_dice_remover_m3_ano', 'produccion_observada_desde_corte_m3_ano', 'supera_165000_segun_lo_observado', 'historia_equipos', 'motobombas_hoy', 'pulgadas_hoy', 'agua_por_grava',
    'horas_dia', 'dias_semana', 'paradas_puntuales', 'produccion_que_dice_m3_dia', 'fecha_corte', 'fecha_visita', 'equipos_anotados',
    'ritmo_imagenes_m3_dia', 'ritmo_equipos_m3_dia', 'factor_ajuste_imagenes', 'inicio_ajustado_con_imagenes', 'por_que_no_se_ajusto'];
  const filasM = Object.entries(AN).map(([u, { eq, R }]) => [q(u), R.F.length, R.nAct, R.nIn, c((R.A / 10000).toFixed(2)), c((R.A23 / 10000).toFixed(2)), R.A ? Math.round(R.A23 / R.A * 100) : '', R.nSi,
    R.ini ? isoMes(R.ini) : '', eq.cInicio || '', Math.round(R.prodHoy), Math.round(R.prodDice), Math.round(R.prodObs), R.prodObs > UMBRAL ? 'sí' : 'no',
    q(histTxt(eq)), c(R.hoy.n), R.hoy.pulg, c(nv(eq.cRel)), c(nv(eq.cHoras)), c(nv(eq.cDias)), q(paradasTxt(eq.paradas)), c(nv(eq.cManif)), eq.cCorte, eq.cVisita, eq.guardado ? 'sí' : 'no (valores por defecto)',
    R.diasPost ? Math.round(R.rObs) : '', R.diasPost ? Math.round(R.rEq) : '', R.k ? c(R.k.toFixed(2)) : '', R.iniCal ? isoMes(R.iniCal) : '', q(R.todoNuevo ? 'todo lo trazado se abrió después del corte' : R.k ? '' : R.sinCal)].join(';'));
  const csvM = filasM.length ? '﻿' + cabM.join(';') + '\n' + filasM.join('\n') + '\n' : '';
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
        area_m2: t.area_m2, area_ha: t.area_m2 != null ? +(t.area_m2 / 10000).toFixed(2) : null, tramos_m: t.tramos_m, vertices_ctm12: t.ctm, centro_ctm12: t.tipo === 'area' ? centroCTM(t) : null, como_se_midio: t.medicion || null,
        area_trazada_m2: t.area_trazada_m2 || null, arboles_quitados_m2: t.veg_m2 || null,
        es_frente: t.tipo === 'area' ? esFrente(t) : null, estado_frente: t.estado || null, parado_desde: t.parado_desde || null,
        google_2021_intervenido_pct: G21[t.id] && !G21[t.id].sin ? Math.round(G21[t.id].pct * 100) : null, alertas_al_guardar: t.alertas_al_guardar || null,
        ...(fi(t) ? { profundidad_m: fi(t).h, sentinel_anterior_al_corte: EST_T[fi(t).est], intervenida_jul2023_al_menos_ha: +(fi(t).A23 / 10000).toFixed(2), inicio_frente_a_mas_tardar: fi(t).ini ? isoMes(fi(t).ini) : null } : {}),
        calculo_anterioridad: t.calc ? t.calc.resumen : null } }))] }, null, 1);
  const d = new Date(), z = n => String(n).padStart(2, '0');
  const base = `ZRP753_campo_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
  return { pts, ts, csv, csvT, csvM, kml, gj, base };
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
  const z = new JSZip(); z.file(x.base + '_puntos.csv', x.csv); if (x.ts.length) z.file(x.base + '_lineas_y_areas.csv', x.csvT); if (x.csvM) z.file(x.base + '_resumen_mineros.csv', x.csvM);
  z.file(x.base + '.kml', x.kml); z.file(x.base + '.geojson', x.gj);
  const blob = await z.generateAsync({ type: 'blob' });
  await compartir([new File([blob], x.base + '.zip', { type: 'application/zip' })]);
}
async function exportarCsv() {
  const x = await datosExport(); if (!x.pts.length && !x.ts.length) { avisar('No hay nada para exportar'); return; }
  const fs = [new File([x.csv], x.base + '_puntos.csv', { type: 'text/csv' })];
  if (x.ts.length) fs.push(new File([x.csvT], x.base + '_lineas_y_areas.csv', { type: 'text/csv' }));
  if (x.csvM) fs.push(new File([x.csvM], x.base + '_resumen_mineros.csv', { type: 'text/csv' }));
  await compartir(fs);
}
async function copiarTexto() {
  const x = await datosExport(); if (!x.pts.length && !x.ts.length) { avisar('No hay nada para copiar'); return; }
  try { await navigator.clipboard.writeText((x.csv + (x.ts.length ? '\n' + x.csvT : '') + (x.csvM ? '\n' + x.csvM : '')).replace(/﻿/g, '')); avisar('Copiado: pégalo en WhatsApp o en un correo'); }
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
$('bMedDeshacer').onclick = () => { VERT.pop(); VEG = null; pintarMed(); };
$('bMedFin').onclick = () => medirFin(true);
$('bMedArea').onclick = () => { CERRADA = !CERRADA; VEG = null; marcarArea(); pintarMed(); };
$('bMedGuardar').onclick = medirGuardar;
$('bTCancelar').onclick = () => abrir(null); $('bTGuardar').onclick = trazoConfirmar;
$('bMedir').onclick = medirAbrir;
$('filtros').onclick = e => { const v = e.target.dataset.v; if (v) alternarVer(v); };
$('fMinero').onchange = async e => { FILTRO = e.target.value; await pintarMios(); await pintarTrazos(); };
$('fUpm').onchange = e => otroMinero(e.target); $('tUpm').onchange = async e => { await otroMinero(e.target); tituloT(); }; $('eUpm').onchange = e => otroMinero(e.target);
$('bCalc').onclick = () => abrirCalc(null);
$('pCalc').addEventListener('input', calcular);
$('bCParada').onclick = () => { agregarParada(); };
$('bCHist').onclick = () => { const H = leerHist(), u = H[H.length - 1] || {}; agregarHist({ n: u.n, pulg: u.pulg, caudal: u.caudal }); limiteHist(); calcular(); };
$('tParado').oninput = () => alertasPanel('t'); $('eParado').oninput = () => alertasPanel('e');
$('bMedVeg').onclick = () => { if (!(CERRADA && VERT.length > 2)) return; const m = medidas(VERT, true); VEG = null; pintarMed();
  proponerVeg(VERT.map(v => [v.lat, v.lng]), m.area, r => { VEG = r; pintarMed(); }); };
$('bVegSi').onclick = () => { const p = VEG_PROP; $('pVeg').classList.remove('abierto'); capaVeg.clearLayers(); VEG_PROP = null; if (p) p.alAceptar(p.r); };
$('bVegNo').onclick = () => { $('pVeg').classList.remove('abierto'); capaVeg.clearLayers(); VEG_PROP = null; };
document.querySelectorAll('.seg.opc').forEach(g => g.addEventListener('click', e => { const v = e.target.closest('button')?.dataset.v; if (v == null) return;
  segPoner(g.id, v); frRefrescar(g.id[0]); }));
$('bCCopiar').onclick = calcCopiar; $('bCGuardar').onclick = calcGuardar;
['qN', 'qPulg'].forEach(id => $(id).addEventListener('input', () => { QV.orden = [...QV.orden.filter(x => x !== id), id]; }));   // antes que el «input» del panel, que recalcula
PARTES_K.forEach(k => { $('bG' + k).onclick = () => guardarParte(k); }); $('bXman').onclick = eliminarDice;
$('bCCerrar').onclick = () => abrir(null);
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
  for (const t of (await trazosTodos()).filter(t => esFrente(t) && !t.frente_n).sort((a, b) => a.fecha < b.fecha ? -1 : 1)) {
    const n = await numeroLibre(t.upm, t.id); await trazoGuardar({ ...t, frente_n: n, codigo: 'F' + n, codigo_area: t.codigo });
  }
  // nombres agregados en campo: solo quedan los que tienen algo tomado; los de prueba sin registros desaparecen al abrir
  const usados = new Set([...(await puntosTodos()), ...(await trazosTodos())].map(r => r.upm).filter(u => u && u !== SIN && u !== OTRO));
  EXTRA = [...usados]; await metaSet('personasExtra', EXTRA);
  await cargarCapas();
  const eqs = (await metaGet('equipos')) || {}, sobran = Object.keys(eqs).filter(u => !PERSONAS.includes(u) && !usados.has(u));
  if (sobran.length) { sobran.forEach(u => delete eqs[u]); await metaSet('equipos', eqs); } await pintarMios(); await pintarTrazos(); aplicarVer(); actualizarMira(); iniciarGPS();
  if ('serviceWorker' in navigator) {        // al publicar una versión nueva, recarga una vez para estrenarla
    const habia = !!navigator.serviceWorker.controller; let recargada = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (habia && !recargada) { recargada = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
