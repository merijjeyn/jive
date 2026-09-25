"""Small, immutable bundles of the current Jive checkout (never Taskground)."""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile


def snapshot(root: Path, cache: Path) -> Path:
    root = root.resolve()
    paths = [root / name for name in ("package.json", "bun.lock", "bin/jive", "bin/jive.ts")]
    paths += sorted((root / "src").rglob("*"))
    files = []
    for path in paths:
        if path.is_symlink():
            raise ValueError(f"Source symlinks are not supported: {path}")
        if path.is_file() and path.suffix in (".ts", ".tsx", ".json", ".lock", ""):
            files.append((path.relative_to(root).as_posix(), path.read_bytes(), path.stat().st_mode & 0o777))
    if not any(name == "src/cli.tsx" for name, _, _ in files):
        raise ValueError(f"Not a Jive checkout: {root}")
    digest = hashlib.sha256()
    for name, data, mode in files:
        digest.update(json.dumps([name, len(data), mode]).encode() + b"\0" + data)
    source_hash = digest.hexdigest()

    def git(*args):
        result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
        return result.stdout.strip() if result.returncode == 0 else None

    manifest = {
        "schema_version": 1, "source_hash": source_hash,
        "revision": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain")),
        "version": json.loads((root / "package.json").read_text())["version"],
        "files": [name for name, _, _ in files],
    }
    # Provenance is part of bundle identity, even when runtime source is unchanged.
    files.append(("source.json", json.dumps(manifest, indent=2).encode(), 0o644))
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=cache, suffix=".tar", delete=False) as tmp:
        temporary = Path(tmp.name)
    try:
        with tarfile.open(temporary, "w") as archive:
            for name, data, mode in files:
                info = tarfile.TarInfo(name)
                info.size, info.mode = len(data), mode
                archive.addfile(info, io.BytesIO(data))
        bundle_hash = hashlib.sha256(temporary.read_bytes()).hexdigest()
        destination = cache / f"{bundle_hash}.tar"
        os.replace(temporary, destination)
        return destination.resolve()
    finally:
        temporary.unlink(missing_ok=True)


def read_manifest(bundle: Path) -> dict:
    if hashlib.sha256(bundle.read_bytes()).hexdigest() != bundle.stem:
        raise ValueError("Source bundle checksum mismatch; create a fresh snapshot")
    with tarfile.open(bundle) as archive:
        for member in archive:
            if not member.isfile() or Path(member.name).is_absolute() or ".." in Path(member.name).parts:
                raise ValueError(f"Invalid bundle member: {member.name}")
        return json.load(archive.extractfile("source.json"))
