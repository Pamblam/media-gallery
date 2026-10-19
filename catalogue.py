#!/usr/bin/env python3
import os
import json
import argparse
import hashlib
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Optional, Tuple

import psycopg2
from dotenv import load_dotenv

load_dotenv()

DATE_KEYS = (
	"SubSecDateTimeOriginal",
	"DateTimeOriginal",
	"CreateDate",
	"ModifyDate",
	"DateCreated",
	"MediaCreateDate",
	"TrackCreateDate",
	"FileModifyDate",
)

GPS_KEYS = (
	("GPSLatitude", "GPSLongitude"),
)

def file_hash(path: Path) -> str:
	h = hashlib.sha256()
	with path.open("rb") as f:
		for chunk in iter(lambda: f.read(1024 * 1024), b""):
			h.update(chunk)
	return h.hexdigest()


def parse_media_type(path: Path) -> Optional[str]:
	ext = path.suffix.lower()
	if ext in {".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".webp"}:
		return "image"
	if ext in {".mov", ".mp4", ".m4v", ".avi", ".mkv"}:
		return "video"
	return None


def exiftool_json(path: Path) -> Optional[dict]:
	r = subprocess.run(
		["exiftool", "-j", "-n", str(path)],
		capture_output=True,
		text=True,
	)
	if r.returncode != 0 or not r.stdout.strip():
		return None
	try:
		arr = json.loads(r.stdout)
	except Exception:
		return None
	if not arr or not isinstance(arr, list) or not isinstance(arr[0], dict):
		return None
	return arr[0]


def parse_exiftool_datetime(value: object) -> Optional[datetime]:
	if value is None:
		return None
	if not isinstance(value, str):
		return None

	s = value.strip()
	if not s:
		return None

	# ExifTool common: "YYYY:MM:DD HH:MM:SS" optionally with offset
	# Convert to ISO-ish: "YYYY-MM-DDTHH:MM:SS"
	if len(s) >= 10 and s[4] == ":" and s[7] == ":":
		s = s[:4] + "-" + s[5:7] + "-" + s[8:]
	if " " in s and "T" not in s:
		s = s.replace(" ", "T", 1)

	# Drop trailing "Z" to keep fromisoformat happy pre-3.11
	if s.endswith("Z"):
		s = s[:-1]

	# Trim sub-second if weird formatting breaks parsing
	try:
		return datetime.fromisoformat(s)
	except Exception:
		pass

	if "." in s:
		try:
			return datetime.fromisoformat(s.split(".", 1)[0])
		except Exception:
			return None

	return None


def pick_original_date(meta: dict) -> Optional[datetime]:
	for k in DATE_KEYS:
		if k in meta:
			dt = parse_exiftool_datetime(meta.get(k))
			if dt is not None:
				return dt
	return None


def pick_gps(meta: dict) -> Optional[Tuple[float, float]]:
	# Prefer explicit lat/lon pairs
	for lat_k, lon_k in GPS_KEYS:
		if lat_k in meta and lon_k in meta:
			try:
				lat = float(meta[lat_k])
				lon = float(meta[lon_k])
				return (lat, lon)
			except Exception:
				pass

	# Composite:GPSPosition sometimes like "lat lon"
	pos = meta.get("Composite:GPSPosition")
	if isinstance(pos, str):
		parts = pos.replace(",", " ").split()
		if len(parts) >= 2:
			try:
				lat = float(parts[0])
				lon = float(parts[1])
				return (lat, lon)
			except Exception:
				pass

	# QuickTime:GPSCoordinates sometimes like "lat lon alt"
	qgps = meta.get("QuickTime:GPSCoordinates")
	if isinstance(qgps, str):
		parts = qgps.replace(",", " ").split()
		if len(parts) >= 2:
			try:
				lat = float(parts[0])
				lon = float(parts[1])
				return (lat, lon)
			except Exception:
				pass

	return None


def parse_args() -> argparse.Namespace:
	ap = argparse.ArgumentParser(description="Catalogue images and videos under MEDIABASEPATH.")
	ap.add_argument(
		"--skip-existing",
		action="store_true",
		help="skip files whose path is already in the media table, before running exiftool or hashing",
	)
	ap.add_argument(
		"-v", "--verbose",
		action="store_true",
		help="also print a line for every file that was already catalogued",
	)
	return ap.parse_args()


def main() -> int:
	args = parse_args()
	root = Path(os.environ["MEDIABASEPATH"])

	conn = psycopg2.connect(
		host=os.environ["PGHOST"],
		port=os.environ["PGPORT"],
		dbname=os.environ["PGDATABASE"],
		user=os.environ["PGUSER"],
		password=os.environ["PGPASSWORD"],
	)
	conn.autocommit = True
	cur = conn.cursor()

	# Paths are stored relative to root, so the same filename in two folders is not a match
	existing = set()
	if args.skip_existing:
		cur.execute("SELECT path FROM media")
		existing = {row[0] for row in cur.fetchall()}
		print(f"Loaded {len(existing)} catalogued paths; those files will be skipped", flush=True)

	inserted = skipped = 0
	for dirpath, _, filenames in os.walk(root):
		dir_inserted = dir_skipped = 0
		for name in filenames:
			if name.startswith("."):
				continue
			p = Path(dirpath) / name
			rel = str(p.relative_to(root))

			media_type = parse_media_type(p)
			if not media_type:
				continue

			if rel in existing:
				dir_skipped += 1
				if args.verbose:
					print("  exists:", rel, flush=True)
				continue

			meta = exiftool_json(p) or {}
			original_date = pick_original_date(meta)
			gps = pick_gps(meta)

			stat = p.stat()
			h = file_hash(p)

			if gps is None:
				cur.execute(
					"""
					INSERT INTO media (
						path, type, hash, size_bytes, mtime, original_date
					)
					VALUES (%s, %s, %s, %s, %s, %s)
					ON CONFLICT (path) DO NOTHING
					""",
					(
						rel,
						media_type,
						h,
						stat.st_size,
						datetime.fromtimestamp(stat.st_mtime),
						original_date,
					),
				)
			else:
				lat, lon = gps
				cur.execute(
					"""
					INSERT INTO media (
						path, type, hash, gps_location, size_bytes, mtime, original_date
					)
					VALUES (%s, %s, %s, point(%s, %s), %s, %s, %s)
					ON CONFLICT (path) DO NOTHING
					""",
					(
						rel,
						media_type,
						h,
						lon,	# x = lon
						lat,	# y = lat
						stat.st_size,
						datetime.fromtimestamp(stat.st_mtime),
						original_date,
					),
				)

			# rowcount is 0 when ON CONFLICT skipped the row
			if cur.rowcount == 1:
				dir_inserted += 1
				print(f"{inserted + dir_inserted} INSERTED: {rel}", flush=True)
			else:
				dir_skipped += 1
				if args.verbose:
					print("  exists:", rel, flush=True)

		if dir_inserted or dir_skipped:
			print(
				f"-- {Path(dirpath).relative_to(root)}: {dir_inserted} inserted, {dir_skipped} already catalogued",
				flush=True,
			)
		inserted += dir_inserted
		skipped += dir_skipped

	print(f"Done: {inserted} inserted, {skipped} already catalogued", flush=True)

	cur.close()
	conn.close()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
