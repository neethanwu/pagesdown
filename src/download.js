import { NotionToMarkdown } from 'notion-to-md';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeFilename, uniqueFilename, ensureDir } from './utils.js';
import { extractTitle } from './notion.js';

const MAX_DEPTH = 20;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ASSET_CONCURRENCY = 5;
const MAX_ASSET_SIZE = 50 * 1024 * 1024; // 50 MB

// Block private/internal IP ranges to prevent SSRF
const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const PRIVATE_IP_PREFIXES = ['10.', '192.168.', '169.254.', '172.16.', '172.17.', '172.18.',
  '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.',
  '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'];

/**
 * Split blocks at child_page/child_database boundaries.
 * Returns { markdownParts, childEntries } for conversion and recursion.
 */
function splitBlocksAtBoundaries(blocks) {
  const usedNames = new Set();
  const childEntries = [];
  const markdownParts = [];
  let currentSegment = [];

  for (const block of blocks) {
    if (block.type === 'child_page') {
      if (currentSegment.length > 0) {
        markdownParts.push({ type: 'blocks', blocks: currentSegment });
        currentSegment = [];
      }
      const childTitle = block.child_page?.title || 'Untitled';
      const childName = uniqueFilename(sanitizeFilename(childTitle), usedNames);
      childEntries.push({ block, title: childTitle, name: childName, type: 'page' });
      markdownParts.push({ type: 'link', title: childTitle, name: childName });
    } else if (block.type === 'child_database') {
      if (currentSegment.length > 0) {
        markdownParts.push({ type: 'blocks', blocks: currentSegment });
        currentSegment = [];
      }
      const dbTitle = block.child_database?.title || 'Untitled Database';
      const dbName = uniqueFilename(sanitizeFilename(dbTitle), usedNames);
      childEntries.push({ block, title: dbTitle, name: dbName, type: 'database' });
      markdownParts.push({ type: 'link', title: dbTitle, name: dbName });
    } else {
      currentSegment.push(block);
    }
  }
  if (currentSegment.length > 0) {
    markdownParts.push({ type: 'blocks', blocks: currentSegment });
  }

  return { markdownParts, childEntries };
}

/**
 * Convert markdownParts (from splitBlocksAtBoundaries) into a markdown string.
 * Block segments are converted via notion-to-md; child links become relative paths.
 */
async function buildMarkdownFromParts(markdownParts, n2m, titleForErrors, stats, onError) {
  let markdown = '';

  for (const part of markdownParts) {
    if (part.type === 'link') {
      const relativePath = `./${part.name}/${part.name}.md`;
      markdown += `- [${part.title}](${relativePath})\n`;
    } else {
      try {
        const mdBlocks = await n2m.blocksToMarkdown(part.blocks);
        const mdResult = n2m.toMarkdownString(mdBlocks);
        const segment = mdResult.parent || '';
        if (segment.trim()) {
          markdown += segment;
          if (!markdown.endsWith('\n\n')) {
            markdown += '\n';
          }
        }
      } catch (err) {
        stats.errors.push({ title: titleForErrors, error: `Markdown conversion failed: ${err.message}` });
        onError(`Conversion failed for segment in ${titleForErrors}: ${err.message}`);
      }
    }
  }

  return markdown;
}

/**
 * Download selected pages/databases to the local filesystem.
 *
 * Callbacks:
 *   onStatus(message)  – spinner/progress text (frequently updated)
 *   onLog(message)     – milestone log line (page saved, db started, etc.)
 *   onError(message)   – error log line (shown immediately, not batched)
 */
export async function downloadPages(selectedItems, savePath, notion, { onStatus, onLog, onError }) {
  await ensureDir(savePath);

  const n2m = new NotionToMarkdown({
    notionClient: notion.throttledClient,
    config: {
      separateChildPage: true,
      parseChildPages: false,
    },
  });

  const stats = { totalPages: 0, totalAssets: 0, errors: [] };
  const ctx = { notion, n2m, stats, onStatus, onLog, onError };
  const usedNames = new Set();
  const visited = new Set();

  for (let i = 0; i < selectedItems.length; i++) {
    const item = selectedItems[i];
    const safeName = uniqueFilename(sanitizeFilename(item.title), usedNames);
    const prefix = `[${i + 1}/${selectedItems.length}]`;

    onLog(`${prefix} Starting: ${item.title}`);

    try {
      if (item.type === 'database') {
        await downloadDatabase(item.id, safeName, savePath, ctx, visited, 0);
      } else {
        await downloadPage(item.id, safeName, savePath, ctx, visited, 0);
      }
      onLog(`${prefix} Done: ${item.title} (${stats.totalPages} pages, ${stats.totalAssets} assets so far)`);
    } catch (err) {
      stats.errors.push({ title: item.title, error: err.message });
      onError(`${prefix} Failed: ${item.title} — ${err.message}`);
    }
  }

  return stats;
}

