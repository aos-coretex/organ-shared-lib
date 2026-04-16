#!/usr/bin/env node
/**
 * Walk 01-Organs/<NNN>-<Organ>/*-llm-settings.yaml, validate each against
 * schema v1, print pass/fail summary. Exit non-zero if any file fails.
 *
 * Usage:
 *   node scripts/validate-all-settings.js [SETTINGS_ROOT]
 *
 * Default SETTINGS_ROOT:
 *   /Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/01-Organs
 *
 * MP-CONFIG-1 relay l9m-1.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validateSettings } from '../lib/llm-settings-schema.js';
import { LLMSettingsInvalid } from '../lib/llm-errors.js';

const DEFAULT_ROOT = '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/01-Organs';
const root = process.argv[2] || DEFAULT_ROOT;

function* walkSettingsYaml(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkSettingsYaml(full);
    } else if (entry.endsWith('-llm-settings.yaml')) {
      yield full;
    }
  }
}

function rel(p) {
  return p.replace(root + '/', '');
}

const files = [...walkSettingsYaml(root)].sort();
const results = [];
let pass = 0;
let fail = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  try {
    validateSettings(text, rel(file));
    results.push({ file, status: 'PASS' });
    pass += 1;
  } catch (err) {
    if (err instanceof LLMSettingsInvalid) {
      results.push({
        file,
        status: 'FAIL',
        field: err.field,
        reason: err.reason,
        actual_value: err.actual_value,
      });
    } else {
      results.push({ file, status: 'FAIL', reason: `unexpected error: ${err.message}` });
    }
    fail += 1;
  }
}

console.log(`\nLLM settings validation — root: ${root}`);
console.log(`Files scanned: ${files.length}`);
console.log(`PASS: ${pass}   FAIL: ${fail}\n`);

for (const r of results) {
  if (r.status === 'PASS') {
    console.log(`  [PASS] ${rel(r.file)}`);
  } else {
    console.log(`  [FAIL] ${rel(r.file)}`);
    console.log(`         field: ${r.field}`);
    console.log(`         reason: ${r.reason}`);
    if (r.actual_value !== undefined) {
      console.log(`         actual: ${JSON.stringify(r.actual_value)}`);
    }
  }
}

process.exit(fail === 0 ? 0 : 1);
