/**
 * Isole les tests : store SQLite et quota dans un dossier temporaire,
 * jamais dans data/ du projet. À importer AVANT tout module lib/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flightmap-test-'));
process.env.DATA_DIR = TMP;
process.env.QUOTA_FILE = path.join(TMP, 'quota.json');
delete process.env.AVIATIONSTACK_KEY;
delete process.env.AIRLABS_KEY;
delete process.env.AERODATABOX_KEY;
