import { NotionToMarkdown } from 'notion-to-md';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeFilename, uniqueFilename, ensureDir } from './utils.js';

/**
 * Download selected pages/databases to the local filesystem.
 *
 * @param {Array} selectedItems - Array of { id, type, title } from page selection
 * @param {string} savePath - Root directory to save into
 * @param {import('./notion.js').NotionClient} notion - Notion API client
 * @param {function} onProgress - Callback: (message: string) => void
 * @returns {object} - { totalPages, totalAssets, errors }
 */
export async function downloadPages(selectedItems, savePath, notion, onProgress) {
  await ensureDir(savePath);

  const n2m = new NotionToMarkdown({
    notionClient: notion.client,
    config: {
      separateChildPage: true,
      parseChildPages: false,
    },
  });

  const stats = { totalPages: 0, totalAssets: 0, errors: [] };
  // Track all downloaded pages for cross-page link rewriting
  const downloadedPages = new Map(); // notionPageId -> relative file path
  const usedNames = new Set();

  for (let i = 0; i < selectedItems.length; i++) {
    const item = selectedItems[i];
    const safeName = uniqueFilename(sanitizeFilename(item.title), usedNames);
    onProgress(`[${i + 1}/${selectedItems.length}] ${item.title}`);

    try {
      if (item.type === 'database') {
        await downloadDatabase(item.id, safeName, savePath, notion, n2m, stats, downloadedPages, onProgress);
      } else {
        await downloadPage(item.id, safeName, savePath, notion, n2m, stats, downloadedPages, onProgress);
      }
    } catch (err) {
      stats.errors.push({ title: item.title, error: err.message });
    }
  }

  return stats;
}

/**
 * Recursively download a single page and its children.
 */
async function downloadPage(pageId, name, parentDir, notion, n2m, stats, downloadedPages, onProgress) {
  const pageDir = path.join(parentDir, name);
  await ensureDir(pageDir);

  // Convert page blocks to markdown
  let mdBlocks;
  try {
    mdBlocks = await n2m.pageToMarkdown(pageId);
  } catch (err) {
    // If we can't fetch blocks, write an empty file with just the title
    const mdPath = path.join(pageDir, `${name}.md`);
    await writeFile(mdPath, `# ${name}\n`, 'utf-8');
    downloadedPages.set(pageId, path.relative(path.dirname(parentDir), mdPath));
    stats.totalPages++;
    stats.errors.push({ title: name, error: `Could not fetch blocks: ${err.message}` });
    return;
  }

  const mdResult = n2m.toMarkdownString(mdBlocks);
  let markdown = mdResult.parent || '';

  // Add title heading if not already present
  if (markdown && !markdown.startsWith('# ')) {
    markdown = `# ${name}\n\n${markdown}`;
  }

  // If page is empty, at least write the title
  if (!markdown.trim()) {
    markdown = `# ${name}\n`;
  }

  // Download images and files, rewrite URLs
  const { content, assetCount } = await processAssets(markdown, pageDir, notion);
  markdown = content;
  stats.totalAssets += assetCount;

  // Write the markdown file
  const mdPath = path.join(pageDir, `${name}.md`);
  await writeFile(mdPath, markdown, 'utf-8');
  downloadedPages.set(pageId, mdPath);
  stats.totalPages++;

  // Find and recurse into child pages and databases
  const children = await notion.getBlockChildren(pageId);
  const childNames = new Set();

  for (const block of children) {
    if (block.type === 'child_page') {
      const childTitle = block.child_page?.title || 'Untitled';
      const childName = uniqueFilename(sanitizeFilename(childTitle), childNames);
      try {
        await downloadPage(block.id, childName, pageDir, notion, n2m, stats, downloadedPages, onProgress);
      } catch (err) {
        stats.errors.push({ title: childTitle, error: err.message });
      }
    }

    if (block.type === 'child_database') {
      const dbTitle = block.child_database?.title || 'Untitled Database';
      const dbName = uniqueFilename(sanitizeFilename(dbTitle), childNames);
      try {
        await downloadDatabase(block.id, dbName, pageDir, notion, n2m, stats, downloadedPages, onProgress);
      } catch (err) {
        stats.errors.push({ title: dbTitle, error: err.message });
      }
    }
  }
}

/**
 * Download a database: create a folder and download each row as a page.
 */
