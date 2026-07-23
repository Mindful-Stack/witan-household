#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const { validateAll: validateFrontmatter, tagHealth } = require('./validate-frontmatter');
const { validateAll: validateLinks } = require('./validate-links');
const { findOrphans } = require('./check-orphans');

// --- Argument parsing ---

/**
 * Parse CLI arguments into a command and flags object.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ command: string, flags: Object }}
 */
function parseArgs(argv) {
  const flags = {};
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir' && i + 1 < argv.length) {
      flags.dir = argv[++i];
    } else if (arg === '--links') {
      flags.links = true;
    } else if (arg === '--frontmatter') {
      flags.frontmatter = true;
    } else if (arg === '--orphans') {
      flags.orphans = true;
    } else if (!arg.startsWith('-') && !command) {
      command = arg;
    }
  }

  return { command, flags };
}

// --- Knowledge dir resolution ---

/**
 * Resolve the knowledge directory path.
 * Priority: --dir flag > KNOWLEDGE_BASE_PATH env var + /knowledge > ./knowledge
 *
 * @param {Object} flags - Parsed flags
 * @returns {string} Resolved knowledge directory path
 */
function resolveKnowledgeDir(flags) {
  // 1. --dir flag
  if (flags.dir) {
    return path.resolve(flags.dir);
  }

  // 2. KNOWLEDGE_BASE_PATH env var -> append /knowledge
  if (process.env.KNOWLEDGE_BASE_PATH) {
    return path.resolve(process.env.KNOWLEDGE_BASE_PATH, 'knowledge');
  }

  // 3. ./knowledge fallback
  return path.resolve('knowledge');
}

// --- Output helpers ---

function ok(msg) {
  console.log(`[OK] ${msg}`);
}

function warn(msg) {
  console.log(`[WARN] ${msg}`);
}

function fail(msg) {
  console.log(`[FAIL] ${msg}`);
}

function info(msg) {
  console.log(`[INFO] ${msg}`);
}

// --- Commands ---

/**
 * Run validate command.
 * @param {string} knowledgeDir
 * @param {Object} flags
 * @returns {number} Exit code
 */
function cmdValidate(knowledgeDir, flags) {
  const runAll = !flags.links && !flags.frontmatter && !flags.orphans;
  let hasErrors = false;

  // Frontmatter validation
  if (runAll || flags.frontmatter) {
    const fmErrors = validateFrontmatter(knowledgeDir);
    const errorCount = Object.keys(fmErrors).length;

    if (errorCount > 0) {
      fail('Frontmatter errors found:');
      for (const [file, errors] of Object.entries(fmErrors)) {
        console.log(`  ${file}:`);
        for (const err of errors) {
          console.log(`    - ${err}`);
        }
      }
      hasErrors = true;
    } else {
      ok('All frontmatter valid');
    }
  }

  // Link validation
  if (runAll || flags.links) {
    const linkErrors = validateLinks(knowledgeDir);
    const brokenCount = Object.keys(linkErrors).length;

    if (brokenCount > 0) {
      fail('Broken links found:');
      for (const [file, broken] of Object.entries(linkErrors)) {
        console.log(`  ${file}:`);
        for (const link of broken) {
          console.log(`    - [[${link}]]`);
        }
      }
      hasErrors = true;
    } else {
      ok('All links valid');
    }
  }

  // Orphan check
  if (runAll || flags.orphans) {
    const orphans = findOrphans(knowledgeDir);

    if (orphans.length > 0) {
      warn(`${orphans.length} orphaned nodes found (not linked from anywhere):`);
      for (const orphan of orphans) {
        console.log(`  - ${orphan}`);
      }
    } else {
      ok('No orphaned nodes');
    }
  }

  // Tag health (informational — never affects exit code). Tags are the
  // retrieval vocabulary, so this reports drift, not policy violations.
  if (runAll || flags.frontmatter) {
    const health = tagHealth(knowledgeDir);
    if (health.nearDuplicates.length > 0) {
      const pairs = health.nearDuplicates.map(([a, b]) => `${a}~${b}`).join(', ');
      info(`${health.nearDuplicates.length} near-duplicate tag pair(s) — likely drift: ${pairs}`);
    }
    if (health.singletons.length > 0) {
      info(`${health.singletons.length}/${health.distinctTags} tags used once (can't cluster) — prefer reusing an existing tag`);
    }
  }

  return hasErrors ? 1 : 0;
}

/**
 * Print help text.
 */
function printHelp() {
  console.log(`Usage: node src/cli.js <command> [options]

Commands:
  validate                  Run all validations (frontmatter, links, orphans)
  validate --frontmatter    Only frontmatter validation
  validate --links          Only link validation
  validate --orphans        Only orphan check (warnings)
  doctor                    Run full workspace + KB diagnostic
  help                      Show this help message

Options:
  --dir <path>              Path to knowledge directory (default: auto-resolved)

Knowledge directory resolution (first wins):
  1. --dir <path>
  2. KNOWLEDGE_BASE_PATH env var + /knowledge
  3. ./knowledge (fallback)

Exit codes:
  0  Success (orphan warnings do not cause failure)
  1  Errors found or command failed`);
}

// --- Main ---

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (!command || command === 'help') {
    printHelp();
    process.exit(0);
  }

  if (!['validate', 'doctor'].includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error('Run `node src/cli.js help` for usage information.');
    process.exit(1);
  }

  const knowledgeDir = resolveKnowledgeDir(flags);

  let exitCode;
  switch (command) {
    case 'validate':
      exitCode = cmdValidate(knowledgeDir, flags);
      break;
    case 'doctor': {
      const { runDoctor } = require('./doctor');
      const knowledgeDirDoctor = flags.dir ? path.resolve(flags.dir) : path.resolve(__dirname, '../knowledge');
      exitCode = runDoctor(knowledgeDirDoctor);
      break;
    }
  }

  process.exit(exitCode);
}

main();
