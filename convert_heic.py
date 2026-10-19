#!/usr/bin/env python3
import hashlib
import os
import subprocess
from datetime import datetime
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

load_dotenv()

def file_hash(path: Path) -> str:
	h = hashlib.sha256()
	with path.open("rb") as f:
		for chunk in iter(lambda: f.read(1024 * 1024), b""):
			h.update(chunk)
	return h.hexdigest()


def main() -> int:
	root = Path(os.environ["MEDIABASEPATH"])

	conn = psycopg2.connect(
		host=os.environ["PGHOST"],
		port=os.environ["PGPORT"],
		dbname=os.environ["PGDATABASE"],
		user=os.environ["PGUSER"],
		password=os.environ["PGPASSWORD"],
	)
	conn.autocommit = False
	cur = conn.cursor()

	cur.execute(
		"""
		SELECT id, path
		FROM media
		WHERE type = 'image'
			AND lower(path) LIKE '%.heic'
			AND converted_to_id IS NULL
		"""
	)
	rows = cur.fetchall()
	total = len(rows)

	for idx, (media_id, rel_path) in enumerate(rows, start=1):
		source_path = root / rel_path
		dest_rel = Path("_converted") / Path(rel_path).with_suffix(".jpg")
		dest_path = root / dest_rel
		dest_path.parent.mkdir(parents=True, exist_ok=True)

		result = subprocess.run(
			["heif-convert", str(source_path), str(dest_path)],
			stdout=subprocess.DEVNULL,
			stderr=subprocess.DEVNULL,
		)

		progress = f"{idx}/{total}"
		if result.returncode != 0:
			print(progress, rel_path, "FAILED")
			continue

		try:
			stat = dest_path.stat()
		except FileNotFoundError:
			print(progress, rel_path, "FAILED", "missing output file after conversion")
			continue
		h = file_hash(dest_path)

		try:
			cur.execute(
				"""
				INSERT INTO media (
					path, type, hash, gps_location, size_bytes, mtime, original_date
				)
				SELECT %s, %s, %s, gps_location, %s, %s, original_date
				FROM media
				WHERE id = %s
				RETURNING id
				""",
				(
					str(dest_rel),
					"image",
					h,
					stat.st_size,
					datetime.fromtimestamp(stat.st_mtime),
					media_id,
				),
			)
			new_id = cur.fetchone()[0]

			cur.execute(
				"UPDATE media SET converted_to_id = %s WHERE id = %s",
				(new_id, media_id),
			)

			conn.commit()
			print(progress, rel_path, "OK")
		except Exception:
			conn.rollback()
			print(progress, rel_path, "FAILED")

	cur.close()
	conn.close()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
