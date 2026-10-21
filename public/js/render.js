/**
 * Rendu canvas : des milliers d'avions sans tuer le navigateur.
 * - orientés selon le cap, couleur selon l'altitude
 * - interpolation locale entre deux mises à jour (cap + vitesse)
 * - étiquettes intelligentes : callsign (+ altitude / vitesse au zoom élevé),
 *   sans chevauchement grâce à une grille d'occupation
 */
import { CONFIG, planes, state } from './state.js';
import { map } from './map.js';
import { passesFilters, isEmergency } from './filters.js';

// ── Calque canvas ───────────────────────────────────────────────────────────
const PlaneLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'plane-canvas');
    this._ctx = this._canvas.getContext('2d');
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on('move resize zoomend', this._reposition, this);
    this._resize();
    this._reposition();
  },
  onRemove(map) {
    map.off('move resize zoomend', this._reposition, this);
    this._canvas.remove();
  },
  _resize() {
    const size = this._map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = size.x * dpr;
    this._canvas.height = size.y * dpr;
    this._canvas.style.width = size.x + 'px';
    this._canvas.style.height = size.y + 'px';
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._size = size;
  },
  _reposition() {
    const size = this._map.getSize();
    if (!this._size || size.x !== this._size.x || size.y !== this._size.y) this._resize();
    L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
  },
  ctx() { return this._ctx; },
  size() { return this._size; },
});

export const layer = new PlaneLayer();
map.addLayer(layer);

// ── Couleur selon l'altitude ────────────────────────────────────────────────
const ALT_STOPS_DARK = [
  [0, [91, 107, 127]], [3000, [47, 127, 216]], [10000, [53, 193, 138]],
  [20000, [143, 209, 79]], [30000, [232, 195, 61]], [40000, [242, 245, 248]],
];
// en thème clair, le blanc des hautes altitudes disparaîtrait sur la carte
const ALT_STOPS_LIGHT = [
  [0, [110, 120, 135]], [3000, [37, 99, 235]], [10000, [16, 150, 105]],
  [20000, [101, 163, 13]], [30000, [217, 119, 6]], [40000, [190, 24, 93]],
];

