const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI_PATH = path.resolve(__dirname, '..', 'cli.js');

/**
 * Helper to run the CLI and capture output + exit code.
 * @param {string} args - CLI arguments
 * @param {Object} [opts] - Options
 * @param {string} [opts.env] - Extra env vars
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
function runCli(args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  try {
    const stdout = execSync(`node "${CLI_PATH}" ${args}`, {
      encoding: 'utf-8',
      env,
      cwd: opts.cwd || process.cwd(),
      timeout: 10000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status,
    };
  }
}

/**
 * Create a temporary knowledge directory with valid test files.
 */
function createTempKnowledgeDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  const knowledgeDir = path.join(tmpDir, 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  return { tmpDir, knowledgeDir };
}

/**
 * Write a valid markdown file with proper frontmatter.
 */
function writeValidMd(dir, relativePath, extra = '') {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, [
    '---',
    `title: ${path.basename(relativePath, '.md')}`,
    'description: A test node',
    'tags: [test]',
    '---',
    '',
    '# Content',
    extra,
    '',
  ].join('\n'));
}

// Write a node with explicit frontmatter fields (tags as an inline array).
function writeMd(dir, relativePath, { title, description, tags }) {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, [
    '---',
    `title: ${title}`,
    `description: ${description}`,
    `tags: [${tags.join(', ')}]`,
    '---',
    '',
    '# Content',
    '',
  ].join('\n'));
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Help command ---

describe('CLI help', () => {
  it('shows help when invoked with no arguments', () => {
    const result = runCli('');
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('Usage:'), 'Should show usage');
    assert.ok(result.stdout.includes('validate'), 'Should mention validate');
    assert.ok(result.stdout.includes('doctor'), 'Should mention doctor');
  });

  it('shows help with "help" command', () => {
    const result = runCli('help');
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('Usage:'));
  });

  it('shows help for unknown commands', () => {
    const result = runCli('unknown-command');
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.stdout.includes('Unknown command') || result.stderr.includes('Unknown command'),
      'Should indicate unknown command'
    );
  });
});

// --- Knowledge dir resolution ---

