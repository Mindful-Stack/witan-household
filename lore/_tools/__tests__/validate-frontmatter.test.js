const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parseFrontmatter, validateFile, validateAll, blockScalarFields, tagHealth, areNearDuplicates } = require('../validate-frontmatter');

// --- parseFrontmatter ---

describe('parseFrontmatter', () => {
  it('parses simple key-value fields', () => {
    const content = [
      '---',
      'title: My Title',
      'description: A description',
      '---',
      '',
      '# Body',
    ].join('\n');
    const fm = parseFrontmatter(content);
    assert.equal(fm.title, 'My Title');
    assert.equal(fm.description, 'A description');
  });

  it('parses inline array tags', () => {
    const content = [
      '---',
      'title: T',
      'tags: [a, b, c]',
      '---',
      '',
    ].join('\n');
    const fm = parseFrontmatter(content);
    assert.deepEqual(fm.tags, ['a', 'b', 'c']);
  });

  it('returns empty object when no frontmatter', () => {
    const fm = parseFrontmatter('# Just a heading\nSome text');
    assert.deepEqual(fm, {});
  });

  it('returns empty object when frontmatter is missing closing ---', () => {
    const content = [
      '---',
      'title: Oops',
      '',
      '# No closing fence',
    ].join('\n');
    const fm = parseFrontmatter(content);
    assert.deepEqual(fm, {});
  });

  it('handles values containing colons', () => {
    const content = [
      '---',
      'title: My Title: A Subtitle',
      '---',
      '',
    ].join('\n');
    const fm = parseFrontmatter(content);
    assert.equal(fm.title, 'My Title: A Subtitle');
  });

  it('trims whitespace from keys and values', () => {
    const content = [
      '---',
      '  title :  Spaced Out  ',
      '---',
      '',
    ].join('\n');
    const fm = parseFrontmatter(content);
    assert.equal(fm.title, 'Spaced Out');
  });
});

// --- validateFile ---

