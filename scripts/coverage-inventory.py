#!/usr/bin/env python3
"""Inventory and gate full line/branch/function coverage for this monorepo.

Every non-declaration `.ts` file under `packages/*/src` must be listed in
`TRACKED` together with the test files that exercise it. The gate runs one
`node --test` process per package, so each package's coverage thresholds are
evaluated against that package's own sources only, and fails when a source
file is unlisted, never loaded, or below 100% lines, branches or functions.
Uncovered ranges are reported with their line positions, read from the V8
coverage JSON the same run produced.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
HOOK = ROOT.parent / ".tools" / "common-cov" / "testhook.mjs"

TRACKED: dict[str, list[str]] = {
    "craft-common-base/src/bm25.ts": ["tests/retrieval.test.ts"],
    "craft-common-base/src/capability-protocol.ts": ["tests/capability-protocol.test.ts"],
    "craft-common-base/src/context-assets.ts": ["tests/context.test.ts"],
    "craft-common-base/src/digest.ts": ["tests/digest.test.ts"],
    "craft-common-base/src/embedding-retrieval.ts": ["tests/embedding.test.ts"],
    "craft-common-base/src/index.ts": ["tests/index.test.ts"],
    "craft-common-base/src/keyword-retrieval.ts": ["tests/retrieval.test.ts"],
    "craft-common-base/src/memory-temporal-policy.ts": ["tests/temporal.test.ts"],
    "craft-common-base/src/model-compat.ts": ["tests/model-compat.test.ts"],
    "craft-common-base/src/retrieval-contract.ts": ["tests/retrieval.test.ts"],
    "craft-common-base/src/retrieval-excerpt.ts": ["tests/excerpt.test.ts"],
    "craft-common-base/src/retrieval-port.ts": ["tests/retrieval.test.ts"],
    "craft-common-base/src/retrieval-terms.ts": ["tests/retrieval.test.ts"],
    "craft-common-base/src/scope-policy.ts": ["tests/scope-policy.test.ts"],
    "craft-common-base/src/validation.ts": ["tests/validation.test.ts"],
    "craft-common-base/src/workflow.ts": ["tests/workflow.test.ts"],
    "craft-common-log/src/cost-ledger.ts": ["tests/cost-ledger.test.ts"],
    "craft-common-log/src/evaluation-contract.ts": ["tests/evaluation-contract.test.ts"],
    "craft-common-log/src/index.ts": ["tests/index.test.ts"],
    "craft-common-log/src/journal-sink.ts": ["tests/journal-sink.test.ts"],
    "craft-common-log/src/operation.ts": ["tests/operation.test.ts"],
    "craft-common-log/src/otlp.ts": ["tests/otlp.test.ts"],
    "craft-common-log/src/store-sink.ts": ["tests/store-sink.test.ts"],
    "craft-common-log/src/telemetry.ts": ["tests/telemetry.test.ts"],
    "craft-common-ontology/src/concepts.ts": ["tests/validation.test.ts"],
    "craft-common-ontology/src/index.ts": ["tests/index.test.ts"],
    "craft-common-ontology/src/value-gate.ts": ["tests/value-gate.test.ts"],
    "craft-common-ontology/src/validation.ts": ["tests/validation.test.ts"],
    "craft-common-store-local/src/codebase-shards.ts": ["tests/codebase-shards.test.ts"],
    "craft-common-store-local/src/content-store.ts": ["tests/content-store.test.ts"],
    "craft-common-store-local/src/context-access-guard.ts": ["tests/context-access-guard.test.ts"],
    "craft-common-store-local/src/index.ts": ["tests/index.test.ts"],
    "craft-common-store-local/src/paths.ts": ["tests/paths.test.ts"],
    "craft-common-store-local/src/sqlite-busy-timeout.ts": ["tests/sqlite-busy-timeout.test.ts"],
    "craft-common-store-local/src/store-migrations.ts": ["tests/store-migrations.test.ts"],
    "craft-common-store-local/src/store-schema.ts": ["tests/index.test.ts"],
    "craft-common-store-local/src/store.ts": ["tests/store.test.ts"],
    "craft-common-store-local/src/trace-shards.ts": ["tests/trace-shards.test.ts"],
}

PACKAGES = ["craft-common-base", "craft-common-log", "craft-common-ontology", "craft-common-store-local"]


def source_files(package: str) -> list[str]:
    files = []
    for source in sorted((ROOT / "packages" / package / "src").glob("**/*.ts")):
        if source.name.endswith(".d.ts"):
            continue
        files.append(f"{package}/{source.relative_to(ROOT / 'packages' / package).as_posix()}")
    return files


def package_of(path: str) -> str:
    return path.split("/")[0]


def build_command(include: list[Path], tests: list[Path]) -> list[str]:
    command = [
        "node",
        "--experimental-strip-types",
        "--experimental-test-coverage",
        "--test-isolation=none",
        "--test",
        "--test-coverage-lines=100",
        "--test-coverage-functions=100",
        "--test-coverage-branches=100",
    ]
    command.extend(f"--test-coverage-include={path}" for path in include)
    command.extend(str(path) for path in tests)
    return command


def uncovered_ranges(entry: dict[str, object]) -> list[tuple[int, int]]:
    uncovered: list[tuple[int, int]] = []
    for function in entry["ranges"]:  # type: ignore[union-attr]
        for function_range in function.get("ranges", []):
            if function_range.get("count", 0) == 0:
                uncovered.append((function_range["startOffset"], function_range["endOffset"]))
    return uncovered


def coverage_report(coverage_dir: Path) -> dict[str, dict[str, object]]:
    files: dict[str, dict[str, object]] = {}
    for name in sorted(coverage_dir.glob("*.json")):
        payload = json.loads(name.read_text(encoding="utf-8"))
        for script in payload.get("result", []):
            url = script.get("url", "")
            if not url.startswith("file:") or "/src/" not in url:
                continue
            path = url[len("file://"):]
            entry = files.setdefault(path, {"ranges": []})
            entry["ranges"].extend(script.get("functions", []))  # type: ignore[union-attr]
    return files


def line_of(source: str, offset: int) -> int:
    return source.count("\n", 0, offset) + 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--coverage-dir", help="keep the V8 coverage JSON in this directory")
    args = parser.parse_args()

    failures: list[str] = []
    for package in PACKAGES:
        files = source_files(package)
        listed = [path for path in TRACKED if package_of(path) == package]
        for path in files:
            if path not in TRACKED:
                failures.append(f"UNLISTED {path}")
        for path in listed:
            if path not in files:
                failures.append(f"STALE INVENTORY {path}")
    for path, tests in TRACKED.items():
        package = package_of(path)
        for test in tests:
            if not (ROOT / "packages" / package / test).exists():
                failures.append(f"MISSING TEST {test} for {path}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 2

    exit_code = 0
    for package in PACKAGES:
        sources = sorted((ROOT / "packages" / path) for path in TRACKED if package_of(path) == package)
        tests = sorted({(ROOT / "packages" / package / test) for path in TRACKED if package_of(path) == package for test in TRACKED[path]})
        coverage_dir = (Path(args.coverage_dir).resolve() / package) if args.coverage_dir else Path(tempfile.mkdtemp(prefix=f"coverage-{package}-"))
        coverage_dir.mkdir(parents=True, exist_ok=True)
        command = build_command(sources, tests)
        env = dict(os.environ)
        env["NODE_V8_COVERAGE"] = str(coverage_dir)
        env["NODE_OPTIONS"] = f"--import=file:///{HOOK.as_posix()}"
        print(f"\n=== {package}: {len(sources)} sources, {len(tests)} test files ===", flush=True)
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
        print((result.stdout or "") + (result.stderr or ""))
        if result.returncode != 0:
            exit_code = 1
        for path, entry in coverage_report(coverage_dir).items():
            source = Path(path)
            if not source.exists():
                continue
            text = source.read_text(encoding="utf-8", errors="replace")
            missing = sorted({(line_of(text, start), line_of(text, end)) for start, end in uncovered_ranges(entry)})
            if missing:
                exit_code = 1
                listed = ", ".join(str(start) if start == end else f"{start}-{end}" for start, end in missing)
                print(f"UNCOVERED {path}: {listed}", file=sys.stderr)
        if not args.coverage_dir:
            shutil.rmtree(coverage_dir, ignore_errors=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
