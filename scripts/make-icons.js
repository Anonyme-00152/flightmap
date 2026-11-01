/**
 * Génère les icônes PWA (PNG) sans aucune dépendance : un encodeur PNG
 * minimal (zlib + CRC32) et la silhouette d'avion du rendu canvas,
 * rasterisée par test point-dans-polygone.
 *
 *   node scripts/make-icons.js   →  public/icons/icon-{192,512}.png, icon-maskable-512.png
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// même silhouette que public/js/render.js (nez vers le haut, unité ≈ 1/12 de la taille)
const PLANE = [
  [0, -10], [1.8, -3.5], [10.5, 3], [10.5, 5], [1.8, 3], [1.5, 8], [4.5, 11], [4.5, 12.4],
  [0, 10.6], [-4.5, 12.4], [-4.5, 11], [-1.5, 8], [-1.8, 3], [-10.5, 5], [-10.5, 3], [-1.8, -3.5],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ── PNG ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtre « none »
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Dessin ──────────────────────────────────────────────────────────────────
// fond : dégradé diagonal du logo (ciel → bleu → indigo), avion blanc incliné à 45°
const GRADIENT = [[0, [0x5c, 0xca, 0xff]], [0.5, [0x3f, 0x8d, 0xff]], [1, [0x7a, 0x6b, 0xff]]];
function gradientAt(t) {
  for (let k = 1; k < GRADIENT.length; k++) {
    const [t0, c0] = GRADIENT[k - 1], [t1, c1] = GRADIENT[k];
    if (t <= t1) { const f = (t - t0) / (t1 - t0); return c0.map((v, j) => v + (c1[j] - v) * f); }
  }
  return GRADIENT[GRADIENT.length - 1][1];
}

function render(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const fg = [0xff, 0xff, 0xff];
  const radius = maskable ? 0 : size * 0.24;          // coins arrondis (sauf maskable : plein cadre)
  const scale = (maskable ? size * 0.46 : size * 0.62) / 22.4;
  const cx = size / 2 + size * 0.019, cy = size / 2 - size * 0.019;   // recentrage optique après rotation
  const cos = Math.SQRT1_2, sin = Math.SQRT1_2;
  const ss = 4;                                        // anti-aliasing 4×4

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cover = 0, plane = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
      // fond arrondi
      const dx = Math.max(radius - px, px - (size - radius), 0);
      const dy = Math.max(radius - py, py - (size - radius), 0);
      if (dx * dx + dy * dy > radius * radius) continue;
      cover++;
      // rotation inverse de 45° pour tester le point dans le repère de l'avion
      const ux = px - cx, uy = py - cy;
      if (inPolygon((cos * ux + sin * uy) / scale, (-sin * ux + cos * uy) / scale, PLANE)) plane++;
    }
    const i = (y * size + x) * 4;
    const a = cover / (ss * ss);
    const t = plane / Math.max(1, cover);
    const bg = gradientAt((x + y) / (2 * size));
    rgba[i] = Math.round(bg[0] + (fg[0] - bg[0]) * t);
    rgba[i + 1] = Math.round(bg[1] + (fg[1] - bg[1]) * t);
    rgba[i + 2] = Math.round(bg[2] + (fg[2] - bg[2]) * t);
    rgba[i + 3] = Math.round(255 * a);
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-192.png'), render(192, { maskable: false }));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), render(512, { maskable: false }));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), render(512, { maskable: true }));
console.log('✅ icônes générées dans public/icons/');
