#!/usr/bin/env python3
"""Create a consistent SQLite backup, including committed WAL data. Never overwrite.

With --blobs DIR (Huginn's attachments, RAVEN_BLOB_DIR), the files the backed-up
database lists as stored are then copied to DESTINATION.blobs, each checked
against its SHA-256. The database comes first: files are only ever added under
new names, so every file it lists is there to copy, unless garbage collection
removed one since, which is reported and isn't an error.

To restore, point a server at copies: RAVEN_DB_PATH at the backup and
RAVEN_BLOB_DIR at its .blobs folder.
"""
import argparse
import hashlib
import shutil
import sqlite3
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('source', type=Path)
parser.add_argument('destination', type=Path)
parser.add_argument('--blobs', type=Path, metavar='DIR', help="the server's attachments folder")
args = parser.parse_args()
source = args.source.resolve(strict=True)
blob_dest = args.destination.with_name(args.destination.name + '.blobs')
if args.blobs and blob_dest.exists():
    sys.exit(f'{blob_dest} already exists; not overwriting it')
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

if not args.blobs:
    sys.exit(0)
blobs = args.blobs.resolve(strict=True)
with sqlite3.connect(args.destination.resolve().as_uri() + '?mode=ro', uri=True) as db:
    has_table = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blobs'").fetchone()
    stored = db.execute('SELECT owner, id, sha256 FROM blobs WHERE completed IS NOT NULL').fetchall() if has_table else []
copied = gone = 0
bad = []
blob_dest.mkdir()
for owner, blob_id, sha in stored:
    folder = owner.encode().hex()
    path = blobs / folder / blob_id
    if not path.is_file():
        gone += 1
        continue
    target = blob_dest / folder / blob_id
    target.parent.mkdir(exist_ok=True)
    shutil.copyfile(path, target)
    digest = hashlib.sha256()
    with target.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            digest.update(chunk)
    if digest.hexdigest() != sha:
        bad.append(f'{folder}/{blob_id}')
    else:
        copied += 1
print(f'Attachments: {copied} copied and verified to {blob_dest}' + (f', {gone} removed since' if gone else ''))
if bad:
    sys.exit(f"{len(bad)} attachment(s) don't match their recorded hash: {', '.join(bad)}")
