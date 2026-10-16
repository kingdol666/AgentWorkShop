# -*- coding: utf-8 -*-
"""Publication-figure save helper (reconstructed shim, 2026-10-16).

make-process-figure.py and make-missions-figure.py import
``pubfig.save_figure``, but the original module was not kept in the
repository. This shim reproduces the call contract those scripts rely on:
save ``fig`` as a vector PDF at the figure's designed size
(``figsize`` x inches, no bounding-box tightening), so the media box equals
the layout the generators were tuned against. The generators' own
self-checks (media box, minimum type size, text-collision sweep) verify the
resulting PDF after this call.
"""
from __future__ import annotations


def save_figure(fig, out, spec=None, width=None, height_mm=None,
                trim=False, **kwargs):
    """Save ``fig`` to ``out`` as a PDF at its native figure size.

    ``spec`` / ``width`` / ``height_mm`` / ``trim`` are accepted for
    signature compatibility with the original helper; the generators already
    set the final printed size via ``figsize``, so no extra scaling applies.
    """
    fig.savefig(out, format="pdf")
    return out