/**
 * Recursively download a single page and its children.
 * Fetches blocks once through the throttled API wrapper, then:
 *   1. Passes them to notion-to-md for markdown conversion (no extra API calls)
 *   2. Extracts child_page/child_database blocks for recursion
 */
async function downloadPage(pageId, name, parentDir, ctx, visited, depth) {
  if (visited.has(pageId)) return;
  if (depth > MAX_DEPTH) {
    ctx.stats.errors.push({ title: name, error: `Skipped: exceeded max depth of ${MAX_DEPTH}` });
    return;
  }
  visited.add(pageId);

  const { notion, n2m, stats, onStatus, onError } = ctx;
  const pageDir = path.join(parentDir, name);
  await ensureDir(pageDir);

  onStatus(`Fetching: ${name}`);

  // Fetch blocks ONCE through our throttled wrapper
  let blocks;
  try {
    const result = await notion.getBlockChildrenDeep(pageId);
    blocks = result.blocks;
    for (const w of result.warnings) {
      stats.errors.push({ title: name, error: `Skipped block ${w.blockType}: ${w.error}` });
      onError(`Partial fetch in ${name}: skipped ${w.blockType} block — ${w.error}`);
    }
  } catch (err) {
    // Block fetch failed — usually because the page contains an inline
    // database that isn't shared with the integration. Instead of writing
    // a bare stub, retrieve whatever page metadata we can (properties/
    // frontmatter) so the export is still useful.
    stats.errors.push({ title: name, error: `Could not fetch blocks: ${err.message}` });
    onError(`Could not fetch: ${name} — ${err.message}`);

    let content = '';
    try {
      const page = await notion.getPage(pageId);
      const frontmatter = buildFrontmatter(page.properties);
      if (frontmatter) {
        content += `---\n${frontmatter}---\n\n`;
      }
    } catch {
      // Page metadata also inaccessible — continue with bare stub
    }
    content += `# ${name}\n`;

    const mdPath = path.join(pageDir, `${name}.md`);
    await writeFile(mdPath, content, 'utf-8');
    stats.totalPages++;
    return;
  }

  onStatus(`Converting: ${name} (${blocks.length} blocks)`);

  const { markdownParts, childEntries } = splitBlocksAtBoundaries(blocks);
  let markdown = `# ${name}\n\n` + await buildMarkdownFromParts(markdownParts, n2m, name, stats, onError);

  if (!markdown.trim()) {
    markdown = `# ${name}\n`;
  }

  markdown = await processAssets(markdown, pageDir, stats, ctx);

  const mdPath = path.join(pageDir, `${name}.md`);
  await writeFile(mdPath, markdown, 'utf-8');
  stats.totalPages++;

  // Now recurse into children
  if (childEntries.length > 0) {
    const pageCount = childEntries.filter((e) => e.type === 'page').length;
    const dbCount = childEntries.filter((e) => e.type === 'database').length;
    onStatus(`${name}: ${pageCount} sub-pages, ${dbCount} sub-databases`);
  }

  for (const entry of childEntries) {
    try {
      if (entry.type === 'page') {
        await downloadPage(entry.block.id, entry.name, pageDir, ctx, visited, depth + 1);
      } else {
        await downloadDatabase(entry.block.id, entry.name, pageDir, ctx, visited, depth + 1);
      }
    } catch (err) {
      stats.errors.push({ title: entry.title, error: err.message });
      onError(`Failed: ${entry.title} — ${err.message}`);
    }
  }
}

/**
 * Download a database: create a folder and download each row as a page.
 */
