const fs = require('fs');
const path = require('path');

const REQUIRED_FIELDS = ['title', 'description', 'tags'];

// Single-value fields whose content must sit inline on the key's own line.
// Retrieval greps `^title:` / `^description:`, so a YAML block scalar (`>` or
// `|`, which pushes the value onto indented following lines) leaves the matched
// line valueless and drops the field out of search. `tags` is covered separately:
// a block list parses to an empty value and already fails the "must be a list" check.
const INLINE_SCALAR_FIELDS = ['title', 'description'];

/**
 * Extract the raw text between the leading `---` fences.
 * @param {string} content
 * @returns {string|null} the frontmatter body, or null if none
 */
function frontmatterBlock(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  return match ? match[1] : null;
}

/**
 * Find required scalar fields authored as a YAML block scalar (`field: >` or
 * `field: |`, with optional chomping indicator). These are invisible to the
 * `^field:` retrieval grep.
 * @param {string} content - full file content
 * @returns {string[]} offending field names
 */
function blockScalarFields(content) {
  const block = frontmatterBlock(content);
  if (!block) return [];
  return INLINE_SCALAR_FIELDS.filter((field) =>
    new RegExp(`^${field}:[ \\t]*[>|][+-]?[ \\t]*$`, 'm').test(block)
  );
}

/**
 * Parse YAML frontmatter from markdown content.
 * Uses a simple regex-based approach (no full YAML parser needed).
 *
 * @param {string} content - Markdown file content
 * @returns {Object} Parsed frontmatter key-value pairs, or {} if none found
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return {};

  const data = {};
  const lines = match[1].split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Parse inline arrays: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim());
    }

    if (key) {
      data[key] = value;
    }
  }

  return data;
}

/**
 * Validate a single markdown file's frontmatter.
 *
 * @param {string} content - The file content as a string
 * @param {string} filename - The filename (used to skip _-prefixed files)
 * @returns {string[]} Array of error messages (empty if valid)
 */
function validateFile(content, filename) {
  // Skip _-prefixed files
  if (path.basename(filename).startsWith('_')) {
    return [];
  }

  const frontmatter = parseFrontmatter(content);

  // If parseFrontmatter returned empty and no frontmatter fence was found
  if (Object.keys(frontmatter).length === 0 && !content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)) {
    return ['Missing or invalid frontmatter'];
  }

  const errors = [];

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in frontmatter)) {
      errors.push(`Missing required field: ${field}`);
    } else if (!frontmatter[field] || (typeof frontmatter[field] === 'string' && frontmatter[field].length === 0)) {
      errors.push(`Empty required field: ${field}`);
    }
  }

  // Validate tags is a list
  if ('tags' in frontmatter && !Array.isArray(frontmatter.tags)) {
    errors.push('Tags must be an inline list (e.g. [a, b]) — a block list drops out of search');
  }

  // Required scalar fields must be inline: retrieval greps `^field:`
  for (const field of blockScalarFields(content)) {
    errors.push(
      `${field} is a YAML block scalar (> or |); retrieval greps '^${field}:' and sees no value — put it on one line`
    );
  }

  // Validate title length
  if ('title' in frontmatter && typeof frontmatter.title === 'string' && frontmatter.title.length > 100) {
    errors.push('Title too long (max 100 characters)');
  }

  // Validate description length
  if ('description' in frontmatter && typeof frontmatter.description === 'string' && frontmatter.description.length > 300) {
    errors.push('Description too long (max 300 characters)');
  }

  return errors;
}

/**
 * Recursively find all .md files in a directory.
 *
 * @param {string} dir - Directory to search
 * @param {string[]} [files=[]] - Accumulator for found files
 * @returns {string[]} Array of full file paths
 */
function findMarkdownFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findMarkdownFiles(fullPath, files);
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Validate all markdown files in a knowledge directory.
 *
 * @param {string} knowledgeDir - Path to the knowledge directory
 * @returns {Object.<string, string[]>} Map of relative filename to error arrays (only files with errors)
 */
function validateAll(knowledgeDir) {
  const allErrors = {};
  const files = findMarkdownFiles(knowledgeDir);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(knowledgeDir, filePath).replace(/\\/g, '/');
    const filename = path.basename(filePath);

    const errors = validateFile(content, filename);
    if (errors.length > 0) {
      allErrors[relativePath] = errors;
    }
  }

  return allErrors;
}

/**
 * Two tags are near-duplicates — the same concept written two ways — when one is
 * the other's simple plural, or they are identical once separators are removed.
 *
 * This is deliberately high-precision, not high-recall. Real tag drift is almost
 * always a plural (`camera`/`cameras`) or a separator difference
 * (`ef-core`/`efcore`). Generic edit-distance was tried and dropped: it flagged
 * genuinely distinct tech tags one edit apart (`xunit`/`nunit`, `jest`/`rest`,
 * `fota`/`rota`) and version suffixes (`dotnet`/`dotnet9`). Since this signal is
 * advisory and glanceable, a false positive costs more than a missed pair — a
 * lone misspelling still surfaces in the singleton report.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function areNearDuplicates(a, b) {
  if (a === b) return false;
  if (a + 's' === b || b + 's' === a) return true;
  const strip = (s) => s.replace(/[-_]/g, '');
  return strip(a) !== a || strip(b) !== b ? strip(a) === strip(b) : false;
}

/**
 * Collect every tag used across the knowledge base, with per-tag usage counts.
 * Skips `_`-prefixed files, matching validateFile.
 * @param {string} knowledgeDir
 * @returns {Map<string, number>} tag -> count
 */
function collectTags(knowledgeDir) {
  const counts = new Map();
  for (const filePath of findMarkdownFiles(knowledgeDir)) {
    if (path.basename(filePath).startsWith('_')) continue;
    const fm = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    for (const tag of tags) {
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Informational tag-health report. Never an error — the vocabulary is fully
 * dynamic (a KB's tags ARE its vocabulary), so this only surfaces two signals a
 * human should glance at: tags used exactly once (can't cluster anything) and
 * near-duplicate pairs (likely drift/typos of the same concept).
 * @param {string} knowledgeDir
 * @returns {{distinctTags:number, totalUses:number, singletons:string[], nearDuplicates:[string,string][]}}
 */
function tagHealth(knowledgeDir) {
  const counts = collectTags(knowledgeDir);
  const tags = [...counts.keys()].sort();

  const singletons = tags.filter((t) => counts.get(t) === 1);

  const nearDuplicates = [];
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      if (areNearDuplicates(tags[i], tags[j])) nearDuplicates.push([tags[i], tags[j]]);
    }
  }

  return {
    distinctTags: tags.length,
    totalUses: [...counts.values()].reduce((a, b) => a + b, 0),
    singletons,
    nearDuplicates,
  };
}

module.exports = {
  parseFrontmatter,
  validateFile,
  validateAll,
  blockScalarFields,
  tagHealth,
  areNearDuplicates,
};
