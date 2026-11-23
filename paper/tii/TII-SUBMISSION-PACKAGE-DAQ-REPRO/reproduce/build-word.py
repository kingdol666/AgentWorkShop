#!/usr/bin/env python3
"""Synchronize the original TII Word layout with a narrow LaTeX prose revision.

Requires Python 3.10+, lxml and Pandoc 3.x; PDF previews also require LibreOffice.
Pass the two main.tex files (with their inputs/assets in place) and either original
FINAL DOCX. Only changed prose paragraphs are transplanted; this is not a general
LaTeX converter. Layout XML, tables, figures, bibliography, and other package parts
come from the original Word file. New float/table edits and citation changes need
an explicit rebuild; use ordinary prose for a new results block. The Word layout
settings stay in place, but changed prose can reflow. Use --check before building.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass, field
from difflib import SequenceMatcher
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import unicodedata
from zipfile import BadZipFile, ZipFile

try:
    from lxml import etree as ET
except ImportError:
    sys.exit('build-word: Python package lxml is required')

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
M = '{http://schemas.openxmlformats.org/officeDocument/2006/math}'
PART = 'word/document.xml'
BODY_STYLES = {'BodyText', 'FirstParagraph'}
TAGS = re.compile(r'\\(begin|end)\{([\w*]+)\}')
ENV_START = re.compile(r'^(?:\\noindent\s*)?\\begin\{([\w*]+)\}')
DIRECTIVE = re.compile(
    r'^\\(?:section|subsection|subsubsection|label|title|author|markboth|bstctlcite|'
    r'maketitle|IEEEpeerreviewmaketitle|bibliographystyle|bibliography|par)\b'
)
INPUT = re.compile(r'^\\input\{([^{}]+)\}$')
ASSET = re.compile(r'\\(includegraphics|bibliography)(?:\[[^]]*\])?\{([^{}]+)\}')
COMMENT = re.compile(r'(?<!\\)((?:\\\\)*)%.*$')
REF = re.compile(r'\\ref\{([^{}]+)\}')
ALLOWED_INLINES = {'Str', 'Space', 'SoftBreak', 'Code', 'Emph', 'Strong', 'Quoted', 'Math'}


class BuildError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise BuildError(message)


def source_file(root, rel):
    p = (root / rel).resolve()
    require(p.is_relative_to(root) and p.is_file(), f'missing or out-of-tree source file: {p}')
    return p


@dataclass(frozen=True)
class Prose:
    where: str
    text: str

    def __str__(self):
        return f'{self.where}: {self.text.splitlines()[0][:90]}'


@dataclass
class Source:
    fences: list[tuple[str, str, str]] = field(default_factory=list)
    groups: list[list[Prose]] = field(default_factory=lambda: [[]])
    assets: dict[str, bytes] = field(default_factory=dict)

    def fence(self, kind, text, where):
        self.fences.append((kind, text, where))
        self.groups.append([])


def read_source(main):
    """Recognize the structural boundaries of this specific IEEEtran source tree."""
    root = main.parent
    result = Source()

    def read(rel, stack, is_main=False):
        path = source_file(root, rel)
        require(path not in stack, f'cyclic LaTeX input: {path}')
        lines = []
        joined = ''
        for i, line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(), 1):
            match = COMMENT.search(line)
            if not joined:
                start = i
            if match:
                # TeX ignores the comment and its newline. A standalone comment
                # is not a blank paragraph delimiter.
                joined += line[:match.start()] + match[1]
                continue
            lines.append((start, joined + line.lstrip() if joined else line))
            joined = ''
        if joined:
            lines.append((start, joined))

        def fence(kind, text, line):
            result.fence(kind, text, f'{rel}:{line}')

        if is_main:
            for marker in (r'\begin{document}', r'\end{document}'):
                require(sum(text.strip() == marker for _, text in lines) == 1,
                        f'{path}: expected one {marker}')
            begin = next(j for j, (_, t) in enumerate(lines) if t.strip() == r'\begin{document}')
            end = next(j for j, (_, t) in enumerate(lines) if t.strip() == r'\end{document}')
            require(begin < end, f'{path}: inverted document bounds')
            fence('preamble', '\n'.join(t.rstrip() for _, t in lines[:begin]).strip(), 1)
        else:
            begin, end = -1, len(lines)

        para = []
        def flush():
            if para:
                result.groups[-1].append(Prose(f'{rel}:{para[0][0]}',
                                              '\n'.join(t for _, t in para)))
                para.clear()

        def record_assets(text):
            for command, names in ASSET.findall(text):
                for name in names.split(','):
                    name = name.strip() + ('.bib' if command == 'bibliography' else '')
                    result.assets[name] = source_file(root, name).read_bytes()

        j = begin + 1
        while j < end:
            line, raw = lines[j]
            text = raw.strip()
            j += 1
            if not text:
                flush()
            elif text in (r'\begin{abstract}', r'\end{abstract}'):
                flush()
                fence('abstract', text, line)
            elif m := INPUT.fullmatch(text):
                flush()
                fence('input', text, line)
                name = m[1] if m[1].endswith('.tex') else m[1] + '.tex'
                read(name, (*stack, path))
                fence('end input', text, line)
            elif ENV_START.match(text):
                flush()
                opened, protected = [], [text]
                while True:
                    for direction, name in TAGS.findall(text):
                        if direction == 'begin':
                            opened.append(name)
                        else:
                            require(opened and opened.pop() == name,
                                    f'{rel}:{line}: mismatched LaTeX environment {name}')
                    if not opened:
                        break
                    require(j < end, f'{rel}:{line}: unclosed LaTeX environment {opened[-1]}')
                    text = lines[j][1].rstrip()
                    protected.append(text)
                    j += 1
                block = '\n'.join(protected)
                record_assets(block)
                fence('protected environment', block, line)
            elif DIRECTIVE.match(text):
                flush()
                record_assets(text)
                fence('directive', text, line)
            else:
                para.append((line, text))
        flush()
        if is_main:
            fence('postamble', '\n'.join(t.rstrip() for _, t in lines[end:]).strip(), lines[end][0])

    read(main.name, (), True)
    return result


def compare_sources(old, new):
    require(old.assets.keys() == new.assets.keys(), 'the figure/bibliography asset list changed')
    for name in old.assets:
        require(old.assets[name] == new.assets[name], f'protected figure/bibliography asset changed: {name}')
    for a, b in zip(old.fences, new.fences):
        require(a[:2] == b[:2],
                f'unsupported structural edit at {b[2]} ({b[0]}; baseline {a[2]}, {a[0]}); '
                'keep headings, figures, tables, equations, lists, labels and preamble unchanged')
    require(len(old.fences) == len(new.fences), 'the LaTeX structural block count changed')
    return [(i, a, b) for i, (a, b) in enumerate(zip(old.groups, new.groups))
            if [p.text for p in a] != [p.text for p in b]]


def run(command, *, cwd, data=None, timeout=90, allow_stderr=False):
    proc = subprocess.run(command, input=data, cwd=cwd, capture_output=True,
                          encoding='utf-8', errors='replace', timeout=timeout)
    require(proc.returncode == 0 and (allow_stderr or not proc.stderr.strip()),
            f'{Path(command[0]).name} failed or warned (exit {proc.returncode}): '
            f'{(proc.stderr or proc.stdout).strip()}')
    if proc.stderr.strip():
        print(f'{Path(command[0]).name}: {proc.stderr.strip()}', file=sys.stderr)
    return proc.stdout


def xml(data):
    tree = ET.fromstring(data, ET.XMLParser(resolve_entities=False, no_network=True))
    require(not tree.getroottree().docinfo.doctype, 'unexpected DTD in DOCX XML')
    return tree


def children(node, tag):
    return [n for n in node if n.tag == tag]


def visible(node):
    return ''.join(n.text or '' for n in node.iter(W + 't', M + 't'))


def normalized(text):
    # Existing Word adjustments may use curly instead of straight quotes or
    # convert NBSP to ordinary space. No fuzzy, case, or punctuation matching.
    return ' '.join(unicodedata.normalize('NFC', text).translate(str.maketrans('‘’“”', "''\"\"")).split())


def style(para):
    prop = para.find(f'{W}pPr/{W}pStyle')
    return prop.get(W + 'val') if prop is not None else None


def xml_key(node):
    return node.tag, sorted(node.attrib.items()), node.text or '', [xml_key(n) for n in node]


def shape(node, base=None):
    """Compare text, inline emphasis, math, and link targets, not line/run breaks."""
    def enabled(prop, key):
        el = prop.find(W + key) if prop is not None else None
        return el is not None and el.get(W + 'val') not in {'0', 'off', 'false'}

    parts = []
    for n in node:
        if n.tag == W + 'pPr':
            continue
        if n.tag == W + 'r':
            require(all(ch.tag in {W + 'rPr', W + 't'} for ch in n),
                    'edited Word prose contains a field, break, drawing, or other non-text run')
            prop = n.find(W + 'rPr')
            rs = prop.find(W + 'rStyle') if prop is not None else None
            signature = (rs.get(W + 'val') if rs is not None else None,
                         enabled(prop, 'b') and not enabled(base, 'b'),
                         enabled(prop, 'i') and not enabled(base, 'i'))
            if parts and parts[-1][0] == 'text' and parts[-1][1] == signature:
                parts[-1] = ('text', signature, parts[-1][2] + visible(n))
            else:
                parts.append(('text', signature, visible(n)))
        elif n.tag == W + 'hyperlink' and set(n.attrib) == {W + 'anchor'}:
            parts.append(('ref', n.get(W + 'anchor'), shape(n)))
        elif n.tag == M + 'oMath':
            parts.append(('math', None, xml_key(n)))
        else:
            raise BuildError(f'edited Word prose contains unsupported XML: {n.tag}')
    return [('text', s, normalized(t)) if k == 'text' else (k, s, t) for k, s, t in parts
            if k != 'text' or normalized(t)]


def parse_fragments(pandoc, work, items, refs):
    """Read LaTeX prose only, rejecting Pandoc constructs we cannot transplant."""
    if not items:
        return {}
    frames = []
    # One tagged frame per source paragraph, including a hard paragraph fence.
    for i, (para, prefix) in enumerate(items):
        text = re.sub(r'\\IEEEPARstart\{([^{}]+)\}\{([^{}]+)\}', r'\1\2', para.text)
        frames.append(f'TIIWORDBUILDMARKER{i:06d}X\n\n{prefix}{text}')
    ast = json.loads(run([pandoc, '--sandbox', '-f', 'latex+raw_tex', '-t', 'json'],
                         cwd=work, data='\n\n'.join(frames) + '\n'))
    require(not ast['meta'] and len(ast['blocks']) == 2 * len(items),
            'LaTeX prose did not parse as one paragraph per source block; '
            'check for commands, display math, lists, or other structure in edited prose')
    counts = []
    for i, ((para, _), marker, block) in enumerate(zip(items, ast['blocks'][::2], ast['blocks'][1::2])):
        require(marker == {'t': 'Para', 'c': [{'t': 'Str', 'c': f'TIIWORDBUILDMARKER{i:06d}X'}]}
                and block['t'] == 'Para', f'{para}: expected one simple LaTeX prose paragraph')
        n_math = 0
        def convert(inlines):
            nonlocal n_math
            for obj in inlines:
                tag = obj['t']
                if tag == 'RawInline' and (m := REF.fullmatch(obj['c'][1])):
                    label = m[1]
                    require(label in refs, f'{para}: no verified Word cross-reference for {label!r}')
                    obj.update(t='Link', c=[['', [], []], [{'t': 'Str', 'c': visible(refs[label])}],
                                            ['#' + label, '']])
                elif tag in {'Emph', 'Strong', 'Quoted'}:
                    convert(obj['c'][-1] if tag == 'Quoted' else obj['c'])
                elif tag == 'Math' and obj['c'][0]['t'] == 'InlineMath':
                    n_math += 1
                else:
                    require(tag in ALLOWED_INLINES - {'Math'},
                            f'{para}: unsupported LaTeX inline {tag}: {obj.get("c", "")!r}')
        convert(block['c'])
        counts.append(n_math)
    ast['blocks'] = ast['blocks'][1::2]
    output = work / 'prose-fragments.docx'
    run([pandoc, '--sandbox', '-f', 'json', '-t', 'docx', '-o', str(output)],
        cwd=work, data=json.dumps(ast))
    with ZipFile(output) as archive:
        body = xml(archive.read(PART)).find(W + 'body')
    paragraphs = children(body, W + 'p')
    require(len(paragraphs) == len(items), 'Pandoc produced the wrong number of Word prose paragraphs')
    result = {}
    for (para, prefix), n_math, p in zip(items, counts, paragraphs):
        require(visible(p).strip() and len(children(p, M + 'oMath')) == n_math,
                f'{para}: empty Word paragraph or inline math conversion failed')
        shape(p)  # reject unsupported XML before it enters the original package
        result[para, prefix] = p
    return result


def base_format(original, where):
    """Infer only uniform direct formatting; varying formatting cannot be presumed."""
    bases = []
    for n in original:
        if n.tag != W + 'r' or not visible(n).strip():
            continue
        prop = n.find(W + 'rPr')
        p = ET.Element(W + 'rPr') if prop is None else deepcopy(prop)
        for child in list(p):
            if child.tag in {W + 'rStyle', W + 'iCs', W + 'bCs'} or (
                    child.tag in {W + 'i', W + 'b'} and child.get(W + 'val') is None):
                p.remove(child)
        bases.append(p)
    require(bases, f'{where}: no baseline Word text style to inherit')
    allowed = {W + key for key in ('rFonts', 'b', 'i', 'sz', 'szCs')}
    require(all(all(ch.tag in allowed for ch in p) and xml_key(p) == xml_key(bases[0]) for p in bases),
            f'{where}: mixed or unsupported direct formatting in original Word paragraph')
    return bases[0]


def transplanted(template, base, refs, styles):
    result = []
    for node in template:
        if node.tag == W + 'pPr':
            continue
        n = deepcopy(node)
        if n.tag == W + 'hyperlink':
            n = deepcopy(refs[n.get(W + 'anchor')])
        elif n.tag == W + 'r':
            inline = n.find(W + 'rPr')
            prop = deepcopy(base)
            if inline is not None:
                for f in inline:
                    found = prop.find(f.tag)
                    if found is not None:
                        prop.replace(found, deepcopy(f))
                    elif f.tag == W + 'rStyle':
                        require(f.get(W + 'val') in styles, 'Word template is missing a character style')
                        prop.insert(0, deepcopy(f))
                    else:
                        # Bold/italic properties precede sizes in the OOXML schema.
                        size = next((k for k, child in enumerate(prop) if child.tag in {W + 'sz', W + 'szCs'}), len(prop))
                        prop.insert(size, deepcopy(f))
                n.remove(inline)
            if len(prop):
                n.insert(0, prop)
        result.append(n)
    return result


def plan_and_patch(old, new, edits, root, styles, pandoc, work):
    body = root.find(W + 'body')
    require(body is not None, 'original DOCX has no editable Word body')
    paragraphs = children(body, W + 'p')
    abstract = [p for p in paragraphs if style(p) == 'Abstract']
    require(len(abstract) == 1, 'expected exactly one original Word Abstract paragraph')
    prefix = 'Abstract—' if visible(abstract[0]).startswith('Abstract—') else ''
    title = [p for p in paragraphs if style(p) == 'Title']
    titles = [f[1][7:-1] for f in old.fences if f[1].startswith(r'\title{')]
    require(len(title) == len(titles) == 1 and normalized(visible(title[0])) == normalized(titles[0]),
            'the original Word title does not match the baseline LaTeX title')
    bookmarks = [n.get(W + 'name') for n in body.iter(W + 'bookmarkStart')]
    links = defaultdict(list)
    for n in body.iter(W + 'hyperlink'):
        if set(n.attrib) == {W + 'anchor'}:
            links[n.get(W + 'anchor')].append(n)
    refs = {key: nodes[0] for key, nodes in links.items()
            if bookmarks.count(key) == 1 and len({visible(n) for n in nodes}) == 1}
    indices = defaultdict(list)
    for p in paragraphs:
        if style(p) in BODY_STYLES | {'Abstract'}:
            indices[style(p) == 'Abstract', normalized(visible(p))].append(p)
    a_index = next((i + 1 for i, f in enumerate(old.fences) if f[1] == r'\begin{abstract}'), -1)
    require(a_index >= 0 and len(old.groups[a_index]) == len(new.groups[a_index]) == 1,
            'expected one LaTeX abstract paragraph in both inputs')
    # Check the abstract even when it is unchanged, so a no-op is not entirely unchecked.
    items = {(old.groups[a_index][0], prefix): None}
    jobs = []
    for group, a, b in edits:
        atexts, btexts = ([p.text for p in g] for g in (a, b))
        use_prefix = prefix if group == a_index else ''
        for op, i, j, k, l in SequenceMatcher(None, atexts, btexts, autojunk=False).get_opcodes():
            if op == 'equal':
                continue
            left = a[i - 1] if i and i == j else None
            right = a[i] if i == j and i < len(a) else None
            jobs.append((group, a[i:j], b[k:l], left, right))
            for p in [*a[i:j], *b[k:l], left, right]:
                if p is not None:
                    items[p, use_prefix] = None
    rendered = parse_fragments(pandoc, work, list(items), refs)

    # Validate the entire selected baseline match, including inline semantics,
    # before changing any XML. Match visible text first so duplicates fail even
    # if only one has the expected formatting.
    def locate(p, is_abstract=False):
        template = rendered[p, prefix if is_abstract else '']
        matches = indices[is_abstract, normalized(visible(template))]
        require(len(matches) == 1, f'{p}: expected exactly one matching Word paragraph, found {len(matches)}')
        original = matches[0]
        base = base_format(original, p.where)
        require(shape(original, base) == shape(template),
                f'{p}: original Word inline markup does not match the baseline LaTeX')
        return original, base

    locate(old.groups[a_index][0], True)
    plans = []
    for group, a, b, left, right in jobs:
        where = (a or b)[0]
        is_abstract = group == a_index
        use_prefix = prefix if is_abstract else ''
        found = [locate(p, is_abstract) for p in a]
        originals = [p for p, _ in found]
        left = locate(left) if left else None
        right = locate(right) if right else None
        if left is not None and right is not None:
            require(left[0].getnext() is right[0], f'{where}: insertion anchors are not adjacent in Word')
        require(all(x.getnext() is y for x, y in zip(originals, originals[1:])),
                f'{where}: original Word paragraphs are not adjacent and in order')
        anchor_pair = found[-1] if found else left or right
        require(anchor_pair is not None, f'{where}: no adjacent original prose anchor in this LaTeX block')
        anchor, anchor_base = anchor_pair
        after = bool(found or left is not None)
        if not after:
            require(style(anchor) != 'FirstParagraph', f'{where}: cannot prepend to a first-in-section paragraph')
        if len(b) > len(a) and after:
            require(anchor.find(f'{W}pPr/{W}sectPr') is None, f'{where}: cannot insert after a Word section break')
        for p in originals[len(b):]:
            require(style(p) == 'BodyText' and not p.attrib and
                    all(n.tag == W + 'pStyle' for n in p.find(W + 'pPr')),
                    f'{where}: cannot delete a Word section break, first paragraph or layout properties')
        replacements = []
        for n, p in enumerate(b):
            template = rendered[p, use_prefix]
            base = found[n][1] if n < len(found) else anchor_base
            replacement = transplanted(template, base, refs, styles)
            probe = ET.Element(W + 'p')
            probe.extend(replacement)
            require(visible(probe) == visible(template) and shape(probe, base) == shape(template),
                    f'{p}: Word replacement differs from revised LaTeX text or inline markup')
            replacements.append(replacement)
        plans.append((originals, anchor, after, replacements, where))

    touched = set()
    next_index = -1
    for found, anchor, after, replacements, where in plans:
        current_index = body.index(found[0] if found else anchor)
        require(current_index >= next_index and not touched.intersection(found),
                f'{where}: Word paragraph patches overlap or are out of source order')
        next_index = body.index(found[-1] if found else anchor)
        touched.update(found)
    for found, anchor, after, replacements, where in reversed(plans):
        # Insert first so an anchor retained by the same patch stays available.
        for nodes in replacements[len(found):] if after else reversed(replacements):
            require('BodyText' in styles, 'Word template is missing BodyText')
            p = ET.Element(W + 'p')
            ET.SubElement(ET.SubElement(p, W + 'pPr'), W + 'pStyle').set(W + 'val', 'BodyText')
            p.extend(nodes)
            if after:
                anchor.addnext(p)
                anchor = p
            else:
                anchor.addprevious(p)
                anchor = p
        for p, nodes in zip(found, replacements):
            for child in list(p):
                if child.tag != W + 'pPr':
                    p.remove(child)
            p.extend(nodes)
        for p in found[len(replacements):]:
            body.remove(p)
        print(f'  {where} ({len(found)} -> {len(replacements)} Word paragraphs)')
    return len(plans)


def executable(name, fallback=()):
    for candidate in (name, *fallback):
        path = shutil.which(candidate)
        if path:
            return str(Path(path).resolve())
    raise BuildError(f'executable not found: {name}')


def validate_output(path, suffix):
    p = path.resolve()
    require(p.suffix.lower() == suffix and p.parent.is_dir(),
            f'expected a {suffix} output in an existing directory: {p}')
    require(not p.exists() and not path.is_symlink(), f'refusing to overwrite an existing output: {path}')
    return p


def pack(original, target, doc_xml):
    if doc_xml is None:
        shutil.copyfile(original, target)
        return
    with ZipFile(original) as src, ZipFile(target, 'w') as dst:
        dst.comment = src.comment
        for part in src.infolist():
            dst.writestr(part, doc_xml if part.filename == PART else src.read(part))
    with ZipFile(original) as src, ZipFile(target) as dst:
        require(dst.testzip() is None and src.namelist() == dst.namelist(), 'DOCX package verification failed')
        require(dst.read(PART) == doc_xml, 'written DOCX document XML does not match verified XML')
        for name in src.namelist():
            if name != PART:
                require(dst.read(name) == src.read(name), f'DOCX part changed unexpectedly: {name}')


def export(original, docx, pdf, doc_xml, soffice):
    # Stage on each destination volume; hard-link publication is atomic and
    # fails rather than overwriting if another process creates the output first.
    with TemporaryDirectory(prefix='.word-build-', dir=docx.parent) as d:
        staging = Path(d)
        staged_docx = staging / 'manuscript.docx'
        pack(original, staged_docx, doc_xml)
        if pdf is None:
            os.link(staged_docx, docx)
            return
        with TemporaryDirectory(prefix='.word-preview-', dir=pdf.parent) as d:
            preview_dir = Path(d)
            profile = (preview_dir / 'lo-profile').as_uri()
            run([soffice, f'-env:UserInstallation={profile}', '--headless', '--convert-to', 'pdf:writer_pdf_Export',
                 '--outdir', str(preview_dir), str(staged_docx)], cwd=staging, timeout=180, allow_stderr=True)
            staged_pdf = preview_dir / 'manuscript.pdf'
            require(staged_pdf.is_file(), 'LibreOffice did not produce the requested PDF')
            data = staged_pdf.read_bytes()
            require(data.startswith(b'%PDF-') and b'%%EOF' in data[-1024:], 'LibreOffice produced an invalid PDF')
            os.link(staged_docx, docx)
            try:
                os.link(staged_pdf, pdf)
            except OSError:
                docx.unlink()
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('baseline-tex', 'revised-tex', 'original-docx'):
        parser.add_argument('--' + option, required=True, type=Path)
    parser.add_argument('--output-docx', type=Path, help='new Word output; never overwrites a file')
    parser.add_argument('--preview-pdf', type=Path, help='optional new PDF generated from the Word output')
    parser.add_argument('--check', action='store_true', help='validate and report paragraph patches without writing outputs')
    parser.add_argument('--pandoc', default='pandoc', help='Pandoc executable name or path')
    parser.add_argument('--soffice', help='LibreOffice executable name or path (only for preview)')
    args = parser.parse_args()
    if args.check and (args.output_docx or args.preview_pdf) or not args.check and not args.output_docx:
        parser.error('use either --check or --output-docx [--preview-pdf]')
    try:
        docx = validate_output(args.output_docx, '.docx') if args.output_docx else None
        pdf = validate_output(args.preview_pdf, '.pdf') if args.preview_pdf else None
        original = args.original_docx.resolve(strict=True)
        old, new = (read_source(p.resolve(strict=True)) for p in (args.baseline_tex, args.revised_tex))
        edits = compare_sources(old, new)
        pandoc = executable(args.pandoc)
        fallback = [str(Path(os.environ.get(key, 'C:/Program Files')) / 'LibreOffice/program/soffice.com')
                    for key in ('ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)')] if os.name == 'nt' else []
        soffice = executable(args.soffice) if pdf and args.soffice else (
            executable('soffice', ('libreoffice', *fallback)) if pdf else None)
        with ZipFile(original) as archive:
            require(len(set(archive.namelist())) == len(archive.namelist()), 'duplicate DOCX package parts')
            root = xml(archive.read(PART))
            styles = {n.get(W + 'styleId') for n in xml(archive.read('word/styles.xml')).iter(W + 'style')}
        with TemporaryDirectory(prefix='tii-word-build-') as d:
            count = plan_and_patch(old, new, edits, root, styles, pandoc, Path(d))
        doc_xml = ET.tostring(root, encoding='UTF-8', xml_declaration=True, standalone=True) if count else None
        if not args.check:
            export(original, docx, pdf, doc_xml, soffice)
        print(f'build-word: verified {count} prose patch(es)' + ('; check only' if args.check else f'; wrote {docx}'))
        if pdf:
            print(f'build-word: wrote {pdf}')
        return 0
    except (BuildError, OSError, ValueError, KeyError, BadZipFile, ET.XMLSyntaxError, subprocess.TimeoutExpired) as exc:
        print(f'build-word: ERROR: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