async function downloadDatabase(databaseId, name, parentDir, ctx, visited, depth) {
  if (visited.has(databaseId)) return;
  if (depth > MAX_DEPTH) {
    ctx.stats.errors.push({ title: name, error: `Skipped: exceeded max depth of ${MAX_DEPTH}` });
    return;
  }
  visited.add(databaseId);

  const { notion, n2m, stats, onStatus, onLog, onError } = ctx;
  const dbDir = path.join(parentDir, name);
  await ensureDir(dbDir);

  onStatus(`Querying database: ${name}`);

  let rows;
  try {
    rows = await notion.queryDatabase(databaseId);
  } catch (err) {
    stats.errors.push({ title: name, error: `Could not query database: ${err.message}` });
    onError(`Could not query database: ${name} — ${err.message}`);
    return;
  }

  onLog(`Database "${name}": ${rows.length} row${rows.length === 1 ? '' : 's'}`);

  const rowNames = new Set();
  const rowLinks = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Database rows ARE pages in Notion's model — track them for cycle detection
    if (visited.has(row.id)) continue;
    visited.add(row.id);

    const rowTitle = extractTitle(row);
    const rowName = uniqueFilename(sanitizeFilename(rowTitle), rowNames);

    onStatus(`${name}: row ${i + 1}/${rows.length} — ${rowTitle}`);
    rowLinks.push({ title: rowTitle, name: rowName });

    try {
      const frontmatter = buildFrontmatter(row.properties);
      const rowDir = path.join(dbDir, rowName);
      await ensureDir(rowDir);

      // Fetch blocks through throttled wrapper
      let blocks;
      try {
        const result = await notion.getBlockChildrenDeep(row.id);
        blocks = result.blocks;
        for (const w of result.warnings) {
          stats.errors.push({ title: rowTitle, error: `Skipped block ${w.blockType}: ${w.error}` });
          onError(`Partial fetch in ${rowTitle}: skipped ${w.blockType} block — ${w.error}`);
        }
      } catch (err) {
        blocks = [];
        stats.errors.push({ title: rowTitle, error: `Could not fetch blocks: ${err.message}` });
        onError(`Could not fetch blocks for row: ${rowTitle} — ${err.message}`);
      }

      const { markdownParts, childEntries } = splitBlocksAtBoundaries(blocks);
      const markdown = await buildMarkdownFromParts(markdownParts, n2m, rowTitle, stats, onError);

      let content = '';
      if (frontmatter) {
        content += `---\n${frontmatter}---\n\n`;
      }
      content += `# ${rowName}\n\n${markdown}`;

      content = await processAssets(content, rowDir, stats, ctx);

      const mdPath = path.join(rowDir, `${rowName}.md`);
      await writeFile(mdPath, content, 'utf-8');
      stats.totalPages++;

      // Recurse into child pages and databases
      for (const entry of childEntries) {
        try {
          if (entry.type === 'page') {
            await downloadPage(entry.block.id, entry.name, rowDir, ctx, visited, depth + 1);
          } else {
            await downloadDatabase(entry.block.id, entry.name, rowDir, ctx, visited, depth + 1);
          }
        } catch (err) {
          stats.errors.push({ title: entry.title, error: err.message });
          onError(`Failed: ${entry.title} — ${err.message}`);
        }
      }
    } catch (err) {
      stats.errors.push({ title: rowTitle, error: err.message });
      onError(`Row failed: ${rowTitle} — ${err.message}`);
    }
  }

  // Create database index file listing all rows
  const indexLines = [`# ${name}\n`];
  for (const row of rowLinks) {
    indexLines.push(`- [${row.title}](./${row.name}/${row.name}.md)`);
  }
  const indexPath = path.join(dbDir, `${name}.md`);
  await writeFile(indexPath, indexLines.join('\n') + '\n', 'utf-8');
}

/**
 * Find and download all images/files in markdown content.
 * Rewrites URLs to relative ./assets/ paths using a single-pass replacement.
 */
async function processAssets(markdown, pageDir, stats, ctx) {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const assetsDir = path.join(pageDir, 'assets');
  const usedAssetNames = new Set();

  const replacements = new Map();
  const downloads = [];

  let match;
  while ((match = imageRegex.exec(markdown)) !== null) {
    const [full, alt, url] = match;

    if (url.startsWith('data:') || !url.startsWith('http')) continue;
    if (!isAllowedUrl(url)) continue;

    const filename = getAssetFilename(url, usedAssetNames);
    downloads.push({ url, fullMatch: full, alt, filename });
  }

  if (downloads.length === 0) return markdown;

  ctx.onStatus(`Downloading ${downloads.length} asset${downloads.length === 1 ? '' : 's'}...`);

  await ensureDir(assetsDir);

  // Download assets with bounded concurrency (CDN, not Notion API — no rate limit)
  let completed = 0;
  await runWithConcurrency(downloads, ASSET_CONCURRENCY, async (dl) => {
    try {
      const assetPath = path.join(assetsDir, dl.filename);
      await downloadFile(dl.url, assetPath);
      stats.totalAssets++;
      replacements.set(dl.fullMatch, `![${dl.alt}](./assets/${dl.filename})`);
    } catch (err) {
      ctx.onError(`Asset failed: ${dl.filename} — ${err.message}`);
    } finally {
      completed++;
      ctx.onStatus(`Assets: ${completed}/${downloads.length}`);
    }
  });

  if (replacements.size === 0) return markdown;

  return markdown.replace(imageRegex, (match) => {
    return replacements.get(match) || match;
  });
}