async function downloadDatabase(databaseId, name, parentDir, notion, n2m, stats, downloadedPages, onProgress) {
  const dbDir = path.join(parentDir, name);
  await ensureDir(dbDir);

  let rows;
  try {
    rows = await notion.queryDatabase(databaseId);
  } catch (err) {
    stats.errors.push({ title: name, error: `Could not query database: ${err.message}` });
    return;
  }

  const rowNames = new Set();

  for (const row of rows) {
    const rowTitle = extractRowTitle(row);
    const rowName = uniqueFilename(sanitizeFilename(rowTitle), rowNames);

    try {
      // Build frontmatter from database properties
      const frontmatter = buildFrontmatter(row.properties);

      // Download the row's page content
      const rowDir = path.join(dbDir, rowName);
      await ensureDir(rowDir);

      let mdBlocks;
      try {
        mdBlocks = await n2m.pageToMarkdown(row.id);
      } catch {
        mdBlocks = [];
      }

      const mdResult = n2m.toMarkdownString(mdBlocks);
      let markdown = mdResult.parent || '';

      // Prepend frontmatter and title
      let content = '';
      if (frontmatter) {
        content += `---\n${frontmatter}---\n\n`;
      }
      content += `# ${rowName}\n\n${markdown}`;

      // Process assets
      const { content: processed, assetCount } = await processAssets(content, rowDir, notion);
      stats.totalAssets += assetCount;

      const mdPath = path.join(rowDir, `${rowName}.md`);
      await writeFile(mdPath, processed, 'utf-8');
      downloadedPages.set(row.id, mdPath);
      stats.totalPages++;
    } catch (err) {
      stats.errors.push({ title: rowTitle, error: err.message });
    }
  }
}

/**
 * Find and download all images/files in markdown content.
 * Rewrites URLs to relative ./assets/ paths.
 */
async function processAssets(markdown, pageDir, notion) {
  // Match markdown images: ![alt](url)
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let assetCount = 0;
  const assetsDir = path.join(pageDir, 'assets');
  let assetsCreated = false;
  const usedAssetNames = new Set();

  // Collect all matches first
  const matches = [];
  let match;
  while ((match = imageRegex.exec(markdown)) !== null) {
    matches.push({ full: match[0], alt: match[1], url: match[2] });
  }

  if (matches.length === 0) {
    return { content: markdown, assetCount: 0 };
  }

  let content = markdown;

  for (const m of matches) {
    // Skip data URIs and relative paths
    if (m.url.startsWith('data:') || !m.url.startsWith('http')) {
      continue;
    }

    try {
      if (!assetsCreated) {
        await ensureDir(assetsDir);
        assetsCreated = true;
      }

      const filename = getAssetFilename(m.url, usedAssetNames);
      const assetPath = path.join(assetsDir, filename);

      await downloadFile(m.url, assetPath);
      assetCount++;

      // Rewrite URL to relative path
      const relativePath = `./assets/${filename}`;
      content = content.replace(m.full, `![${m.alt}](${relativePath})`);
    } catch {
      // Leave original URL if download fails
    }
  }

  return { content, assetCount };
}

/**
 * Download a file from a URL to a local path.
 * Handles Notion's signed S3 URLs and external URLs.
 */
async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

/**
 * Extract a suitable filename from a URL.
 */
function getAssetFilename(url, usedNames) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    // Get the last segment of the path
    let filename = pathname.split('/').pop() || 'file';

    // Remove query params from filename
    filename = filename.split('?')[0];

    // Ensure it has an extension
    if (!path.extname(filename)) {
      filename += '.png'; // Default to png for images
    }

    // Sanitize
    filename = filename.replace(/[<>:"/\\|?*]/g, '');

    // Handle duplicates
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
 * Extract the title from a database row (page).
 */
function extractRowTitle(page) {
  if (!page.properties) return 'Untitled';

  for (const prop of Object.values(page.properties)) {
    if (prop.type === 'title' && prop.title?.length > 0) {
      return prop.title.map((t) => t.plain_text).join('');
    }
  }

  return 'Untitled';
}

/**
 * Build YAML frontmatter from database page properties.
 * Handles simple types; skips complex ones.
 */
function buildFrontmatter(properties) {
  if (!properties) return '';

  const lines = [];

  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type === 'title') continue; // Title is the page heading, not frontmatter

    const value = extractPropertyValue(prop);
    if (value !== null) {
      // Escape YAML special chars in key
      const safeKey = key.includes(':') ? `"${key}"` : key;
      lines.push(`${safeKey}: ${value}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Extract a display value from a Notion property.
 */
function extractPropertyValue(prop) {
  switch (prop.type) {
    case 'rich_text':
      return prop.rich_text?.map((t) => t.plain_text).join('') || null;
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name || null;
    case 'multi_select':
      if (!prop.multi_select?.length) return null;
      return `[${prop.multi_select.map((s) => `"${s.name}"`).join(', ')}]`;
    case 'date':
      if (!prop.date) return null;
      return prop.date.end
        ? `"${prop.date.start} → ${prop.date.end}"`
        : `"${prop.date.start}"`;
    case 'checkbox':
      return prop.checkbox;
    case 'url':
      return prop.url ? `"${prop.url}"` : null;
    case 'email':
      return prop.email ? `"${prop.email}"` : null;
    case 'phone_number':
      return prop.phone_number ? `"${prop.phone_number}"` : null;
    case 'status':
      return prop.status?.name || null;
    default:
      return null; // Skip complex types (relation, rollup, formula, etc.)
  }
}
