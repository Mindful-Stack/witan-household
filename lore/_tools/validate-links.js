const fs = require('fs');
const path = require('path');

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

// A fence opens with ``` or ~~~ at up to three spaces of indent, and closes only with the same
// character and at least as many of them (CommonMark 4.5). Tracking the opening marker matters:
// a node documenting markdown itself can carry a ~~~ line inside a ``` block, and a naive toggle
// would read that as a close and expose the rest of the file as prose.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

// An inline code span on one line: `[[ -L $2 ]]`, ``[[ x ]]``. The delimiters must be equal-length
// backtick runs, so a lone stray backtick in prose matches nothing and leaves the line alone.
const INLINE_CODE = /(`+)[^`\n]*\1/g;

/**
 * Blank out fenced code blocks and inline code spans, keeping the line structure intact.
 *
 * Knowledge nodes document shell, where `[[ $x == "$y" ]]` is a conditional and not a wikilink.
 * Scanning raw content reports every such conditional as a broken link, which makes a bash
 * standard impossible to write down — the validator fails on correct documentation.
 *
 * Indented (four-space) code blocks are deliberately NOT stripped. Continuation lines of a nested
 * list are indented just as far, so treating indentation as code would silently drop real
 * wikilinks — a false negative, which is worse here than the false positive this fixes.
 *
 * @param {string} content - Markdown file content
 * @returns {string} The content with every code span replaced by blanks
 */
function stripCode(content) {
  let fence = null; // the opening marker while inside a fenced block, e.g. '```'

  return content
    .split('\n')
    .map((line) => {
      const opener = line.match(FENCE_LINE);

      if (opener) {
        const marker = opener[1];
        if (fence === null) {
          fence = marker;
        } else if (marker[0] === fence[0] && marker.length >= fence.length) {
          fence = null;
        }
        // Either way the fence line itself is never prose.
        return '';
      }

      return fence === null ? line.replace(INLINE_CODE, '') : '';
    })
    .join('\n');
}

/**
 * Extract all wikilinks from markdown content, ignoring anything inside code.
 *
 * @param {string} content - Markdown file content
 * @returns {string[]} Array of wikilink targets (text inside [[ ]])
 */
function extractLinks(content) {
  const matches = [];
  let match;
  const prose = stripCode(content);
  while ((match = WIKILINK_PATTERN.exec(prose)) !== null) {
    matches.push(match[1]);
  }
  // Reset lastIndex since the regex is global
  WIKILINK_PATTERN.lastIndex = 0;
  return matches;
}

/**
 * Check if a link resolves to an existing node.
 *
 * @param {string} link - The wikilink target (may include anchor fragments)
 * @param {Set<string>} nodes - Set of known node paths (both full relative paths and filename-only)
 * @returns {boolean} True if the link resolves to an existing node
 */
function resolveLink(link, nodes) {
  // Strip anchor fragments (e.g., #section-name)
  const linkWithoutAnchor = link.split('#')[0];

  // Direct match
  if (nodes.has(linkWithoutAnchor)) {
    return true;
  }

  // Try with .md extension stripped
  if (nodes.has(linkWithoutAnchor.replace('.md', ''))) {
    return true;
  }

  // Try as relative path suffix match
  for (const node of nodes) {
    if (node.endsWith('/' + linkWithoutAnchor) || node === linkWithoutAnchor) {
      return true;
    }
  }

  return false;
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
 * Build the set of all known node paths from markdown files.
 * Each file contributes two entries:
 *   - Full relative path without extension (e.g., "domain/device-management-context")
 *   - Filename only without extension (e.g., "device-management-context")
 *
 * @param {string} knowledgeDir - Path to the knowledge directory
 * @returns {Set<string>} Set of node identifiers
 */
function findAllNodes(knowledgeDir) {
  const nodes = new Set();
  const files = findMarkdownFiles(knowledgeDir);

  for (const filePath of files) {
    const relative = path.relative(knowledgeDir, filePath).replace(/\\/g, '/');
    // Add full relative path without extension
    const nodePathWithoutExt = relative.replace(/\.md$/, '');
    nodes.add(nodePathWithoutExt);

    // Also add just the filename without extension
    const basename = path.basename(filePath, '.md');
    nodes.add(basename);
  }

  return nodes;
}

/**
 * Validate all wikilinks in markdown files under a knowledge directory.
 *
 * @param {string} knowledgeDir - Path to the knowledge directory
 * @returns {Object.<string, string[]>} Map of relative filepath to array of broken link strings (only files with broken links)
 */
function validateAll(knowledgeDir) {
  if (!fs.existsSync(knowledgeDir)) {
    return {};
  }

  const nodes = findAllNodes(knowledgeDir);
  const files = findMarkdownFiles(knowledgeDir);
  const allBroken = {};

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const links = extractLinks(content);
    const broken = [];

    for (const link of links) {
      // Skip external links (containing : but not central: prefix)
      if (link.includes(':') && !link.startsWith('central:')) {
        continue;
      }

      // Strip central: prefix
      const cleanLink = link.replace('central:', '');

      if (!resolveLink(cleanLink, nodes)) {
        broken.push(link);
      }
    }

    if (broken.length > 0) {
      const relativePath = path.relative(knowledgeDir, filePath).replace(/\\/g, '/');
      allBroken[relativePath] = broken;
    }
  }

  return allBroken;
}

module.exports = { stripCode, extractLinks, resolveLink, validateAll };
