/**
 * Export d'une trace (vol) en GPX, KML ou CSV — pour Google Earth, QGIS, un tableur.
 * Les points sont au format compact de lib/trail.js : [t, lat, lon, alt(ft, 0 = sol), gs, track, vr].
 */
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const ftToM = (ft) => (ft == null ? 0 : Math.round(ft * 0.3048));

function title(leg, hex) {
  const from = leg.from?.iata || leg.from?.icao || '?';
  const to = leg.to?.iata || leg.to?.icao || '?';
  return `${leg.callsign || hex.toUpperCase()} ${from}→${to} ${String(leg.start).slice(0, 10)}`;
}

export function toGpx(leg, hex) {
  const name = title(leg, hex);
  const pts = (leg.points || []).map(([t, lat, lon, alt, gs]) =>
    `      <trkpt lat="${lat}" lon="${lon}"><ele>${ftToM(alt)}</ele><time>${new Date(t).toISOString()}</time>${gs != null ? `<extensions><speed>${(gs * 0.514444).toFixed(1)}</speed></extensions>` : ''}</trkpt>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FlightMap" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><desc>Trace ADS-B via adsb.lol (ODbL)</desc></metadata>
  <trk><name>${esc(name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}

export function toKml(leg, hex) {
  const name = title(leg, hex);
  const coords = (leg.points || []).map(([, lat, lon, alt]) => `${lon},${lat},${ftToM(alt)}`).join('\n');
  const when = (leg.points || []).map(([t]) => `<when>${new Date(t).toISOString()}</when>`).join('');
  const gxCoord = (leg.points || []).map(([, lat, lon, alt]) => `<gx:coord>${lon} ${lat} ${ftToM(alt)}</gx:coord>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>${esc(name)}</name>
  <Style id="trail"><LineStyle><color>ffffb63f</color><width>3</width></LineStyle><PolyStyle><color>40ffb63f</color></PolyStyle></Style>
  <Placemark>
    <name>${esc(name)}</name>
    <description>Trace ADS-B via adsb.lol (ODbL) — altitude max ${leg.maxAlt ?? '?'} ft, ${leg.distanceKm ?? '?'} km</description>
    <styleUrl>#trail</styleUrl>
    <LineString><extrude>1</extrude><tessellate>1</tessellate><altitudeMode>absolute</altitudeMode><coordinates>
${coords}
    </coordinates></LineString>
  </Placemark>
  <Placemark>
    <name>${esc(name)} (animé)</name>
    <gx:Track><altitudeMode>absolute</altitudeMode>${when}${gxCoord}</gx:Track>
  </Placemark>
</Document>
</kml>
`;
}

export function toCsv(leg, hex) {
  const rows = ['time_utc,lat,lon,alt_ft,ground_speed_kt,track_deg,vertical_rate_fpm'];
  for (const [t, lat, lon, alt, gs, track, vr] of leg.points || []) {
    rows.push(`${new Date(t).toISOString()},${lat},${lon},${alt ?? ''},${gs ?? ''},${track ?? ''},${vr ?? ''}`);
  }
  return `# ${title(leg, hex)} — source adsb.lol (ODbL)\n${rows.join('\n')}\n`;
}

export const EXPORT_FORMATS = {
  gpx: { fn: toGpx, type: 'application/gpx+xml', ext: 'gpx' },
  kml: { fn: toKml, type: 'application/vnd.google-earth.kml+xml', ext: 'kml' },
  csv: { fn: toCsv, type: 'text/csv; charset=utf-8', ext: 'csv' },
};
