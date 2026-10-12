/* Campo ZRP 753 — app web sin conexión para tomar puntos en campo.
   Mapas, nombres de mineros y puntos tomados se guardan solo en el teléfono (IndexedDB). */
'use strict';
const CTM12 = '+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const aCTM = (lat, lon) => proj4('EPSG:4326', CTM12, [lon, lat]);           // -> [Este, Norte]
const miles = v => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dec = (v, n) => v.toFixed(n).replace('.', ',');
const $ = id => document.getElementById(id);

/* ---------------- IndexedDB ---------------- */
let DB;
function abrirDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('campo-zrp753', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('teselas'); d.createObjectStore('meta'); d.createObjectStore('puntos', { keyPath: 'id' }); };
    r.onsuccess = () => { DB = r.result; res(DB); };
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

/* ---------------- mapa ---------------- */
$('map').style.background = '#000';         // negro: el borde de las teselas de zoom bajo se funde con el fondo
const map = L.map('map', { zoomControl: false, attributionControl: false, preferCanvas: true, maxZoom: 20, tap: false,
  touchZoom: 'center', scrollWheelZoom: 'center', doubleClickZoom: 'center' });   // el zoom no corre la cruz
map.fitBounds([[7.636, -74.776], [7.679, -74.701]]);
const capaZRP = L.layerGroup().addTo(map), capaUPM = L.layerGroup().addTo(map), capaMios = L.layerGroup().addTo(map), capaMed = L.layerGroup().addTo(map);
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
  [['Ir a ZRP', irZRP], ['Medir', medirAbrir]].forEach(([t, f], k) => {
    const b = document.createElement('button'); b.textContent = t; b.onclick = f; b.className = 'herr';
    Object.assign(b.style, { marginTop: k ? '0' : '8px', background: 'rgba(11,47,124,.92)', borderColor: '#F9B21A', color: '#fff' });
    cont.appendChild(b);
  });
  if (CAPAS.length) verCapa(0); else { $('fecha').style.display = 'block'; $('fecha').textContent = 'Sin mapas: carga el paquete en ⚙ Datos'; }
  pintarUPM(await metaGet('upm') || []);
  llenarUPM();
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
function pintarUPM(upm) {
  capaUPM.clearLayers();
  upm.forEach(u => {
    let m;
    if (u.tipo === 'ga') {
      m = L.marker([u.lat, u.lon], { icon: L.divIcon({ className: '', iconSize: [18, 16], iconAnchor: [9, 11],
        html: `<svg width="18" height="16"><polygon points="9,1 17,15 1,15" fill="#fff" stroke="#111" stroke-width="1.2"/><polygon points="9,6 13,13 5,13" fill="${u.color}"/></svg>` }), interactive: false });
    } else {
      m = L.circleMarker([u.lat, u.lon], { radius: 6, color: '#111', weight: 1.5, fillColor: u.color, fillOpacity: 1, interactive: false });
    }
    m.bindTooltip(u.rotulo, { permanent: true, direction: 'right', className: 'rot', offset: [6, 0] }); m.addTo(capaUPM);
  });
}
function llenarUPM() {
  const s = $('fUpm'); s.innerHTML = '';
  ['— Sin asignar —', ...PERSONAS, 'Otro minero o tercero'].forEach(n => { const o = document.createElement('option'); o.textContent = n; s.appendChild(o); });
}

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
    (POS ? `<br>a ${distTxt(map.distance([POS.lat, POS.lon], c))} de ti · rumbo ${rumboTxt(rumbo(L.latLng(POS.lat, POS.lon), c))}` : '');
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
  const lejos = p.acc == null && POS ? ` · a ${distTxt(map.distance([POS.lat, POS.lon], [p.lat, p.lon]))} de ti` : '';
  c.innerHTML = `<b>E</b> ${miles(E)} &nbsp; <b>N</b> ${miles(N)}<br>${dec(p.lat, 6)}, ${dec(p.lon, 6)}` + (p.acc != null ? ` · ±${Math.round(p.acc)} m (GPS)` : ' · en la cruz' + lejos);
}
async function abrirNuevoPunto() {
  const n = (await puntosTodos()).length + 1;
  $('fNombre').value = 'P' + String(n).padStart(2, '0'); $('fNota').value = '';
  abrir('pPunto'); ponerOrigen(SEGUIR && POS ? 'gps' : 'mapa');
}
function ponerOrigen(o) {
  ORIGEN = o; [...$('segOrigen').children].forEach(b => b.classList.toggle('on', b.dataset.o === o));
  $('filaProm').style.display = o === 'mapa' ? 'none' : 'flex'; mostrarPosicionPunto();
}
async function guardarPunto(p) {
  if (!p) { avisar('No hay posición para guardar'); return; }
  const [E, N] = aCTM(p.lat, p.lon); const ahora = new Date();
  const reg = { id: ahora.getTime().toString(36) + Math.random().toString(36).slice(2, 6), nombre: $('fNombre').value.trim() || 'Punto',
    upm: $('fUpm').value, nota: $('fNota').value.trim(), fecha: ahora.toISOString(), local: fechaLocal(ahora),
    lat: +p.lat.toFixed(7), lon: +p.lon.toFixed(7), precision: p.acc != null ? Math.round(p.acc * 10) / 10 : null,
    este: Math.round(E), norte: Math.round(N), origen: p.origen, muestras: p.muestras || 1 };
  await puntoGuardar(reg); abrir(null); await pintarMios(); avisar(`Guardado ${reg.nombre} · E ${miles(E)} N ${miles(N)}`);
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
  const pts = await puntosTodos(); capaMios.clearLayers(); $('nPuntos').textContent = pts.length;
  pts.forEach(p => L.circleMarker([p.lat, p.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#C10617', fillOpacity: 1, interactive: false })
    .bindTooltip(p.nombre, { permanent: true, direction: 'right', className: 'rot rotp', offset: [6, 0] }).addTo(capaMios));
}
async function abrirLista() {
  const pts = (await puntosTodos()).sort((a, b) => a.fecha < b.fecha ? 1 : -1); const l = $('lista'); l.innerHTML = '';
  if (!pts.length) l.innerHTML = '<p class="nota">Todavía no hay puntos.</p>';
  pts.forEach(p => {
    const d = document.createElement('div'); d.className = 'item';
    d.innerHTML = `<div class="t"><b>${esc(p.nombre)}</b> · ${esc(p.upm)}<br>E ${miles(p.este)} · N ${miles(p.norte)}${p.precision != null ? ' · ±' + Math.round(p.precision) + ' m' : ''}<br><span class="nota">${esc(p.local)}${p.nota ? ' · ' + esc(p.nota) : ''}</span></div>`;
    const v = document.createElement('button'); v.textContent = 'Ver'; v.onclick = () => { abrir(null); seguir(false); map.setView([p.lat, p.lon], 18); };
    const x = document.createElement('button'); x.textContent = 'Borrar'; x.className = 'borrar';
    x.onclick = async () => { if (confirm(`¿Borrar ${p.nombre}? No se puede deshacer.`)) { await puntoBorrar(p.id); await pintarMios(); abrirLista(); } };
    d.append(v, x); l.appendChild(d);
  });
  abrir('pLista');
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- medir ---------------- */
let MIDIENDO = false, VERT = [], guiaMed = null;
function medirAbrir() { MIDIENDO = true; VERT = []; abrir(null); $('pMedir').classList.add('abierto'); $('mira').style.display = 'none'; pintarMed(); }
function medirFin() {
  MIDIENDO = false; VERT = []; capaMed.clearLayers(); if (guiaMed) { map.removeLayer(guiaMed); guiaMed = null; }
  $('pMedir').classList.remove('abierto'); $('mira').style.display = ''; actualizarMira();
}
function medirAgregar(ll) { VERT.push(L.latLng(ll)); pintarMed(); }
function pintarMed() {
  capaMed.clearLayers(); let tot = 0;
  if (VERT.length > 1) {
    L.polyline(VERT, { color: '#000', weight: 6, opacity: .4, interactive: false }).addTo(capaMed);
    L.polyline(VERT, { color: '#F9B21A', weight: 3, interactive: false }).addTo(capaMed);
  }
  VERT.forEach((v, i) => {
    if (i) tot += map.distance(VERT[i - 1], v);
    L.circleMarker(v, { radius: 5, color: '#111', weight: 1.5, fillColor: '#F9B21A', fillOpacity: 1, interactive: false })
      .bindTooltip(i ? distTxt(tot) : 'Inicio', { permanent: true, direction: 'right', className: 'rot rotm', offset: [6, 0] }).addTo(capaMed);
  });
  textoMed();
}
function textoMed() {                       // totales, último tramo y línea guía hasta la cruz
  if (!MIDIENDO) return;
  const c = map.getCenter(); let tot = 0;
  for (let i = 1; i < VERT.length; i++) tot += map.distance(VERT[i - 1], VERT[i]);
  let h = `<b>${distTxt(tot)}</b> en total · ${Math.max(VERT.length - 1, 0)} tramo(s)`;
  if (VERT.length) {
    const u = VERT[VERT.length - 1];
    if (VERT.length > 1) { const p = VERT[VERT.length - 2]; h += `<br>Último tramo: ${distTxt(map.distance(p, u))} · rumbo ${rumboTxt(rumbo(p, u))}`; }
    h += `<br>Del último punto a la cruz: ${distTxt(map.distance(u, c))} · rumbo ${rumboTxt(rumbo(u, c))}`;
    if (guiaMed) guiaMed.setLatLngs([u, c]); else guiaMed = L.polyline([u, c], { color: '#fff', weight: 2, dashArray: '6 6', interactive: false }).addTo(map);
  } else {
    h += '<br>Toca el mapa, o pon el primer punto en la cruz o en tu posición.';
    if (guiaMed) { map.removeLayer(guiaMed); guiaMed = null; }
  }
  $('medTxt').innerHTML = h;
}

/* ---------------- exportar ---------------- */
async function datosExport() {
  const pts = (await puntosTodos()).sort((a, b) => a.fecha < b.fecha ? -1 : 1);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cab = ['n', 'nombre', 'upm', 'nota', 'fecha_hora', 'latitud', 'longitud', 'precision_m', 'este_ctm12', 'norte_ctm12', 'origen', 'lecturas'];
  const filas = pts.map((p, i) => [i + 1, q(p.nombre), q(p.upm), q(p.nota), p.local, p.lat.toFixed(6).replace('.', ','), p.lon.toFixed(6).replace('.', ','), p.precision != null ? String(p.precision).replace('.', ',') : '', p.este, p.norte, q(p.origen), p.muestras].join(';'));
  const csv = '﻿' + cab.join(';') + '\n' + filas.join('\n') + '\n';
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Puntos de campo ZRP 753</name>` +
    pts.map(p => `<Placemark><name>${esc(p.nombre)}</name><description>${esc(`${p.upm} · ${p.local} · E ${p.este} N ${p.norte} (CTM12) · ±${p.precision ?? '-'} m · ${p.origen}${p.nota ? ' · ' + p.nota : ''}`)}</description><Point><coordinates>${p.lon},${p.lat},0</coordinates></Point></Placemark>`).join('') +
    `</Document></kml>\n`;
  const gj = JSON.stringify({ type: 'FeatureCollection', features: pts.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { ...p } })) }, null, 1);
  const d = new Date(), z = n => String(n).padStart(2, '0');
  const base = `ZRP753_puntos_campo_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
  return { pts, csv, kml, gj, base };
}
async function compartir(archivo) {
  if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
    try { await navigator.share({ files: [archivo], title: archivo.name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(archivo); a.download = archivo.name; document.body.appendChild(a); a.click(); a.remove();
}
async function exportarZip() {
  const x = await datosExport(); if (!x.pts.length) { avisar('No hay puntos para exportar'); return; }
  const z = new JSZip(); z.file(x.base + '.csv', x.csv); z.file(x.base + '.kml', x.kml); z.file(x.base + '.geojson', x.gj);
  const blob = await z.generateAsync({ type: 'blob' });
  await compartir(new File([blob], x.base + '.zip', { type: 'application/zip' }));
}
async function exportarCsv() {
  const x = await datosExport(); if (!x.pts.length) { avisar('No hay puntos para exportar'); return; }
  await compartir(new File([x.csv], x.base + '.csv', { type: 'text/csv' }));
}
async function copiarTexto() {
  const x = await datosExport(); if (!x.pts.length) { avisar('No hay puntos para copiar'); return; }
  try { await navigator.clipboard.writeText(x.csv.replace('﻿', '')); avisar('Copiado: pégalo en WhatsApp o en un correo'); }
  catch (e) { avisar('No se pudo copiar; usa «Compartir solo CSV»'); }
}

/* ---------------- paquete de datos ---------------- */
async function estadoDatos() {
  const capas = (await metaGet('capas')) || [], upm = (await metaGet('upm')) || [], pts = await puntosTodos();
  let est = '';
  try { const e = await navigator.storage.estimate(); est = ` · ${(e.usage / 1e6).toFixed(0)} MB usados`; } catch (e) {}
  $('estadoDatos').innerHTML = capas.length ? `<b>Mapas:</b> ${capas.map(c => c.boton).join(', ')}<br><b>Puntos de UPM:</b> ${upm.length} · <b>Tus puntos:</b> ${pts.length}${est}`
                                            : `Sin mapas cargados. Tus puntos: ${pts.length}${est}`;
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
$('bMedFin').onclick = medirFin;
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
$('bBorrarPuntos').onclick = async () => { if (!confirm('¿Borrar TODOS tus puntos? Exporta antes. No se puede deshacer.')) return;
  await tx('puntos', 'readwrite', s => s.clear()); await pintarMios(); estadoDatos(); };

(async () => {
  await abrirDB();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  await cargarZRP(); await cargarCapas(); await pintarMios(); actualizarMira(); iniciarGPS();
  if ('serviceWorker' in navigator) {        // al publicar una versión nueva, recarga una vez para estrenarla
    const habia = !!navigator.serviceWorker.controller; let recargada = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (habia && !recargada) { recargada = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
