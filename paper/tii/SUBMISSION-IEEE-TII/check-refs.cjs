// Reference-presence guard for the TII build.
//
// Usage:  node check-refs.cjs <pdf-text-file>
//
// The expected set is DERIVED, not hardcoded: every \cite key in main.tex and
// sections/*.tex must resolve in resources/refs.bib, and that key's title must
// then be found in the rendered text of main.pdf. A hardcoded title list goes
// stale silently whenever the bibliography is trimmed for the page budget --
// the previous revision of this script still asserted 31 references after the
// paper had been reduced to 23, so it reported 18/31 against a correct build.
//
// Matching normalizes both sides to lowercase alphanumerics, so line breaks,
// hyphenation and LaTeX braces/escapes do not defeat the comparison.
const fs = require('fs');
const path = require('path');

const textPath = process.argv[2];
if (!textPath) {
  console.error('usage: node check-refs.cjs <pdf-text-file>');
  process.exit(2);
}

const root = __dirname;
const bib = fs.readFileSync(path.join(root, 'resources/refs.bib'), 'utf8');

// key -> raw title from the .bib entry
const titles = {};
const entryRe = /@\w+\{([^,]+),([\s\S]*?)\n\}/g;
let m;
while ((m = entryRe.exec(bib)) !== null) {
  const key = m[1].trim();
  const body = m[2];
  const t = body.match(/title\s*=\s*\{([\s\S]*?)\}\s*,?\s*\n/);
  if (t) titles[key] = t[1];
}

// cited keys, in first-appearance order
const files = fs.readdirSync(path.join(root, 'sections'))
  .filter(f => f.endsWith('.tex')).sort()
  .map(f => path.join(root, 'sections', f));
files.push(path.join(root, 'main.tex'));

const cited = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const c of src.matchAll(/\\cite\{([^}]*)\}/g)) {
    for (const k of c[1].split(',')) {
      const key = k.trim();
      if (key && !cited.includes(key)) cited.push(key);
    }
  }
}

// lowercase alphanumerics only
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// strip LaTeX escapes/commands and braces before normalizing
const clean = s => s
  .replace(/\\[a-zA-Z]+\s*/g, ' ')
  .replace(/[{}~\\]/g, ' ');

const raw = fs.readFileSync(textPath, 'latin1');
const haystack = norm(raw);

let ok = 0;
const missing = [];
const unresolved = [];
for (const key of cited) {
  if (!titles[key]) { unresolved.push(key); continue; }
  const needle = norm(clean(titles[key]));
  // a 45-character window is long enough to be unique and short enough to
  // survive a title that the bibliography abbreviates
  const probe = needle.slice(0, Math.min(45, needle.length));
  if (probe && haystack.includes(probe)) ok++;
  else missing.push(`[${key}] ${titles[key].replace(/\s+/g, ' ').slice(0, 70)}`);
}

console.log(`pages: ${raw.split('\f').filter(x => x.trim().length).length}`);
console.log(`cited keys: ${cited.length}   bib entries: ${Object.keys(titles).length}`);
console.log(`refs present: ${ok}/${cited.length}`);

let fail = false;
if (unresolved.length) {
  console.log('CITED BUT NOT IN refs.bib:\n' + unresolved.join('\n'));
  fail = true;
}
if (missing.length) {
  console.log('MISSING FROM THE RENDERED PDF:\n' + missing.join('\n'));
  fail = true;
}
if (fail) process.exit(1);
console.log('CHECK-REFS PASS: every cited key resolves and appears in main.pdf');
