#!/usr/bin/env node
// Enforces the layer boundaries and determinism rules described in PLAN.md.
//
// Layers:   engine  <- protocol <- storage      (arrows = "may be imported by")
//           ui may import engine/protocol/storage/vendor; nothing imports ui or headless.
// Engine additionally bans all sources of nondeterminism.
//
// Escape hatch for a justified single line:  append  // boundaries-allow
// (use sparingly; every use should have a comment explaining why it is safe).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const srcRoot = join(root, 'src');

/** Allowed import targets per layer. Keys checked against module specifiers. */
const LAYER_RULES = {
  engine: {
    aliases: ['@engine'],
    bare: [], // zero runtime dependencies
  },
  protocol: {
    aliases: ['@engine', '@protocol', '@vendor'],
    bare: [],
  },
  storage: {
    aliases: ['@engine', '@storage'],
    bare: ['kysely', 'sqlocal', 'better-sqlite3', 'node:'],
  },
  ui: {
    aliases: ['@engine', '@protocol', '@storage', '@ui', '@vendor', '@ai'],
    bare: ['svelte', 'pixi.js', 'kysely', 'sqlocal'],
  },
  ai: {
    aliases: ['@engine', '@protocol', '@ai'],
    bare: [],
  },
  headless: {
    aliases: ['@engine', '@protocol', '@storage', '@ai'],
    bare: ['node:', 'better-sqlite3', 'kysely'],
  },
};

/** Nondeterminism bans for src/engine (non-test files). Math.sqrt is allowed:
 * IEEE 754 requires it correctly rounded, unlike the transcendental functions. */
const ENGINE_BANNED = [
  /\bMath\.random\b/,
  /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|pow|exp|expm1|log|log2|log10|log1p|cbrt|hypot)\b/,
  /\bnew\s+Date\b/,
  /\bDate\.now\b/,
  /\bperformance\s*\./,
  /\bcrypto\s*\./,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bqueueMicrotask\b/,
  /\bnavigator\s*\./,
  /\btoLocale[A-Za-z]*\(/,
  /\bIntl\s*\./,
];

const errors = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|svelte|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function layerOf(file) {
  const rel = relative(srcRoot, file);
  if (rel.startsWith('..')) return null;
  return rel.split(sep)[0];
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function checkImports(file, text, layer, isTest) {
  const rules = LAYER_RULES[layer];
  if (!rules) return;
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    const line = text.slice(0, m.index).split('\n').length;
    const lineText = text.split('\n')[line - 1] ?? '';
    if (lineText.includes('boundaries-allow')) continue;
    if (isTest && (spec === 'vitest' || spec.startsWith('vitest/'))) continue;

    if (spec.startsWith('.')) {
      // relative import must stay inside the layer directory
      const target = resolve(dirname(file), spec);
      const targetLayer = layerOf(target + '.ts') ?? layerOf(join(target, 'index.ts'));
      if (targetLayer !== null && targetLayer !== layer) {
        errors.push(`${rel(file)}:${line} relative import escapes layer '${layer}': ${spec}`);
      }
    } else if (spec.startsWith('@')) {
      const alias = spec.split('/')[0];
      if (['@engine', '@protocol', '@storage', '@ui', '@vendor', '@ai'].includes(alias)) {
        if (!rules.aliases.includes(alias)) {
          errors.push(`${rel(file)}:${line} layer '${layer}' may not import ${alias} (${spec})`);
        }
      } else if (!rules.bare.some((b) => spec === b || spec.startsWith(b))) {
        errors.push(`${rel(file)}:${line} layer '${layer}' may not import package '${spec}'`);
      }
    } else {
      if (!rules.bare.some((b) => spec === b || spec.startsWith(b))) {
        errors.push(`${rel(file)}:${line} layer '${layer}' may not import package '${spec}'`);
      }
    }
  }
}

function checkEngineDeterminism(file, text, layer) {
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    if (lineText.includes('boundaries-allow')) return;
    const trimmed = lineText.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const re of ENGINE_BANNED) {
      // The controller's event-driven executor schedules work; pure policies
      // and the observation boundary get the same determinism bans as engine.
      if (layer === 'ai' && file.endsWith('/controller.ts') && re.source === '\\bqueueMicrotask\\b') continue;
      if (re.test(lineText)) {
        errors.push(`${rel(file)}:${i + 1} banned in ${layer} (${re.source}): ${lineText.trim()}`);
      }
    }
  });
}

function rel(p) {
  return relative(root, p);
}

for (const file of walk(srcRoot)) {
  const layer = layerOf(file);
  if (!layer || !(layer in LAYER_RULES)) continue;
  const text = readFileSync(file, 'utf8');
  const isTest = /\.test\.ts$/.test(file);
  checkImports(file, text, layer, isTest);
  if ((layer === 'engine' || layer === 'ai') && !isTest) checkEngineDeterminism(file, text, layer);
}

if (errors.length) {
  console.error(`Boundary check FAILED (${errors.length} problem${errors.length > 1 ? 's' : ''}):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
} else {
  console.log('Boundary check passed.');
}
