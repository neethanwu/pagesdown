import { Client } from '@notionhq/client';

/**
 * Thin wrapper around the Notion API with built-in rate limiting and pagination.
 */
export class NotionClient {
  constructor(token) {
    this.client = new Client({ auth: token });
    this._lastRequestTime = 0;
    this._minInterval = 340; // ~3 req/s with margin
  }

  /**
   * Throttle requests to stay under Notion's 3 req/s limit.
   */
  async _throttle() {
    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    if (elapsed < this._minInterval) {
      await new Promise((r) => setTimeout(r, this._minInterval - elapsed));
    }
    this._lastRequestTime = Date.now();
  }

  /**
   * Auto-paginate any Notion list endpoint.
   * `fn` receives { start_cursor } and must return { results, has_more, next_cursor }.
   */
  async paginate(fn) {
    const allResults = [];
    let cursor = undefined;

    do {
      await this._throttle();
      const response = await fn({ start_cursor: cursor });
      allResults.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    return allResults;
  }

  /**
   * Validate the token by making a test search call.
   * Returns true if valid, throws on failure.
   */
  async validateToken() {
    await this._throttle();
    const response = await this.client.search({ page_size: 1 });
    return response;
  }

  /**
   * Get all top-level pages and databases shared with the integration.
   * Filters to items whose parent is the workspace (not nested inside another page).
   */
  async getTopLevelPages() {
    // Fetch all pages
    const pages = await this.paginate((opts) =>
      this.client.search({
        filter: { property: 'object', value: 'page' },
        page_size: 100,
        ...opts,
      })
    );

    // Fetch all databases
    const databases = await this.paginate((opts) =>
      this.client.search({
        filter: { property: 'object', value: 'database' },
        page_size: 100,
        ...opts,
      })
    );

    const topLevel = [];

    for (const page of pages) {
      if (page.parent?.type === 'workspace') {
        topLevel.push({
          id: page.id,
          type: 'page',
          title: extractTitle(page),
        });
      }
    }

    for (const db of databases) {
      if (db.parent?.type === 'workspace') {
        topLevel.push({
          id: db.id,
          type: 'database',
          title: extractDatabaseTitle(db),
        });
      }
    }

    return topLevel;
  }

  /**
   * Get all child blocks for a given block/page ID (paginated).
   */
  async getBlockChildren(blockId) {
    return this.paginate((opts) =>
      this.client.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...opts,
      })
    );
  }

  /**
   * Query all rows/pages in a database (paginated).
   */
  async queryDatabase(databaseId) {
    return this.paginate((opts) =>
      this.client.databases.query({
        database_id: databaseId,
        page_size: 100,
        ...opts,
      })
    );
  }

  /**
   * Retrieve a single page's properties.
   */
  async getPage(pageId) {
    await this._throttle();
    return this.client.pages.retrieve({ page_id: pageId });
  }
}

/**
 * Extract a page's title from its properties.
 */
function extractTitle(page) {
  if (!page.properties) return 'Untitled';

  for (const prop of Object.values(page.properties)) {
    if (prop.type === 'title' && prop.title?.length > 0) {
      return prop.title.map((t) => t.plain_text).join('');
    }
  }

  return 'Untitled';
}

/**
 * Extract a database's title.
 */
function extractDatabaseTitle(db) {
  if (db.title?.length > 0) {
    return db.title.map((t) => t.plain_text).join('');
  }
  return 'Untitled Database';
}
