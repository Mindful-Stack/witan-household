// Pure helpers for reading and re-serialising household.json. No I/O, no global
// state — safe to import from any script or test.

/**
 * Extract "<org>/<repo>" from a GitHub remote URL. Accepts SSH and HTTPS forms,
 * with or without a trailing `.git`. Returns null for non-GitHub or empty input.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function parseRemoteUrl(url) {
  if (!url) return null;
  let m = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return m[1];
  m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (m) return m[1];
  return null;
}

/**
 * Rewrite the trailing repo name in a remote URL, preserving its form. Matches
 * the final `/<oldName>` segment with an optional `.git` suffix, anchored at the
 * end of the string, so it works for SSH and HTTPS URLs with or without `.git`
 * and never touches an org segment that happens to share the name. Returns the
 * URL unchanged when it's falsy or doesn't end in `<oldName>`.
 *
 * @param {string|null|undefined} url
 * @param {string} oldName
 * @param {string} newName
 * @returns {string|null|undefined}
 */
export function renameRepoInUrl(url, oldName, newName) {
  if (!url) return url;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return url.replace(new RegExp(`/${escaped}(\\.git)?$`), `/${newName}$1`);
}

/**
 * Serialise a manifest back to JSON the way household.json is hand-authored:
 * 2-space indent, but short all-string arrays (e.g. `tags`) re-inlined onto a
 * single line when they fit under 80 columns. Keeps diffs minimal when a script
 * rewrites the file.
 *
 * @param {object} manifest
 * @returns {string} JSON text with a trailing newline
 */
export function formatRepos(manifest) {
  let s = JSON.stringify(manifest, null, 2);
  // Match an array body containing only quoted strings spread across lines, and
  // re-inline it if the collapsed form stays under 80 columns.
  s = s.replace(
    /\[\n\s+("(?:[^"\\]|\\.)*"(?:,\n\s+"(?:[^"\\]|\\.)*")*)\n\s*\]/g,
    (match, items) => {
      // Split only on the cross-line separator JSON.stringify emits — never on
      // commas inside string contents.
      const inline = '[' + items.split(/,\n\s+/).map(t => t.trim()).join(', ') + ']';
      return inline.length <= 80 ? inline : match;
    },
  );
  return s + '\n';
}