describe('CLI knowledge dir resolution', () => {
  let tmpDir, knowledgeDir;

  beforeEach(() => {
    const dirs = createTempKnowledgeDir();
    tmpDir = dirs.tmpDir;
    knowledgeDir = dirs.knowledgeDir;
    writeValidMd(knowledgeDir, 'test-node.md');
  });

  afterEach(() => cleanup(tmpDir));

  it('uses --dir flag when provided', () => {
    const result = runCli(`validate --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('[OK]'));
  });

  it('uses KNOWLEDGE_BASE_PATH env var and appends /knowledge', () => {
    const result = runCli('validate', { env: { KNOWLEDGE_BASE_PATH: tmpDir } });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('[OK]'));
  });

  it('falls back to ./knowledge when run from a knowledge repo', () => {
    const result = runCli('validate', { cwd: tmpDir });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('[OK]'));
  });

  it('--dir takes precedence over env var', () => {
    // Create a second dir that will fail
    const badDir = path.join(tmpDir, 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    writeValidMd(badDir, 'broken.md', '[[nonexistent-link]]');

    const result = runCli(`validate --dir "${knowledgeDir}"`, {
      env: { KNOWLEDGE_BASE_PATH: path.dirname(badDir) },
    });
    assert.equal(result.exitCode, 0, 'Should use --dir, not env var');
  });
});

// --- validate command ---

describe('CLI validate (all)', () => {
  let tmpDir, knowledgeDir;

  beforeEach(() => {
    const dirs = createTempKnowledgeDir();
    tmpDir = dirs.tmpDir;
    knowledgeDir = dirs.knowledgeDir;
  });

  afterEach(() => cleanup(tmpDir));

  it('exits 0 when everything is valid', () => {
    writeValidMd(knowledgeDir, 'node-a.md', 'See [[node-b]]');
    writeValidMd(knowledgeDir, 'node-b.md', 'See [[node-a]]');

    const result = runCli(`validate --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('[OK]'));
  });

  it('exits 1 when frontmatter has errors', () => {
    // Write a file with missing frontmatter
    const badFile = path.join(knowledgeDir, 'bad.md');
    fs.writeFileSync(badFile, '# No frontmatter here\n');

    const result = runCli(`validate --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.includes('[FAIL]'));
  });

  it('exits 1 when links are broken', () => {
    writeValidMd(knowledgeDir, 'with-broken-link.md', '[[does-not-exist]]');

    const result = runCli(`validate --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.includes('[FAIL]'));
    assert.ok(result.stdout.includes('does-not-exist'));
  });

  it('shows orphan warnings but exits 0 if no other errors', () => {
    // node-a links to node-b, but node-c is orphaned
    writeValidMd(knowledgeDir, 'node-a.md', 'See [[node-b]]');
    writeValidMd(knowledgeDir, 'node-b.md', 'See [[node-a]]');
    writeValidMd(knowledgeDir, 'node-c.md');

    const result = runCli(`validate --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 0, 'Orphans are warnings, should still exit 0');
    assert.ok(result.stdout.includes('[WARN]'));
    assert.ok(result.stdout.includes('node-c.md'));
  });
});

// --- validate --frontmatter ---

describe('CLI validate --frontmatter', () => {
  let tmpDir, knowledgeDir;

  beforeEach(() => {
    const dirs = createTempKnowledgeDir();
    tmpDir = dirs.tmpDir;
    knowledgeDir = dirs.knowledgeDir;
  });

  afterEach(() => cleanup(tmpDir));

  it('only runs frontmatter validation', () => {
    // Has broken link but valid frontmatter
    writeValidMd(knowledgeDir, 'test.md', '[[broken-link]]');

    const result = runCli(`validate --frontmatter --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 0, 'Broken links should not matter');
    assert.ok(result.stdout.includes('[OK]'));
    // Should NOT mention links
    assert.ok(!result.stdout.includes('links'));
  });

  it('exits 1 when frontmatter is invalid', () => {
    fs.writeFileSync(path.join(knowledgeDir, 'bad.md'), '# No frontmatter\n');

    const result = runCli(`validate --frontmatter --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.includes('[FAIL]'));
  });
});

// --- validate --links ---

describe('CLI validate --links', () => {
  let tmpDir, knowledgeDir;

  beforeEach(() => {
    const dirs = createTempKnowledgeDir();
    tmpDir = dirs.tmpDir;
    knowledgeDir = dirs.knowledgeDir;
  });

  afterEach(() => cleanup(tmpDir));

  it('only runs link validation', () => {
    // Has broken frontmatter but valid links
    fs.writeFileSync(path.join(knowledgeDir, 'no-fm.md'), '# No frontmatter\n');

    const result = runCli(`validate --links --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 0, 'Frontmatter errors should not matter');
    assert.ok(result.stdout.includes('[OK]'));
  });

  it('exits 1 when links are broken', () => {
    writeValidMd(knowledgeDir, 'test.md', '[[nonexistent]]');

    const result = runCli(`validate --links --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.includes('[FAIL]'));
  });
});

// --- validate --orphans ---

describe('CLI validate --orphans', () => {
  let tmpDir, knowledgeDir;

  beforeEach(() => {
    const dirs = createTempKnowledgeDir();
    tmpDir = dirs.tmpDir;
    knowledgeDir = dirs.knowledgeDir;
  });

  afterEach(() => cleanup(tmpDir));

  it('shows orphan warnings and exits 0 (orphans are warnings only)', () => {
    writeValidMd(knowledgeDir, 'orphan.md');

    const result = runCli(`validate --orphans --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 0, 'Orphans-only should always exit 0');
    assert.ok(result.stdout.includes('[WARN]'));
    assert.ok(result.stdout.includes('orphan.md'));
  });

  it('shows OK when no orphans found', () => {
    writeValidMd(knowledgeDir, 'a.md', '[[b]]');
    writeValidMd(knowledgeDir, 'b.md', '[[a]]');

    const result = runCli(`validate --orphans --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('[OK]'));
  });
});

// --- retired index commands ---

describe('CLI retired index commands', () => {
  let tmpDir, knowledgeDir;

  beforeEach(() => {
    const dirs = createTempKnowledgeDir();
    tmpDir = dirs.tmpDir;
    knowledgeDir = dirs.knowledgeDir;
  });

  afterEach(() => cleanup(tmpDir));

  // Retrieval greps frontmatter directly; there is no index to build or check.
  for (const gone of ['build-index', 'check-index']) {
    it(`rejects the removed '${gone}' command`, () => {
      const result = runCli(`${gone} --dir "${knowledgeDir}"`);
      assert.equal(result.exitCode, 1);
      assert.ok(
        result.stderr.includes('Unknown command') || result.stdout.includes('Unknown command'),
        `${gone} should be an unknown command`
      );
    });
  }

  it('never writes an _index.json', () => {
    writeValidMd(knowledgeDir, 'test-node.md');
    runCli(`validate --dir "${knowledgeDir}"`);
    assert.ok(!fs.existsSync(path.join(knowledgeDir, '_index.json')), 'no index should be generated');
  });
});

// --- tag health (informational) ---

describe('CLI validate — tag health', () => {
  let tmpDir, knowledgeDir;

  beforeEach(() => {
    const dirs = createTempKnowledgeDir();
    tmpDir = dirs.tmpDir;
    knowledgeDir = dirs.knowledgeDir;
  });

  afterEach(() => cleanup(tmpDir));

  it('reports near-duplicate tags as info without failing', () => {
    writeMd(knowledgeDir, 'a.md', { title: 'A', description: 'a', tags: ['error', 'shared'] });
    writeMd(knowledgeDir, 'b.md', { title: 'B', description: 'b', tags: ['errors', 'shared'] });

    const result = runCli(`validate --dir "${knowledgeDir}"`);
    assert.equal(result.exitCode, 0, 'tag drift is informational, must not fail');
    assert.ok(result.stdout.includes('[INFO]'), 'should emit an info line');
    assert.ok(result.stdout.includes('error~errors'), 'should name the near-duplicate pair');
  });
});
