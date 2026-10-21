/**
 * Photo et description d'un aéroport via Wikipédia (gratuit, sans clé).
 * OurAirports fournit le lien Wikipédia de chaque aéroport ; l'API REST
 * « summary » renvoie le résumé, la vignette et l'image d'origine.
 * Cache 30 jours (persistant), ~2 req/s max, jamais bloquant.
 */
import { fetchJson, createLimiter } from './limiter.js';
import { TTLCache, createDeduper } from './cache.js';

const CONTACT = (process.env.CONTACT || '').trim();
const UA = `flightmap/4.0 (${CONTACT ? `+${CONTACT}` : 'projet perso de suivi de vols'})`;
const limit = createLimiter(500);
const cache = new TTLCache({ ttl: 30 * 24 * 3600_000, max: 20_000, name: 'wiki', persist: 'wiki' });
const dedupe = createDeduper();

/** "https://en.wikipedia.org/wiki/Strasbourg_Airport" → { lang: 'en', title: 'Strasbourg_Airport' } */
function parseLink(link) {
  const m = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^#?]+)/i.exec(String(link || ''));
  if (!m) return null;
  return { lang: m[1].toLowerCase(), title: decodeURIComponent(m[2]) };
}

async function summary(lang, title) {
  const data = await limit(() => fetchJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { userAgent: UA, timeout: 7000 }));
  if (!data || data.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') return null;
  return {
    title: data.title || title,
    lang,
    extract: data.extract || null,
    thumb: data.thumbnail?.source || null,
    image: data.originalimage?.source || null,
    imageWidth: data.originalimage?.width || null,
    imageHeight: data.originalimage?.height || null,
    url: data.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

/** Préférence : version française si elle existe (via les liens inter-langues), sinon l'originale. */
async function frenchVariant(lang, title) {
  if (lang === 'fr') return null;
  try {
    const data = await limit(() => fetchJson(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=fr&format=json&titles=${encodeURIComponent(title)}`, { userAgent: UA, timeout: 7000 }));
    const page = Object.values(data?.query?.pages || {})[0];
    const fr = page?.langlinks?.[0]?.['*'];
    return fr ? summary('fr', fr) : null;
  } catch { return null; }
}

/**
 * @param {string} link  lien Wikipédia (OurAirports)
 * @returns {Promise<object|null>} { title, extract, thumb, image, url, lang }
 */
export async function wikiSummary(link) {
  const parsed = parseLink(link);
  if (!parsed) return null;
  const key = `${parsed.lang}:${parsed.title}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  return dedupe(`wiki:${key}`, async () => {
    try {
      const base = await summary(parsed.lang, parsed.title);
      if (!base) return cache.set(key, null, 7 * 24 * 3600_000);
      const fr = await frenchVariant(parsed.lang, parsed.title);
      // texte en français si possible, image de la version qui en a une
      const out = { ...base, ...(fr ? { extract: fr.extract || base.extract, urlFr: fr.url, lang: 'fr' } : {}) };
      if (!out.image && fr?.image) { out.image = fr.image; out.thumb = fr.thumb; }
      out.credit = 'Wikimedia Commons / Wikipédia';
      // Wikimedia n'accepte plus que certaines largeurs de vignette (250, 330, 500, 960, 1280…) :
      // 960 px pour le panneau, la 330 d'origine en secours côté navigateur
      if (out.thumb) {
        out.thumb = out.thumb.replace(/\?utm_.*$/, '');
        out.photo = out.thumb.replace(/\/\d+px-/, '/960px-');
      }
      return cache.set(key, out);
    } catch (err) {
      if (err.status !== 404) console.warn(`[wiki] ${key}: ${err.message}`);
      return cache.set(key, null, 24 * 3600_000);
    }
  });
}

// ── Galerie : photos de l'article + catégorie Wikimedia Commons ─────────────
const galleryCache = new TTLCache({ ttl: 30 * 24 * 3600_000, max: 5_000, name: 'wiki-gallery', persist: 'wiki-gallery' });
const SKIP = /flag|logo|icon|map|carte|plan|diagram|schema|seal|coat_of_arms|wappen|blason|symbol|pictogram|arrow|\.svg$|\.gif$|\.ogv$|\.webm$/i;
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** Transforme une page imageinfo de l'API MediaWiki en liste de photos exploitables. */
function photosFromPages(pages) {
  const out = [];
  for (const p of Object.values(pages || {})) {
    const ii = p.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime || '')) continue;
    if (SKIP.test(p.title || '')) continue;
    if ((ii.width || 0) < 500 || (ii.height || 0) < 300) continue;            // icônes, vignettes
    if ((ii.width || 0) < (ii.height || 0) * 0.8) continue;                    // portraits (souvent des personnes / plaques)
    if (/png/.test(ii.mime) && Math.abs((ii.width || 0) - (ii.height || 0)) < 8) continue;   // icônes carrées de modèles (portails, bandeaux)
    const md = ii.extmetadata || {};
    out.push({
      title: String(p.title || '').replace(/^File:/, ''),
      src: ii.thumburl || ii.url,                       // vignette 960 px (largeur autorisée par Wikimedia)
      full: ii.url,
      width: ii.thumbwidth || ii.width, height: ii.thumbheight || ii.height,
      author: stripHtml(md.Artist?.value) || null,
      license: md.LicenseShortName?.value || null,
      description: stripHtml(md.ImageDescription?.value).replace(/https?:\/\/\S+/g, '').replace(/\s*[|:·]\s*$/, '').trim().slice(0, 140) || null,
      date: md.DateTimeOriginal?.value?.slice(0, 10) || null,
      page: ii.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(p.title || '')}`,
    });
  }
  return out;
}

const II = 'prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=960&iiextmetadatafilter=Artist|LicenseShortName|ImageDescription|DateTimeOriginal&format=json';

async function articleImages(lang, title) {
  const data = await limit(() => fetchJson(`https://${lang}.wikipedia.org/w/api.php?action=query&redirects=1&generator=images&gimlimit=40&titles=${encodeURIComponent(title)}&${II}`, { userAgent: UA, timeout: 9000 }));
  return photosFromPages(data?.query?.pages);
}

/** Catégorie Commons de l'article (propriété Wikidata P373), puis ses fichiers. */
async function categoryImages(lang, title) {
  const pp = await limit(() => fetchJson(`https://${lang}.wikipedia.org/w/api.php?action=query&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(title)}&format=json`, { userAgent: UA, timeout: 8000 }));
  const qid = Object.values(pp?.query?.pages || {})[0]?.pageprops?.wikibase_item;
  if (!qid) return [];
  const wd = await limit(() => fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P373&format=json`, { userAgent: UA, timeout: 8000 }));
  const cat = wd?.claims?.P373?.[0]?.mainsnak?.datavalue?.value;
  if (!cat) return [];
  const data = await limit(() => fetchJson(`https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=${encodeURIComponent(`Category:${cat}`)}&gcmtype=file&gcmlimit=50&${II}`, { userAgent: UA, timeout: 9000 }));
  return photosFromPages(data?.query?.pages);
}

/**
 * Galerie d'un aéroport : photos de l'article Wikipédia + catégorie Commons,
 * dédoublonnées, ≤ 24 photos, avec auteur et licence (obligatoires pour réutiliser).
 */
export async function wikiGallery(link) {
  const parsed = parseLink(link);
  if (!parsed) return [];
  const key = `${parsed.lang}:${parsed.title}`;
  const cached = galleryCache.get(key);
  if (cached !== undefined) return cached;
  return dedupe(`gallery:${key}`, async () => {
    const [a, c] = await Promise.allSettled([articleImages(parsed.lang, parsed.title), categoryImages(parsed.lang, parsed.title)]);
    const all = [...(a.status === 'fulfilled' ? a.value : []), ...(c.status === 'fulfilled' ? c.value : [])];
    const seen = new Set();
    const photos = all.filter((p) => { if (seen.has(p.full)) return false; seen.add(p.full); return true; }).slice(0, 24);
    if (a.status === 'rejected' && c.status === 'rejected') console.warn(`[wiki] galerie ${key}: ${a.reason?.message}`);
    return galleryCache.set(key, photos, photos.length ? undefined : 24 * 3600_000);
  });
}

export const wikiCacheStats = () => [cache.stats(), galleryCache.stats()];
