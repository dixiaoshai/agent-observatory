#!/usr/bin/env python3
"""Verify original inputs; explicitly local-only, not required in a fresh clone."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source-root", type=Path, default=root.parent)
args = parser.parse_args()
baseline = json.loads((root / "docs/migration-baseline.json").read_text())
errors = []
count = 0
for name, module in baseline["modules"].items():
    source = args.source_root.resolve() / name
    if not source.is_dir():
        errors.append("Missing original module: " + name)
        continue
    for relative, digest in module["files"].items():
        path = source / relative
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            errors.append(name + "/" + relative)
        count += 1
    current = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if current != module["commit"]:
        errors.append(name + ": HEAD changed")
    status = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=all"], text=True)
    if status.strip():
        errors.append(name + ": working tree is no longer clean: " + status.strip())
# Historical handoff documents were added after the module migration baseline.
# Check both source and archived bytes against their immutable snapshot hashes.
history_manifest = root / "docs/history/2026-11-15/manifest.json"
history_count = 0
if history_manifest.is_file():
    history = json.loads(history_manifest.read_text())
    for document in history["documents"]:
        original = args.source_root.resolve() / Path(document["source"]).relative_to("..")
        archived = root / document["archive"]
        # Published archive hashes may differ from source when a personal path was
        # redacted; manifest then records the pre-redaction source hash separately.
        for label, path, digest, size in (
                ("original", original,
                 document.get("source_sha256", document["sha256"]),
                 document.get("source_bytes", document["bytes"])),
                ("archive", archived, document["sha256"], document["bytes"])):
            if (not path.is_file()
                    or path.stat().st_size != size
                    or hashlib.sha256(path.read_bytes()).hexdigest() != digest):
                errors.append(label + ": " + document["archive"])
        history_count += 1
print(json.dumps({"passed": not errors, "verified_files": count,
                  "verified_history_documents": history_count,
                  "errors": errors}, ensure_ascii=False, indent=2))
sys.exit(bool(errors))