describe('validateFile', () => {
  it('returns no errors for valid frontmatter', () => {
    const content = [
      '---',
      'title: Valid Title',
      'description: A valid description',
      'tags: [foo, bar]',
      '---',
      '',
      '# Content',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    assert.deepEqual(errors, []);
  });

  it('returns empty array for _-prefixed files (skipped)', () => {
    const content = '# No frontmatter at all';
    const errors = validateFile(content, '_overview.md');
    assert.deepEqual(errors, []);
  });

  it('returns error when frontmatter is missing', () => {
    const content = '# No frontmatter\nJust text.';
    const errors = validateFile(content, 'test.md');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].toLowerCase().includes('missing'));
  });

  it('returns errors for each missing required field', () => {
    const content = [
      '---',
      'title: Only Title',
      '---',
      '',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    // Should report missing description and tags
    assert.ok(errors.length >= 2);
    const joined = errors.join(' ');
    assert.ok(joined.includes('description'));
    assert.ok(joined.includes('tags'));
  });

  it('returns error when a required field is empty', () => {
    const content = [
      '---',
      'title: ',
      'description: Something',
      'tags: [a]',
      '---',
      '',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    assert.ok(errors.length >= 1);
    assert.ok(errors.some(e => e.includes('title') || e.includes('empty') || e.includes('Empty')));
  });

  it('returns error when tags is not a list', () => {
    const content = [
      '---',
      'title: T',
      'description: D',
      'tags: not-a-list',
      '---',
      '',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    assert.ok(errors.some(e => e.toLowerCase().includes('tags') && e.toLowerCase().includes('list')));
  });

  it('returns error when title exceeds 100 characters', () => {
    const longTitle = 'A'.repeat(101);
    const content = [
      '---',
      `title: ${longTitle}`,
      'description: D',
      'tags: [a]',
      '---',
      '',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    assert.ok(errors.some(e => e.toLowerCase().includes('title') && e.toLowerCase().includes('long')));
  });

  it('accepts title exactly 100 characters', () => {
    const title = 'A'.repeat(100);
    const content = [
      '---',
      `title: ${title}`,
      'description: D',
      'tags: [a]',
      '---',
      '',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    assert.deepEqual(errors, []);
  });

  it('returns error when description exceeds 300 characters', () => {
    const longDesc = 'B'.repeat(301);
    const content = [
      '---',
      'title: T',
      `description: ${longDesc}`,
      'tags: [a]',
      '---',
      '',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    assert.ok(errors.some(e => e.toLowerCase().includes('description') && e.toLowerCase().includes('long')));
  });

  it('accepts description exactly 300 characters', () => {
    const desc = 'B'.repeat(300);
    const content = [
      '---',
      'title: T',
      `description: ${desc}`,
      'tags: [a]',
      '---',
      '',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    assert.deepEqual(errors, []);
  });

  it('collects multiple errors at once', () => {
    const longTitle = 'A'.repeat(101);
    const content = [
      '---',
      `title: ${longTitle}`,
      'tags: not-a-list',
      '---',
      '',
    ].join('\n');
    const errors = validateFile(content, 'test.md');
    // Should have: missing description, tags not list, title too long
    assert.ok(errors.length >= 3);
  });
});

// --- validateAll ---

describe('validateAll', () => {
  let tmpDir;

  function createFile(name, content) {
    const filePath = path.join(tmpDir, name);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-fm-test-'));
  }

  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  it('returns empty object when all files are valid', () => {
    setup();
    try {
      createFile('good.md', [
        '---',
        'title: Good',
        'description: A good file',
        'tags: [test]',
        '---',
        '',
        '# Good',
      ].join('\n'));

      const result = validateAll(tmpDir);
      assert.deepEqual(result, {});
    } finally {
      teardown();
    }
  });

  it('returns errors keyed by filename for invalid files', () => {
    setup();
    try {
      createFile('bad.md', '# No frontmatter');

      const result = validateAll(tmpDir);
      assert.ok(result['bad.md']);
      assert.ok(result['bad.md'].length > 0);
    } finally {
      teardown();
    }
  });

  it('skips _-prefixed files', () => {
    setup();
    try {
      createFile('_overview.md', '# No frontmatter');
      createFile('good.md', [
        '---',
        'title: Good',
        'description: Good',
        'tags: [test]',
        '---',
        '',
      ].join('\n'));

      const result = validateAll(tmpDir);
      assert.deepEqual(result, {});
    } finally {
      teardown();
    }
  });

  it('recurses into subdirectories', () => {
    setup();
    try {
      createFile('sub/nested.md', '# No frontmatter');

      const result = validateAll(tmpDir);
      // Key should use forward-slash relative path
      const keys = Object.keys(result);
      assert.equal(keys.length, 1);
      assert.ok(keys[0].includes('nested.md'));
    } finally {
      teardown();
    }
  });

  it('ignores non-.md files', () => {
    setup();
    try {
      createFile('readme.txt', 'Not a markdown file');
      createFile('data.json', '{}');

      const result = validateAll(tmpDir);
      assert.deepEqual(result, {});
    } finally {
      teardown();
    }
  });
});

// --- inline-frontmatter requirement (the retrieval-critical guard) ---

describe('block-scalar detection', () => {
  const inline = [
    '---',
    'title: A Title',
    'description: One line',
    'tags: [a, b]',
    '---',
    '',
    '# Body',
  ].join('\n');

  it('inline scalars produce no block-scalar findings', () => {
    assert.deepEqual(blockScalarFields(inline), []);
  });

  it('folded description (>) is flagged', () => {
    const content = [
      '---',
      'title: A Title',
      'description: >',
      '  wrapped over',
      '  two lines',
      'tags: [a]',
      '---',
      '',
      '# Body',
    ].join('\n');
    assert.deepEqual(blockScalarFields(content), ['description']);
    const errors = validateFile(content, 'x.md');
    assert.ok(errors.some((e) => e.includes('block scalar') && e.includes('description')));
  });

  it('literal title (|) is flagged, and is an error, not just a warning', () => {
    const content = [
      '---',
      'title: |',
      '  multi',
      'description: fine',
      'tags: [a]',
      '---',
      '',
      '# Body',
    ].join('\n');
    assert.deepEqual(blockScalarFields(content), ['title']);
    assert.ok(validateFile(content, 'x.md').length > 0);
  });

  it('a block LIST of tags fails (must be an inline list)', () => {
    const content = [
      '---',
      'title: A',
      'description: fine',
      'tags:',
      '  - a',
      '  - b',
      '---',
      '',
      '# Body',
    ].join('\n');
    const errors = validateFile(content, 'x.md');
    assert.ok(errors.some((e) => e.toLowerCase().includes('inline list')));
  });

  it('does not false-positive on a description containing > mid-text', () => {
    const content = [
      '---',
      'title: A',
      'description: uses a > b comparison inline',
      'tags: [a]',
      '---',
      '',
      '# Body',
    ].join('\n');
    assert.deepEqual(blockScalarFields(content), []);
    assert.deepEqual(validateFile(content, 'x.md'), []);
  });
});

// --- tag health (informational, dynamic vocabulary) ---

describe('areNearDuplicates', () => {
  it('flags simple plurals', () => {
    assert.equal(areNearDuplicates('error', 'errors'), true);
    assert.equal(areNearDuplicates('guideline', 'guidelines'), true);
  });
  it('flags separator drift', () => {
    assert.equal(areNearDuplicates('ef-core', 'efcore'), true);
  });
  it('does not flag distinct tech tags one edit apart (precision over recall)', () => {
    // The reason generic edit-distance was dropped: these are all distinct.
    assert.equal(areNearDuplicates('xunit', 'nunit'), false);
    assert.equal(areNearDuplicates('jest', 'rest'), false);
    assert.equal(areNearDuplicates('dotnet', 'dotnet9'), false);
  });
  it('does not flag genuinely different tags', () => {
    assert.equal(areNearDuplicates('security', 'testing'), false);
  });
});

describe('tagHealth', () => {
  const os = require('os');
  function setup(files) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tags-'));
    for (const [name, tags] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmp, name), [
        '---', 'title: T', 'description: d', `tags: [${tags.join(', ')}]`, '---', '', '# B',
      ].join('\n'));
    }
    return tmp;
  }

  it('counts singletons and distinct tags', () => {
    const dir = setup({ 'a.md': ['shared', 'once'], 'b.md': ['shared'] });
    const h = tagHealth(dir);
    assert.equal(h.distinctTags, 2);
    assert.deepEqual(h.singletons, ['once']);
  });

  it('reports near-duplicate pairs', () => {
    const dir = setup({ 'a.md': ['error'], 'b.md': ['errors'] });
    const h = tagHealth(dir);
    assert.deepEqual(h.nearDuplicates, [['error', 'errors']]);
  });

  it('skips _-prefixed files', () => {
    const dir = setup({ '_starter.md': ['ghost'], 'a.md': ['real'] });
    const h = tagHealth(dir);
    assert.ok(!h.singletons.includes('ghost'));
  });
});
