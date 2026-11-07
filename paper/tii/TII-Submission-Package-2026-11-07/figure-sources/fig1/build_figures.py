"""Backward-compatible entry point for rebuilding the current Figure 1."""
from pathlib import Path
import runpy

HERE = Path(__file__).resolve().parent
runpy.run_path(str(HERE / "generate_fig1_gptimage26.py"), run_name="__main__")