/**
 * Check if a URL is safe to fetch (not a private/internal address).
 */
function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    if (BLOCKED_HOSTNAMES.has(hostname)) return false;
    if (PRIVATE_IP_PREFIXES.some((prefix) => hostname.startsWith(prefix))) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Run async tasks with bounded concurrency.
 */
async function runWithConcurrency(items, limit, fn) {
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

/**
 * Download a file from a URL to a local path with timeout.
 */
async function downloadFile(url, destPath) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  // Early reject if Content-Length is known and too large
  const contentLength = parseInt(response.headers.get('content-length'), 10);
  if (contentLength > MAX_ASSET_SIZE) {
    throw new Error(`File too large (${Math.round(contentLength / 1024 / 1024)}MB, limit ${MAX_ASSET_SIZE / 1024 / 1024}MB)`);
  }

  // Stream and count bytes to enforce limit even without Content-Length
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > MAX_ASSET_SIZE) {
      reader.cancel();
      throw new Error(`File too large (exceeded ${MAX_ASSET_SIZE / 1024 / 1024}MB during download)`);
    }
    chunks.push(value);
  }

  await writeFile(destPath, Buffer.concat(chunks));
}

/**
 * Extract a suitable filename from a URL.
 */
function getAssetFilename(url, usedNames) {
  try {
    const parsed = new URL(url);
    let filename = parsed.pathname.split('/').pop() || 'file';

    if (!path.extname(filename)) {
      filename += '.png';
    }

    filename = filename.replace(/[<>:"/\\|?*]/g, '');

    if (usedNames.has(filename)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      let counter = 2;
      while (usedNames.has(`${base}-${counter}${ext}`)) {
        counter++;
      }
      filename = `${base}-${counter}${ext}`;
    }

    usedNames.add(filename);
    return filename;
  } catch {
    const fallback = `asset-${usedNames.size + 1}.png`;
    usedNames.add(fallback);
    return fallback;
  }
}

/**
 * Build YAML frontmatter from database page properties.
 * All string values are properly quoted to prevent YAML injection.
 */
function buildFrontmatter(properties) {
  if (!properties) return '';

  const lines = [];

  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type === 'title') continue;

    const value = extractPropertyValue(prop);
    if (value !== null) {
      const safeKey = /[:#{}[\],&*?|>!%@`]/.test(key) ? `"${escapeYaml(key)}"` : key;
      lines.push(`${safeKey}: ${value}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function escapeYaml(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function yamlString(val) {
  if (val === null || val === undefined) return null;
  return `"${escapeYaml(String(val))}"`;
}

function extractPropertyValue(prop) {
  switch (prop.type) {
    case 'rich_text': {
      const text = prop.rich_text?.map((t) => t.plain_text).join('');
      return text ? yamlString(text) : null;
    }
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name ? yamlString(prop.select.name) : null;
    case 'multi_select':
      if (!prop.multi_select?.length) return null;
      return `[${prop.multi_select.map((s) => yamlString(s.name)).join(', ')}]`;
    case 'date':
      if (!prop.date) return null;
      return prop.date.end
        ? yamlString(`${prop.date.start} → ${prop.date.end}`)
        : yamlString(prop.date.start);
    case 'checkbox':
      return prop.checkbox;
    case 'url':
      return prop.url ? yamlString(prop.url) : null;
    case 'email':
      return prop.email ? yamlString(prop.email) : null;
    case 'phone_number':
      return prop.phone_number ? yamlString(prop.phone_number) : null;
    case 'status':
      return prop.status?.name ? yamlString(prop.status.name) : null;
    default:
      return null;
  }
}
