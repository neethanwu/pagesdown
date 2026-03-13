import * as p from '@clack/prompts';
import { existsSync } from 'node:fs';
import { NotionClient } from './notion.js';
import { loadConfig, saveConfig } from './config.js';
import { getDefaultSavePath } from './utils.js';
import { downloadPages } from './download.js';

async function main() {
  p.intro('notion-to-fs');

  // ── Step 1: Token ─────────────────────────────────────────────────
  let token = null;
  let workspaceName = null;

  const savedConfig = await loadConfig();

  if (savedConfig?.token) {
    const useSaved = await p.confirm({
      message: `Use saved token${savedConfig.workspace ? ` for "${savedConfig.workspace}"` : ''}?`,
    });

    if (p.isCancel(useSaved)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    if (useSaved) {
      token = savedConfig.token;
      workspaceName = savedConfig.workspace;
    }
  }

  if (!token) {
    p.note(
      [
        '1. Open: https://www.notion.so/profile/integrations/internal/form/new-integration',
        '2. Fill in a name (e.g. "notion-to-fs"), select your workspace',
        '3. Under Capabilities: check only "Read content", uncheck everything else',
        '4. Click "Create" → copy the "Internal Integration Secret"',
        '',
        'Then share pages with your integration:',
        '  Open a page → ••• menu → Connections → Add your integration',
        '  (Sharing a parent page shares all its children automatically)',
      ].join('\n'),
      'First, set up a Notion integration'
    );

    const tokenInput = await p.password({
      message: 'Paste your integration token:',
      validate: (val) => {
        if (!val) return 'Token is required.';
        if (!val.startsWith('ntn_') && !val.startsWith('secret_')) {
          return 'Token should start with "ntn_" (or "secret_" for older tokens).';
        }
      },
    });

    if (p.isCancel(tokenInput)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    token = tokenInput;
  }

  // ── Step 2: Validate token ────────────────────────────────────────
  const spin = p.spinner();
  spin.start('Connecting to Notion...');

  const notion = new NotionClient(token);

  try {
    await notion.validateToken();
    spin.stop('Connected to Notion.');
  } catch (err) {
    spin.stop('Connection failed.');
    p.log.error(
      err.status === 401
        ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
        : `Could not connect to Notion: ${err.message}`
    );
    process.exit(1);
  }

  // ── Step 3: Fetch pages ───────────────────────────────────────────
  spin.start('Fetching your pages...');

  let topLevelItems;
  try {
    topLevelItems = await notion.getTopLevelPages();
  } catch (err) {
    spin.stop('Failed to fetch pages.');
    p.log.error(`Error: ${err.message}`);
    process.exit(1);
  }

  spin.stop(`Found ${topLevelItems.length} top-level item${topLevelItems.length === 1 ? '' : 's'}.`);

  if (topLevelItems.length === 0) {
    p.note(
      [
        'No pages or databases found. This usually means you haven\'t shared',
        'any pages with your integration yet.',
        '',
        'To fix this:',
        '  1. Open a page in Notion',
        '  2. Click the ••• menu at the top right',
        '  3. Select "Connections"',
        '  4. Add your integration',
        '',
        'Sharing a parent page automatically shares all its children.',
      ].join('\n'),
      'No content found'
    );
    process.exit(0);
  }

  // ── Step 4: Select pages ──────────────────────────────────────────
  const options = topLevelItems.map((item) => ({
    value: item,
    label: item.title,
    hint: item.type === 'database' ? 'database' : undefined,
  }));

  const selected = await p.multiselect({
    message: 'Select pages to download:',
    options,
    required: true,
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // ── Step 5: Save location ─────────────────────────────────────────
  const defaultPath = getDefaultSavePath();

  const savePath = await p.text({
    message: 'Where should we save the files?',
    initialValue: defaultPath,
    validate: (val) => {
      if (!val?.trim()) return 'Path is required.';
    },
  });

  if (p.isCancel(savePath)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // Check if directory already exists with content
  if (existsSync(savePath)) {
    const overwrite = await p.confirm({
      message: `"${savePath}" already exists. Overwrite?`,
    });

    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel('Cancelled. Choose a different location next time.');
      process.exit(0);
    }
  }

  // ── Step 6: Confirm & Download ────────────────────────────────────
  const proceed = await p.confirm({
    message: `Download ${selected.length} item${selected.length === 1 ? '' : 's'} to ${savePath}?`,
  });

  if (p.isCancel(proceed) || !proceed) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // Save token for future use (if it's a new token)
  if (!savedConfig?.token || savedConfig.token !== token) {
    const shouldSave = await p.confirm({
      message: 'Save token for future use? (stored in ~/.notion-to-fs/config.json)',
    });

    if (!p.isCancel(shouldSave) && shouldSave) {
      await saveConfig({ token, workspace: workspaceName });
      p.log.success('Token saved.');
    }
  }

  // ── Download ──────────────────────────────────────────────────────
  spin.start('Downloading...');

  const stats = await downloadPages(selected, savePath, notion, (message) => {
    spin.message(`Downloading... ${message}`);
  });

  spin.stop('Download complete.');

  // ── Summary ───────────────────────────────────────────────────────
  const summary = [`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'} downloaded`];
  if (stats.totalAssets > 0) {
    summary.push(`${stats.totalAssets} file${stats.totalAssets === 1 ? '' : 's'} saved`);
  }
  if (stats.errors.length > 0) {
    summary.push(`${stats.errors.length} error${stats.errors.length === 1 ? '' : 's'}`);
  }

  if (stats.errors.length > 0) {
    p.log.warn('Some items had errors:');
    for (const err of stats.errors) {
      p.log.warn(`  - ${err.title}: ${err.error}`);
    }
  }

  p.note(savePath, 'Saved to');
  p.outro(`Done! ${summary.join(', ')}.`);
}

main().catch((err) => {
  p.log.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
