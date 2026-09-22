"""Regression checks for the current five-figure IEEE TII package.

python -B -m unittest discover -s paper/tii/SUBMISSION-IEEE-TII/figures -p test_publication_figures.py -v
"""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import matplotlib.pyplot as plt
import make_publication_figures as figures


class PublicationFiguresTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        figures.configure()
        cls.env, cls.mission = figures.load_mission()

    def test_current_five_figures_and_ownership_boundaries(self):
        self.assertEqual(set(figures.FIGURES), {
            "fig1-supervisory-binding", "fig2-architecture",
            "fig3-governed-supervisory-workflow", "fig-operational-walkthrough",
            "fig-agentteam-mission",
        })
        self.assertNotIn("fig3-channel-loop", figures.FIGURES)
        self.assertEqual(figures.FIG1_GENERATOR.name, "make_fig1.py")
        self.assertEqual(figures.FIGURES["fig2-architecture"][0], "publication/fig2-architecture.pdf")
        self.assertEqual(figures.FIGURES["fig3-governed-supervisory-workflow"][0],
                         "publication/fig3-governed-supervisory-workflow.pdf")
        self.assertEqual(figures.FIGURES["fig-operational-walkthrough"][0],
                         "walkthrough/fig-operational-walkthrough.pdf")

    def test_exact_archived_observations_and_discrete_points(self):
        self.assertEqual([row["thickness"] for row in self.mission],
                         [26.90, 26.82, 26.46, 26.00, 25.48])
        self.assertEqual([row["iter"] for row in self.mission], [0, 1, 2, 3, 4])
        self.assertEqual(self.mission[-1]["from"], 33.099998474121094)
        plotted = json.loads((figures.OUT / "plotted-data.json").read_text(encoding="utf-8"))
        self.assertEqual(plotted["mission"], self.mission)
        self.assertFalse(plotted["display"]["connecting_lines"])

    def test_mission_uses_markers_not_a_continuous_trajectory(self):
        original = json.dumps(self.mission)
        fig = figures.mission_figure(self.mission)
        try:
            axes = fig.axes[1]
            observations = [line for line in axes.lines if line.get_marker() == "o"]
            self.assertEqual(len(observations), 1)
            self.assertEqual(observations[0].get_linestyle(), "None")
            self.assertEqual(list(observations[0].get_xdata()), [0, 1, 2, 3, 4])
            self.assertEqual(list(observations[0].get_ydata()),
                             [row["thickness"] for row in self.mission])
            self.assertEqual(list(axes.get_xticks()), [0, 1, 2, 3, 4])
            self.assertEqual(json.dumps(self.mission), original)
        finally:
            plt.close(fig)

    def test_ledger_readable_and_minimum_annotation_size(self):
        fig = figures.mission_figure(self.mission)
        try:
            self.assertTrue(all(text.get_fontsize() >= 8 for text in fig.axes[0].texts))
            labels = [text.get_text() for text in fig.axes[0].texts]
            self.assertIn("33.1 → 33.7 m/min", labels)
            self.assertEqual(labels.count("Modbus TCP"), 3)
            self.assertEqual(labels.count("OPC UA"), 1)
        finally:
            plt.close(fig)

    def test_frozen_source_mismatch_rejected(self):
        with patch.object(figures, "sha256", return_value="changed"):
            with self.assertRaisesRegex(ValueError, "Frozen B source hash mismatch"):
                figures.load_mission()

    def test_new_drawio_source_target_ids_and_icon_slots(self):
        source = figures.ROOT / figures.FIG3_SOURCE
        cells, edges, icon_slots, invalid = figures._xml_cells(source)
        self.assertEqual(len(cells), 64)
        self.assertEqual(len(edges), 11)
        self.assertEqual(len(icon_slots), 11)
        self.assertEqual(invalid, [])
        vertex_ids = {cell.attrib["id"] for cell in cells if cell.attrib.get("vertex") == "1"}
        self.assertTrue(all(edge.attrib["source"] in vertex_ids and edge.attrib["target"] in vertex_ids
                            for edge in edges))

    def test_xml_to_pdf_provenance_hashes_and_font_policy(self):
        source = figures.ROOT / figures.FIG3_SOURCE
        output = figures.ROOT / figures.FIG3_OUTPUT
        cells, edges, slots, _ = figures._xml_cells(source)
        source_hash = figures.sha256(source)
        output_hash = figures.sha256(output)
        qa = {
            "native_drawio_cells": len(cells), "native_connectors": len(edges),
            "icon_slots": len(slots), "pdf_raster_images": 0,
            "measured_layout_issues": [], "minimum_pdf_font_pt": 8.1,
            "files": [
                {"submission": str(source), "sha256": source_hash},
                {"submission": str(output), "sha256": output_hash},
            ],
        }
        with tempfile.TemporaryDirectory() as td:
            qa_path = Path(td) / "fig3-qa.json"
            qa_path.write_text(json.dumps(qa), encoding="utf-8")
            with patch.object(figures, "FIG3_QA", qa_path):
                info = figures.verify_fig3_provenance()
        self.assertEqual(info["source_sha256"], source_hash)
        self.assertEqual(info["output_sha256"], output_hash)
        self.assertGreaterEqual(info["minimum_pdf_font_pt"], 8)

    def test_stale_fig3_provenance_is_rejected(self):
        with patch.object(figures, "FIG3_QA", Path(tempfile.gettempdir()) / "missing-fig3-qa.json"):
            with self.assertRaisesRegex(ValueError, "required"):
                figures.verify_fig3_provenance()

    def test_export_requires_explicit_external_step(self):
        with patch("builtins.print") as printer:
            self.assertEqual(figures.main(["--export-fig3"]), 2)
        output = "\n".join(str(call.args[0]) for call in printer.call_args_list)
        self.assertIn("no checked-in exporter exists", output)
        self.assertIn("--verify-only", output)

    def test_all_current_output_hashes_are_present_and_well_formed(self):
        for name, (relative, _) in figures.FIGURES.items():
            path = figures.OUT / relative
            self.assertTrue(path.is_file(), name)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(len(digest), 64)
            self.assertRegex(digest, r"^[0-9a-f]{64}$")

    def test_protected_assets_are_immutable_snapshot(self):
        allowed = figures.FIG1_OUTPUTS | figures.MISSION_OUTPUTS
        before = figures._protected_binary_hashes(allowed)
        after = figures._protected_binary_hashes(allowed)
        self.assertEqual(before, after)
        self.assertIn("drawio/fig3-governed-supervisory-workflow.drawio", before)
        self.assertIn("publication/fig2-architecture.pdf", before)
        self.assertIn("publication/fig3-channel-loop.pdf", before)
        self.assertIn("walkthrough/aw_working-source.png", before)

    def test_walkthrough_policy_allows_raster_panels_but_requires_original_source(self):
        provenance = json.loads(figures.WALKTHROUGH_PROVENANCE.read_text(encoding="utf-8"))
        self.assertEqual(provenance["source"], "aw_working-source.png")
        self.assertTrue(all(panel["source_ui_pixels_modified"] is False
                            for panel in provenance["panels"]))
        self.assertGreaterEqual(provenance["annotation_font_pt_min"], 8)
        self.assertEqual(provenance["output_pdf_sha256"], figures.sha256(figures.OUT / "walkthrough/fig-operational-walkthrough.pdf"))

    def test_old_generator_cannot_generate_retired_fig3(self):
        with self.assertRaisesRegex(ValueError, "Only the mission figure"):
            figures.figure_paths("fig3-channel-loop")


if __name__ == "__main__":
    unittest.main()
