# Knowledge base (`lore/`)

The household's shared, durable knowledge base — domain model, architecture, and engineering standards —
kept tool-native for the [Lorekeeper](https://github.com/Mindful-Stack/witan) plugin, which resolves
`lore/` via sibling-fallback.

> **This is a template.** Replace the placeholder `_starter.md` files and the examples below with your
> household's real content; keep the structure and conventions.

## Layout

```
knowledge/
├── general/      cross-cutting standards & conventions — code review, security, testing,
│                 workflow, architecture, observability…
├── domain/       the DDD bounded-context model — one node per context, plus meta files
│                 (_context-map, _glossary, _journeys, _domain-questions)
├── frameworks/   per-framework patterns, review checklists, conventions (one subdir per framework)
├── languages/    per-language code style, error handling, review checklists (one subdir per language)
└── learnings/    captured gotchas / tribal knowledge worth remembering
```

There is no generated index. Retrieval greps frontmatter directly (`^(title|description|tags):`),
so a node is searchable the moment it is written — nothing to rebuild.

Each category ships with a `_starter.md` placeholder — replace it with real nodes as the workspace matures.

## Conventions

- Each node is a markdown file with YAML frontmatter: `title`, `description` (≤300 chars), and `tags`
  (an **inline** array, e.g. `[a, b]`).
- Keep every frontmatter value **inline on its own line** — retrieval greps `^title:`,
  `^description:`, `^tags:`, so a value wrapped onto following lines (a `>` / `|` block scalar, or
  a block `tags:` list) is invisible to search. `make validate` fails on this.
- `_`-prefixed files and folders are meta (context maps, glossaries, logs) — skipped by validation.
- Cross-link nodes with `[[wikilinks]]` (the node path without `.md`, relative to `knowledge/`).
- Document the **durable standard / model**, not transient work. Keep nodes atomic and scannable, so a
  reader (human or agent) can load one node and answer "what is this, how is it used, what's contested?"

## Tooling

The `_tools/` CLI is wired into the workspace `Makefile`. From the workspace root:

- `make validate` — check frontmatter (present + inline), wikilinks, orphans, and tag health
- `make doctor` — full diagnostic (manifest, siblings, frontmatter, links, orphans, tag health)

## Where to start (new contributor)

1. `knowledge/domain/_context-map.md` — the system at a glance (once a domain model exists).
2. The bounded context or the standards relevant to your task.

---
*Part of a [witan-household](https://github.com/Mindful-Stack/witan-household). The `lore/` knowledge base
travels with the workspace and is consumed by Lorekeeper.*
