// Node registry: reads data/*.json from disk and saves custom labels to data/custom.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RegistryCore } from './registry-core.js';

export { CATEGORIES, TYPES } from './registry-core.js';

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const SYNCED_FILE = path.join(DATA_DIR, 'synced.json');
const CURATED = path.join(DATA_DIR, 'registry.json');
const CUSTOM = path.join(DATA_DIR, 'custom.json');

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

export class Registry extends RegistryCore {
  constructor() {
    super({
      curated: () => readJson(CURATED, { protocols: [] }),
      synced: () => readJson(SYNCED_FILE, { entries: [] }),
      readCustom: () => readJson(CUSTOM, []),
      writeCustom: (list) => writeFileSync(CUSTOM, JSON.stringify(list, null, 2) + '\n'),
    });
  }
}
