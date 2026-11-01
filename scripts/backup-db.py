#!/usr/bin/env python3
"""Create a consistent SQLite backup, including committed WAL data. Never overwrite."""
import argparse
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
source = args.source.resolve(strict=True)
# Exclusive creation prevents accidental replacement of an existing database.
with args.destination.open('xb'):
    pass
try:
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
        with sqlite3.connect(args.destination) as dest:
            src.backup(dest)
            if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup integrity check failed')
except Exception:
    args.destination.unlink(missing_ok=True)
    raise
print(f'Backup verified: {args.destination}')
