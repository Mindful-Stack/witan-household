const fs = require('fs');
const path = require('path');

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

// A fence line: up to three spaces of indent, then a run of at least three backticks or tildes,
// then the info string (openers) or trailing junk (which disqualifies a closer).
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Find the line ranges covered by fenced code blocks, as inclusive [start, end] pairs.
 *
 * Only a block whose opener AND closer are both visible is reported. CommonMark says an unclosed
 * fence runs to the end of the document, and this deliberately does not: a lone opener is far more
 * often a line this scanner misread than a real unterminated block, and swallowing the rest of the
 * file would hide every wikilink after it. Reporting a link that turns out to be code is a noisy
 * failure someone fixes; silently passing a broken link is the one that ships.
 *
 * @param {string[]} lines - The file split on newlines
 * @returns {Array<[number, number]>} Inclusive line ranges to blank
 */
function fenceRegions(lines) {
  const regions = [];
  let open = null;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].replace(/\r$/, '').match(FENCE_LINE);
    if (!match) continue;

    const [, marker, rest] = match;

    if (open === null) {
      // A backtick fence's info string may not itself contain a backtick, so this is not an opener.
      if (marker[0] === '`' && rest.includes('`')) continue;
      open = { start: i, marker };
      continue;
    }

    // A closer matches the opening character, is at least as long, and carries nothing but space.
    const closes =
      marker[0] === open.marker[0] && marker.length >= open.marker.length && /^\s*$/.test(rest);
    if (closes) {
      regions.push([open.start, i]);
      open = null;
    }
    // Otherwise this is ordinary content inside the block — a shorter fence, or one with trailing
    // text, neither of which closes anything.
  }

  return regions; // an unterminated `open` is dropped on purpose; see above
}

/**
 * Blank the inline code spans in a single line, preserving its length.
 *
 * A span is a run of backticks closed by a run of exactly the same length (CommonMark 6.1). Runs
 * that never find their match are literal text and are left alone, which is what keeps
 * `` `[[node]]`` `` — unbalanced, therefore prose — from losing its link. A backslash-escaped
 * backtick cannot open a span.
 *
 * @param {string} line - One line of markdown
 * @returns {string} The line with code spans replaced by spaces
 */
function stripInlineCode(line) {
  const runAt = (from, want) => {
    let i = from;
    while (i < line.length) {
      if (line[i] !== '`') {
        i += 1;
        continue;
      }
      let len = 0;
      while (line[i + len] === '`') len += 1;
      if (len === want) return i;
      i += len;
    }
    return -1;
  };

  let out = '';
  let i = 0;

  while (i < line.length) {
    if (line[i] === '\\') {
      out += line.slice(i, i + 2); // an escaped character, backtick included, is literal
      i += 2;
      continue;
    }

    if (line[i] !== '`') {
      out += line[i];
      i += 1;
      continue;
    }

    let len = 0;
    while (line[i + len] === '`') len += 1;

    const close = runAt(i + len, len);
    if (close === -1) {
      out += line.slice(i, i + len); // unmatched run: literal backticks, not a delimiter
      i += len;
      continue;
    }

    out += ' '.repeat(close + len - i);
    i = close + len;
  }

  return out;
}

/**
 * Blank out fenced code blocks and inline code spans, keeping the line structure intact.
 *
 * Knowledge nodes document shell, where `[[ $x == "$y" ]]` is a conditional and not a wikilink.
 * Scanning raw content reports every such conditional as a broken link, which makes a bash
 * standard impossible to write down — correct documentation fails the validator.
 *
 * Two deliberate departures from CommonMark, both chosen so a misread never hides a real link:
 * an unclosed fence is treated as prose rather than running to EOF (see fenceRegions), and a code
 * span is confined to one line, so a rare multi-line span may still expose its contents.
 *
 * Indented (four-space) code blocks are NOT stripped either. Continuation lines of a nested list
 * are indented just as far, so treating indentation as code would silently drop real wikilinks.
 * The known cost: a fence indented four spaces, or by a tab, is an indented block rather than a
 * fence, so a wikilink-shaped string inside one is still reported. Tests pin this.
 *
 * Note the blast radius: check-orphans.js shares extractLinks, so this also stops a wikilink
 * written inside a code sample from counting as an inbound link. That is the intended reading —
 * demonstrating the syntax is not referencing the node — but it can newly orphan a node whose
 * only inbound link lived in a fence.
 *
 * @param {string} content - Markdown file content
 * @returns {string} The content with every code span replaced by blanks
 */
function stripCode(content) {
  const lines = content.split('\n');
  const fenced = new Set();

  for (const [start, end] of fenceRegions(lines)) {
    for (let i = start; i <= end; i += 1) fenced.add(i);
  }

  return lines.map((line, i) => (fenced.has(i) ? '' : stripInlineCode(line))).join('\n');
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
