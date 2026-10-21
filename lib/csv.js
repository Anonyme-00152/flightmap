/**
 * Petit lecteur CSV (les fichiers OurAirports et plane-alert-db contiennent
 * des virgules à l'intérieur des guillemets : un split(',') naïf les casse).
 */

/** Découpe une ligne CSV en respectant les guillemets et les "" échappés. */
export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }  // "" -> "
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/** À partir de la ligne d'en-tête, renvoie une fonction ligne -> objet. */
export function rowMapper(headerLine) {
  const cols = splitCsvLine(headerLine).map((c) => c.trim().replace(/^﻿/, ''));
  return (line) => {
    const values = splitCsvLine(line);
    const row = {};
    for (let i = 0; i < cols.length; i++) row[cols[i]] = (values[i] ?? '').trim();
    return row;
  };
}

/** Premier champ non vide parmi plusieurs noms de colonnes possibles. */
export function pick(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== '') return v;
  }
  return null;
}
