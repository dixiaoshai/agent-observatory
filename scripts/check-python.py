#!/usr/bin/env python3
"""Run the Python module's full suite from its own root, without cache writes."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
                        cwd=root / "packages/agent-stats", env=env)
sys.exit(result.returncode)
