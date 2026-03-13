import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.notion-to-fs');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Load saved config. Returns { token, workspace } or null if none exists.
 */
export async function loadConfig() {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Save config to ~/.notion-to-fs/config.json.
 * Sets 0600 permissions on Unix for security.
 */
export async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

  // Set restrictive permissions on Unix (no-op effect on Windows)
  try {
    await chmod(CONFIG_FILE, 0o600);
  } catch {
    // Ignore — chmod not meaningful on Windows
  }
}
