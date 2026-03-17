# pagesdown

Download your Notion content to local Markdown files. Beautiful guided CLI, clean output, ready for AI coding agents.

## Why?

I got sick of Notion's MCP server burning through tokens on every read, querying back and forth for what should be a simple task. The search tool can't even list database pages without a query. Connection drops kill your flow mid-task.

I'm local-first on almost everything now — the cloud just happens after my work, for syncing results. So I decided to pull my thousands of Notion pages down to local Markdown and enjoy my sweet time with my agents. Zero MCP overhead, zero token waste, works offline.

**Works with** Claude Code, Codex, and any agent that reads your local filesystem.

## How It Works

```
npx pagesdown → select pages → local markdown → point your agent at it
```

**Before (MCP):** Agent → Notion API call → wait → parse response → tokens burned on every read

**After (pagesdown):** Agent → reads local `.md` file → done

## Prerequisites

**Node.js 20 or later** — download from [nodejs.org](https://nodejs.org) (click the big green button, run the installer).

## Quick Start

```
npx pagesdown
```

That's it. The tool will walk you through everything.

## Setup Your Notion Integration (2 minutes)

The CLI guides you through this, but here's the overview:

**1. Create an internal integration**

Go to: [notion.so/profile/integrations/internal/form/new-integration](https://www.notion.so/profile/integrations/internal/form/new-integration)

- **Name:** anything you want (e.g. "export-to-fs") — cannot contain the word "notion"
- **Associated workspace:** select yours
- **Icon:** skip it
- Click **Create**

**2. Set capabilities**

On the next page, under **Capabilities**:
- **Content capabilities:**
  - **Read content** — check this (the only one you need)
  - **Update content** — uncheck
  - **Insert content** — uncheck
- **Comment capabilities:**
  - **Read comments** — uncheck
  - **Insert comments** — uncheck
- **User capabilities:**
  - Select **"No user information"**

Click **Save**.

**3. Copy your token**

Copy the **Internal Integration Secret** (starts with `ntn_`).

**4. Share pages with the integration**

Open any page you want to download in Notion:
- Click the **•••** menu at the top right
- Select **Connections**
- Add your integration

> Sharing a parent page automatically shares all its children.

## What You Get

```
~/Desktop/notion-export/
├── Project Alpha/
│   ├── Project Alpha.md
│   ├── Meeting Notes/
│   │   ├── Meeting Notes.md
│   │   └── assets/
│   │       └── screenshot.png
│   └── Design Doc/
│       └── Design Doc.md
└── Personal/
    ├── Personal.md
    └── Reading List/
        └── Reading List.md
```

- Pages become `.md` files with clean Markdown
- Folder hierarchy mirrors your Notion structure
- Images and files are downloaded to `assets/` folders with working relative links
- Databases are exported with properties as YAML frontmatter

## Features

- Guided setup — walks you through creating a Notion integration
- Select specific pages — don't have to download everything
- Cross-platform — macOS, Windows, Linux
- Token persistence — saves your token for next time
- Rate limit handling — respects Notion's API limits automatically
- Progress updates — see what's being downloaded in real time

## License

MIT