export function altColor(alt) {
  const stops = state.theme === 'light' ? ALT_STOPS_LIGHT : ALT_STOPS_DARK;
  if (alt == null) return 'rgb(120,130,145)';
  for (let i = 1; i < stops.length; i++) {
    const [a0, c0] = stops[i - 1];
    const [a1, c1] = stops[i];
    if (alt <= a1 || i === stops.length - 1) {
      const t = Math.max(0, Math.min(1, (alt - a0) / (a1 - a0)));
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(242,245,248)';
}

// ── Dessin d'un avion (vu de dessus, nez vers le haut) ──────────────────────
export function planePath(ctx) {
  ctx.beginPath();
  ctx.moveTo(0, -10); ctx.lineTo(1.8, -3.5); ctx.lineTo(10.5, 3); ctx.lineTo(10.5, 5);
  ctx.lineTo(1.8, 3); ctx.lineTo(1.5, 8); ctx.lineTo(4.5, 11); ctx.lineTo(4.5, 12.4);
  ctx.lineTo(0, 10.6); ctx.lineTo(-4.5, 12.4); ctx.lineTo(-4.5, 11); ctx.lineTo(-1.5, 8);
  ctx.lineTo(-1.8, 3); ctx.lineTo(-10.5, 5); ctx.lineTo(-10.5, 3); ctx.lineTo(-1.8, -3.5);
  ctx.closePath();
}

// ── Extrapolation de position entre deux rafraîchissements ──────────────────
export function deadReckon(p, now) {
  const dt = Math.min(now - p.t, CONFIG.maxDeadReckonMs) / 3_600_000; // en heures
  if (!p.speed || p.track == null || dt <= 0 || p.onGround) return [p.lat, p.lon];
  const nm = p.speed * dt;
  const rad = (p.track * Math.PI) / 180;
  const cosLat = Math.cos((p.lat * Math.PI) / 180) || 1e-6;
  return [p.lat + (nm * Math.cos(rad)) / 60, p.lon + (nm * Math.sin(rad)) / (60 * cosLat)];
}

// ── Étiquettes sans chevauchement ───────────────────────────────────────────
const LABEL_CELL = 14;   // px : hauteur d'une ligne d'étiquette
let occupied = new Set();

function labelFits(x, y, w, h) {
  const c0 = Math.floor(x / LABEL_CELL), c1 = Math.floor((x + w) / LABEL_CELL);
  const r0 = Math.floor(y / LABEL_CELL), r1 = Math.floor((y + h) / LABEL_CELL);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (occupied.has(r * 4096 + c)) return false;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occupied.add(r * 4096 + c);
  return true;
}

export let visibleCount = 0;

// ── Boucle de rendu ─────────────────────────────────────────────────────────
function render() {
  const ctx = layer.ctx();
  const size = layer.size();
  if (!ctx || !size) return requestAnimationFrame(render);

  ctx.clearRect(0, 0, size.x, size.y);
  const now = Date.now();
  const zoom = map.getZoom();
  const scale = zoom < 6 ? 0.55 : zoom < 9 ? 0.75 : 1;
  const light = state.theme === 'light';
  const labelColor = light ? 'rgba(20,28,40,.8)' : 'rgba(230,237,243,.72)';
  const accent = '#3fb6ff';
  occupied = new Set();
  let count = 0;

  // l'avion sélectionné est dessiné en dernier (au-dessus) et a toujours son étiquette
  const ordered = [];
  for (const [hex, p] of planes) {
    if (now - p.t > CONFIG.maxAgeMs) { planes.delete(hex); continue; }
    if (hex === state.selectedHex) ordered.push(p); else ordered.unshift(p);
  }

  for (const p of ordered) {
    const selected = p.hex === state.selectedHex;
    if (!selected && !passesFilters(p)) { p._x = null; continue; }
    count++;

    const [tLat, tLon] = deadReckon(p, now);
    // lissage : on glisse vers la position calculée au lieu de sauter
    p.rLat += (tLat - p.rLat) * CONFIG.smoothing;
    p.rLon += (tLon - p.rLon) * CONFIG.smoothing;

    const pt = map.latLngToContainerPoint([p.rLat, p.rLon]);
    p._x = pt.x; p._y = pt.y;
    if (pt.x < -30 || pt.y < -30 || pt.x > size.x + 30 || pt.y > size.y + 30) continue;

    const emergency = isEmergency(p);
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(((p.track ?? 0) * Math.PI) / 180);
    const s = selected ? scale * 1.35 : scale;
    ctx.scale(s, s);
    planePath(ctx);
    ctx.fillStyle = emergency ? '#ff4d6d' : altColor(p.alt);
    ctx.fill();
    // contour : bleu si sélectionné, rouge en urgence, or si appareil remarquable
    if (selected || emergency || p.notable || light) {
      ctx.lineWidth = selected || emergency || p.notable ? 1.6 : 0.8;
      ctx.strokeStyle = selected ? accent : emergency ? '#ff4d6d' : p.notable ? '#f0c765' : 'rgba(0,0,0,.35)';
      ctx.stroke();
    }
    ctx.restore();

    // étiquette : callsign dès le zoom 9, + altitude/vitesse dès 10 ; jamais superposée
    if ((zoom >= 9 || selected) && (p.callsign || p.reg)) {
      const line1 = p.callsign || p.reg;
      const line2 = zoom >= 10 && !p.onGround && p.alt != null
        ? `${Math.round(p.alt / 100) * 100} ft · ${Math.round(p.speed || 0)} kt`
        : null;
      ctx.font = `${selected ? '600 ' : ''}11px ui-monospace, Menlo, monospace`;
      const w = Math.max(ctx.measureText(line1).width, line2 ? ctx.measureText(line2).width * 0.9 : 0);
      const h = line2 ? 24 : 12;
      const x = pt.x + 13, y = pt.y - 4;
      if (selected || labelFits(x, y, w, h)) {
        ctx.fillStyle = selected ? accent : labelColor;
        ctx.fillText(line1, x, y + 8);
        if (line2) {
          ctx.font = '10px ui-monospace, Menlo, monospace';
          ctx.fillStyle = selected ? accent : (light ? 'rgba(20,28,40,.6)' : 'rgba(230,237,243,.5)');
          ctx.fillText(line2, x, y + 20);
        }
      }
    }
  }
  visibleCount = count;
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

/** Avion le plus proche d'un point écran (pour le clic). */
export function hitTest(containerPoint) {
  let best = null;
  let bestDist = CONFIG.hitRadiusPx;
  for (const [hex, p] of planes) {
    if (p._x == null) continue;
    const d = Math.hypot(p._x - containerPoint.x, p._y - containerPoint.y);
    if (d < bestDist) { bestDist = d; best = hex; }
  }
  return best;
}
