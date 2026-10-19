#!/usr/bin/env python3
import os
import json
from pathlib import Path
from typing import Optional, Tuple

import cv2
import psycopg2
from dotenv import load_dotenv
from insightface.app import FaceAnalysis
from pgvector.psycopg2 import register_vector

load_dotenv()

def to_vec_literal(emb) -> str:
	return "[" + ",".join(f"{float(x):.8f}" for x in emb) + "]"

def best_match(cur, embedding) -> Optional[Tuple[int, float]]:
	threshold = float(os.environ.get("FACE_MATCH_THRESHOLD", "0.35"))
	vec = to_vec_literal(embedding)

	cur.execute(
		"""
		SELECT
			known_face_id,
			(embedding <=> %s::vector) AS dist
		FROM image_faces
		WHERE known_face_id IS NOT NULL
		ORDER BY embedding <=> %s::vector
		LIMIT 1
		""",
		(vec, vec),
	)

	row = cur.fetchone()
	if not row:
		return None

	known_face_id, dist = int(row[0]), float(row[1])
	if dist <= threshold:
		return (known_face_id, dist)
	return None

def main() -> int:
	root = Path(os.environ["MEDIABASEPATH"])

	conn = psycopg2.connect(
		host=os.environ["PGHOST"],
		port=os.environ["PGPORT"],
		dbname=os.environ["PGDATABASE"],
		user=os.environ["PGUSER"],
		password=os.environ["PGPASSWORD"],
	)
	conn.autocommit = True
	register_vector(conn)
	cur = conn.cursor()

	app = FaceAnalysis(providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
	app.prepare(ctx_id=0, det_size=(640, 640))

	cur.execute(
		"""
		SELECT id, path
		FROM media
		WHERE type = 'image'
			AND parsed_at IS NULL
			AND path NOT ILIKE '%.heic'
			AND duplicate_of_id IS NULL
		ORDER BY id
	"""
	)
	rows = cur.fetchall()
	total = len(rows)

	for idx, (image_id, rel_path) in enumerate(rows, start=1):
		progress = f"{idx}/{total}"
		full_path = root / rel_path
		img = cv2.imread(str(full_path))

		if img is None:
			print(f"{progress} {rel_path} | unreadable")
			cur.execute("UPDATE media SET parsed_at = now() WHERE id = %s", (image_id,))
			continue

		faces = app.get(img)

		cur.execute("DELETE FROM image_faces WHERE image_id = %s", (image_id,))

		if not faces:
			print(f"{progress} {rel_path} | face: no")
			cur.execute("UPDATE media SET parsed_at = now() WHERE id = %s", (image_id,))
			continue

		matched_names = []

		for f in faces:
			bbox = f.bbox.astype(int)
			x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
			face_boundary = {
				"x": x1,
				"y": y1,
				"w": max(0, x2 - x1),
				"h": max(0, y2 - y1),
			}

			embedding = f.embedding.astype(float).tolist()
			conf = float(getattr(f, "det_score", 0.0))

			match = best_match(cur, embedding)
			if match:
				known_face_id, _dist = match
				assigned_by = "auto"
				assigned_at = "now()"

				cur.execute(
					"SELECT name FROM known_faces WHERE id = %s",
					(known_face_id,)
				)
				name = cur.fetchone()[0]
				matched_names.append(name)
			else:
				known_face_id = None
				assigned_by = "unassigned"
				assigned_at = "NULL"
				matched_names.append("unknown")

			cur.execute(
				f"""
				INSERT INTO image_faces (
					image_id,
					face_boundary,
					embedding,
					known_face_id,
					detection_confidence,
					assigned_by,
					assigned_at,
					model_name,
					model_version
				)
				VALUES (%s, %s::jsonb, %s, %s, %s, %s, {assigned_at}, %s, %s)
				""",
				(
					image_id,
					json.dumps(face_boundary),
					embedding,
					known_face_id,
					conf,
					assigned_by,
					"insightface",
					"arcface_512",
				),
			)

		names_str = ", ".join(matched_names)
		print(f"{progress} {rel_path} | face: yes ({len(faces)}) [{names_str}]")

		cur.execute("UPDATE media SET parsed_at = now() WHERE id = %s", (image_id,))

	cur.close()
	conn.close()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
