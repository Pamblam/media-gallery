#!/usr/bin/env python3
import os
from pathlib import Path

import cv2
import psycopg2
from dotenv import load_dotenv
from nudenet import NudeDetector

load_dotenv()

# NudeNet classes that count towards the NSFW score; covered/face/feet/etc. are ignored
EXPLICIT_LABELS = {
	"FEMALE_BREAST_EXPOSED",
	"FEMALE_GENITALIA_EXPOSED",
	"MALE_GENITALIA_EXPOSED",
	"BUTTOCKS_EXPOSED",
	"ANUS_EXPOSED",
}

def main() -> int:
	root = Path(os.environ["MEDIABASEPATH"])
	# Only used for the printed yes/no; the raw score is what gets stored
	threshold = float(os.environ.get("NSFW_THRESHOLD", "0.5"))

	conn = psycopg2.connect(
		host=os.environ["PGHOST"],
		port=os.environ["PGPORT"],
		dbname=os.environ["PGDATABASE"],
		user=os.environ["PGUSER"],
		password=os.environ["PGPASSWORD"],
	)
	conn.autocommit = True
	cur = conn.cursor()

	# NudeDetector ignores its providers argument (always CPU), so set them on the session directly
	detector = NudeDetector()
	detector.onnx_session.set_providers(["CUDAExecutionProvider", "CPUExecutionProvider"])

	cur.execute(
		"""
		SELECT id, path
		FROM media
		WHERE type = 'image'
			AND nsfw_checked_at IS NULL
			AND path NOT ILIKE '%.heic'
			AND duplicate_of_id IS NULL
		ORDER BY id
	"""
	)
	rows = cur.fetchall()
	total = len(rows)
	flagged = 0

	for idx, (image_id, rel_path) in enumerate(rows, start=1):
		progress = f"{idx}/{total}"
		full_path = root / rel_path
		img = cv2.imread(str(full_path))

		if img is None:
			print(f"{progress} {rel_path} | unreadable", flush=True)
			cur.execute("UPDATE media SET nsfw_checked_at = now() WHERE id = %s", (image_id,))
			continue

		detections = [d for d in detector.detect(img) if d["class"] in EXPLICIT_LABELS]
		score = max((float(d["score"]) for d in detections), default=0.0)
		labels = sorted({d["class"] for d in detections})

		cur.execute(
			"""
			UPDATE media
			SET nsfw_score = %s, nsfw_labels = %s, nsfw_checked_at = now()
			WHERE id = %s
			""",
			(score, labels, image_id),
		)

		if score >= threshold:
			flagged += 1
			print(f"{progress} {rel_path} | nsfw: yes ({score:.2f}) [{', '.join(labels)}]", flush=True)
		else:
			print(f"{progress} {rel_path} | nsfw: no ({score:.2f})", flush=True)

	print(f"Done: {total} checked, {flagged} at or above {threshold}", flush=True)

	cur.close()
	conn.close()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
