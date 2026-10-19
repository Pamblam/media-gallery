// server.js v3
const path = require("path")
const fs = require("fs/promises")
const { randomUUID } = require("crypto")
const sharp = require("sharp")
const express = require("express")
const { Pool } = require("pg")
require("dotenv").config()

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const pool = new Pool({
	host: process.env.PGHOST,
	port: Number(process.env.PGPORT || 5432),
	database: process.env.PGDATABASE,
	user: process.env.PGUSER,
	password: process.env.PGPASSWORD
})

const DEFAULT_MODE = "all-unseen"
const VALID_MODES = new Set(["all-unseen", "all-unlabeled"])
const normalizeMode = (rawMode) => (VALID_MODES.has(rawMode) ? rawMode : DEFAULT_MODE)

app.set("view engine", "ejs")
app.set("views", path.join(__dirname, "views"))
app.use(express.static(path.join(__dirname, "public")))
app.use("/vendor/leaflet", express.static(path.join(__dirname, "node_modules", "leaflet", "dist")))
app.use("/vendor/markercluster", express.static(path.join(__dirname, "node_modules", "leaflet.markercluster", "dist")))

const MEDIA_BASE = process.env.MEDIABASEPATH
if (!MEDIA_BASE) throw new Error("MEDIABASEPATH is required")
const DATASETS_BASE = process.env.DATASETS_BASE || path.join(__dirname, "..", "datasets")
const THUMBS_BASE = process.env.THUMBS_BASE || path.join(__dirname, "..", ".thumbs")
const THUMB_WIDTHS = new Set([300, 600])

app.get(/^\/media\/(.+)$/, (req, res) =>{
	const rel = decodeURIComponent(req.params[0])
	const full = path.join(MEDIA_BASE, rel)
	res.sendFile(full)
})

app.post("/skip", async (req, res) =>{
	const face_id = Number(req.body.face_id)
	if (!face_id){
		res.status(400).send("face_id required")
		return
	}
	const mode = normalizeMode(req.body.mode)

	await pool.query(
		`
		UPDATE image_faces
		SET assigned_by = 'skipped',
			assigned_at = now(),
			known_face_id = null
		WHERE id = $1
		`,
		[face_id]
	)

	res.redirect(`/faceid?mode=${mode}`)
})

app.post("/skip-image", async (req, res) =>{
	const face_id = Number(req.body.face_id)
	if (!face_id){
		res.status(400).send("face_id required")
		return
	}
	const mode = normalizeMode(req.body.mode)

	try {
		const imageResult = await pool.query(
			`
			SELECT image_id
			FROM image_faces
			WHERE id = $1
			`,
			[face_id]
		)

		if (imageResult.rowCount === 0){
			res.status(404).send("face not found")
			return
		}

		const image_id = imageResult.rows[0].image_id
		await pool.query(
			`
			UPDATE image_faces
			SET assigned_by = 'skipped',
				assigned_at = now()
			WHERE image_id = $1
			`,
			[image_id]
		)

		res.redirect(`/faceid?mode=${mode}`)
	} catch (err){
		console.error(err)
		res.status(500).send("Server Error")
	}
})

app.get("/faceid", async (req, res) => {
    // 1. Check if a specific face_id was requested via URL: /?id=123
    const requestedFaceId = req.query.id ? Number(req.query.id) : null;
    const requestedModeRaw = typeof req.query.mode === "string" ? req.query.mode : "";
    const mode = normalizeMode(requestedModeRaw);

    if (requestedFaceId && (!requestedModeRaw || requestedModeRaw !== mode)) {
        return res.redirect(`/faceid?id=${requestedFaceId}&mode=${mode}`);
    }

    let faceQ;
    let params = [];

    if (requestedFaceId) {
        // Fetch the specific face requested
        faceQ = `
            SELECT f.id AS face_id, f.image_id, m.path AS media_path, f.face_boundary AS bbox, 
                   f.known_face_id, f.assigned_by, k.name AS known_name
            FROM image_faces f
            JOIN media m ON m.id = f.image_id
            LEFT JOIN known_faces k ON k.id = f.known_face_id
            WHERE f.id = $1
            LIMIT 1
        `;
        params = [requestedFaceId];
    } else {
        // Fallback: Fetch the first unlabeled/auto face as before
        const modeWhereClause = mode === "all-unlabeled"
            ? `
                WHERE m.type = 'image'
                    AND m.path NOT ILIKE '%.heic'
                    AND f.known_face_id IS NULL
                    AND (f.assigned_by IS NULL OR f.assigned_by != 'skipped')
                    AND m.duplicate_of_id IS NULL
            `
            : `
                WHERE m.type = 'image'
                    AND m.path NOT ILIKE '%.heic'
                    AND (f.known_face_id IS NULL OR f.assigned_by = 'auto')
                    AND (f.assigned_by IS NULL OR f.assigned_by != 'skipped')
                    AND m.duplicate_of_id IS NULL
            `;

        faceQ = `
            SELECT f.id AS face_id, f.image_id, m.path AS media_path, f.face_boundary AS bbox, 
                   f.known_face_id, f.assigned_by, k.name AS known_name
            FROM image_faces f
            JOIN media m ON m.id = f.image_id
            LEFT JOIN known_faces k ON k.id = f.known_face_id
            ${modeWhereClause}
            ORDER BY f.id
            LIMIT 1
        `; 
    }

    const knownQ = `SELECT id, name FROM known_faces ORDER BY name`;
    const countQ = `
        SELECT COUNT(DISTINCT m.id)::int AS count
        FROM image_faces f
        JOIN media m ON m.id = f.image_id
        ${
            mode === "all-unlabeled"
                ? `
                    WHERE m.type = 'image'
                        AND m.path NOT ILIKE '%.heic'
                        AND f.known_face_id IS NULL
                        AND (f.assigned_by IS NULL OR f.assigned_by != 'skipped')
                        AND m.duplicate_of_id IS NULL
                `
                : `
                    WHERE m.type = 'image'
                        AND m.path NOT ILIKE '%.heic'
                        AND (f.known_face_id IS NULL OR f.assigned_by = 'auto')
                        AND (f.assigned_by IS NULL OR f.assigned_by != 'skipped')
                        AND m.duplicate_of_id IS NULL
                `
        }
    `;

    try {
        const [faceR, knownR, countR] = await Promise.all([ 
            pool.query(faceQ, params),
            pool.query(knownQ),
            pool.query(countQ)
        ]);

        if (faceR.rowCount === 0) {
            return res.status(200).render("no_faces", {
                known_faces: knownR.rows
            });
        }

        const row = faceR.rows[0];

        // 2. If the user visited "/" without an ID, redirect them to "/?id=XXX"
        // This ensures the URL updates and the "Back" button works.
        if (!requestedFaceId) {
            return res.redirect(`/faceid?id=${row.face_id}&mode=${mode}`);
        }

        const faceCountR = await pool.query(
            `
            SELECT COUNT(*)::int AS count
            FROM image_faces
            WHERE image_id = $1
            `,
            [row.image_id]
        );

        const facesInImageR = await pool.query(
            `
            SELECT f.id AS face_id, f.face_boundary AS bbox, k.name AS known_name
            FROM image_faces f
            LEFT JOIN known_faces k ON k.id = f.known_face_id
            WHERE f.image_id = $1
            ORDER BY f.id
            `,
            [row.image_id]
        );

        res.render("index", {
            face_id: row.face_id,
            media_path: row.media_path,
            bbox: row.bbox,
            known_faces: knownR.rows,
            auto_assigned: row.assigned_by === "auto" && row.known_face_id != null,
            auto_name: row.known_name || null,
            current_name: row.known_name || "",
            selected_known_face_id: row.known_face_id || "",
            face_count: faceCountR.rows[0]?.count || 0,
            faces_in_image: facesInImageR.rows,
            mode,
            matching_media_count: countR.rows[0]?.count || 0
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error");
    }
});

app.get("/all", async (req, res) => {
    res.redirect("/");
});

app.get("/", async (req, res) => {
    try {
        // Fetch the names so the dropdown filter actually has data to show
        const knownQ = `SELECT id, name FROM known_faces ORDER BY name`;
        const knownR = await pool.query(knownQ);

        res.render("gallery", {
            known_faces: knownR.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading gallery");
    }
});

app.get("/api/all", async (req, res) => {
    const limit = 24;
    const page = req.query.page ? Number(req.query.page) : 0;
    const offset = page * limit;
    const filter = req.query.filter || 'all';
    const nameFilter = req.query.name || '';

    let params = [limit, offset];
    
    // Build filter conditions
    let filterClause = "";
    if (filter === 'unseen') {
        filterClause = `
            AND m.type = 'image'
            AND (f.known_face_id IS NULL OR f.assigned_by = 'auto')
            AND (f.assigned_by IS NULL OR f.assigned_by != 'skipped')
        `;
    } else if (filter === 'unseen_unlabeled') {
        filterClause = `
            AND m.type = 'image'
            AND NOT EXISTS (
                SELECT 1 FROM image_faces f_known
                WHERE f_known.image_id = m.id
                    AND f_known.known_face_id IS NOT NULL
            )
            AND EXISTS (
                SELECT 1 FROM image_faces f_unseen
                WHERE f_unseen.image_id = m.id
                    AND (f_unseen.assigned_by IS NULL OR f_unseen.assigned_by != 'skipped')
            )
        `;
    } else if (filter === 'skipped') {
        filterClause = "AND f.assigned_by = 'skipped'";
    } else if (filter === 'auto_labeled') {
        filterClause = "AND f.assigned_by = 'auto' AND f.known_face_id IS NOT NULL";
    } else if (filter === 'manually_labeled') {
        filterClause = "AND f.assigned_by = 'manual' AND f.known_face_id IS NOT NULL";
    }

    let nameJoin = "";
    if (nameFilter) {
        params.push(nameFilter);
        nameJoin = `JOIN image_faces f2 ON f2.image_id = m.id 
                    JOIN known_faces kn2 ON f2.known_face_id = kn2.id 
                    AND kn2.name = $${params.length}`;
    }

    // Use unique media paths so each image file is only shown once.
    const query = `
        WITH filtered_images AS (
            SELECT m.id, m.path
            FROM media m
            JOIN image_faces f ON f.image_id = m.id
            ${nameJoin}
            WHERE m.path NOT ILIKE '%.heic'
			AND m.duplicate_of_id IS NULL
            ${filterClause}
        ),
        unique_images AS (
            SELECT DISTINCT ON (path) id, path
            FROM filtered_images
            ORDER BY path, id DESC
        ),
        paged_images AS (
            SELECT id, path
            FROM unique_images
            ORDER BY id DESC
            LIMIT $1 OFFSET $2
        )
        SELECT 
            pi.id AS image_id,
            pi.path AS media_path,
            (SELECT f3.id FROM image_faces f3 WHERE f3.image_id = pi.id LIMIT 1) AS first_face_id,
            ARRAY(
                SELECT DISTINCT kn.name 
                FROM image_faces jf
                JOIN known_faces kn ON jf.known_face_id = kn.id
                WHERE jf.image_id = pi.id
            ) AS labels,
            COALESCE((
                SELECT json_agg(face_item)
                FROM (
                    SELECT DISTINCT jf2.id AS face_id, kn2.name AS name
                    FROM image_faces jf2
                    JOIN known_faces kn2 ON jf2.known_face_id = kn2.id
                    WHERE jf2.image_id = pi.id
                ) face_item
            ), '[]'::json) AS face_labels
        FROM paged_images pi
        ORDER BY pi.id DESC;
    `;

    try {
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

app.get("/knownfaces", async (req, res) => {
    try {
        const knownQ = `SELECT id, name FROM known_faces ORDER BY name`;
        const knownR = await pool.query(knownQ);
        const countsR = await pool.query(
            `
            SELECT k.id, k.name, COUNT(f.id)::int AS count
            FROM known_faces k
            LEFT JOIN image_faces f ON f.known_face_id = k.id
            GROUP BY k.id, k.name
            ORDER BY count DESC, k.name
            `
        );

        res.render("known_faces", {
            known_faces: knownR.rows,
            rows: countsR.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading known faces");
    }
});

app.post("/knownfaces/:id/delete", async (req, res) => {
    const knownFaceId = Number(req.params.id);
    if (!knownFaceId) {
        res.status(400).send("known_face id required");
        return;
    }

    try {
        const countR = await pool.query(
            `
            SELECT COUNT(*)::int AS count
            FROM image_faces
            WHERE known_face_id = $1
            `,
            [knownFaceId]
        );

        if ((countR.rows[0]?.count || 0) > 0) {
            res.status(400).send("Cannot delete known face with existing matches");
            return;
        }

        await pool.query(
            `
            DELETE FROM known_faces
            WHERE id = $1
            `,
            [knownFaceId]
        );

        res.redirect("/knownfaces");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error deleting known face");
    }
});

app.get("/datasets", async (req, res) => {
    try {
        const knownQ = `SELECT id, name FROM known_faces ORDER BY name`;
        const knownR = await pool.query(knownQ);
        const datasetsR = await pool.query(
            `
            SELECT d.id,
                   d.name,
                   k.name AS known_name,
                   COUNT(di.id)::int AS image_count
            FROM datasets d
            LEFT JOIN known_faces k ON k.id = d.known_face_id
            LEFT JOIN dataset_images di ON di.dataset_id = d.id
            GROUP BY d.id, d.name, k.name
            ORDER BY d.id DESC
            `
        );

        res.render("datasets", {
            known_faces: knownR.rows,
            rows: datasetsR.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading datasets");
    }
});

app.post("/datasets/:id/delete", async (req, res) => {
    const datasetId = Number(req.params.id);
    if (!datasetId) {
        res.status(400).send("dataset id required");
        return;
    }

    try {
        const countR = await pool.query(
            `
            SELECT COUNT(*)::int AS count
            FROM dataset_images
            WHERE dataset_id = $1
            `,
            [datasetId]
        );

        if ((countR.rows[0]?.count || 0) > 0) {
            res.status(400).send("Cannot delete dataset with images");
            return;
        }

        await pool.query(
            `
            DELETE FROM datasets
            WHERE id = $1
            `,
            [datasetId]
        );

        res.redirect("/datasets");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error deleting dataset");
    }
});

app.get("/datasets/:id", async (req, res) => {
    const datasetId = Number(req.params.id);
    if (!datasetId) {
        res.status(400).send("dataset id required");
        return;
    }

    try {
        const knownQ = `SELECT id, name FROM known_faces ORDER BY name`;
        const knownR = await pool.query(knownQ);
        const datasetR = await pool.query(
            `
            SELECT d.id, d.name, k.name AS known_name
            FROM datasets d
            LEFT JOIN known_faces k ON k.id = d.known_face_id
            WHERE d.id = $1
            `,
            [datasetId]
        );

        if (datasetR.rowCount === 0) {
            res.status(404).send("Dataset not found");
            return;
        }

        res.render("dataset_gallery", {
            known_faces: knownR.rows,
            dataset: datasetR.rows[0]
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading dataset");
    }
});

app.get("/api/datasets/:id", async (req, res) => {
    const datasetId = Number(req.params.id);
    if (!datasetId) {
        res.status(400).json({ error: "dataset id required" });
        return;
    }

    const limit = 24;
    const page = req.query.page ? Number(req.query.page) : 0;
    const offset = page * limit;

    try {
        const datasetDir = path.join(DATASETS_BASE, String(datasetId))
        let entries = []
        try {
            entries = await fs.readdir(datasetDir, { withFileTypes: true })
        } catch (err) {
            if (err.code !== "ENOENT") {
                throw err
            }
        }

        const files = entries
            .filter(entry => entry.isFile())
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b))

        const slice = files.slice(offset, offset + limit)
        res.json(slice.map(name => ({ filename: name })))
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

app.post("/datasets/:id/delete-file", async (req, res) => {
    const datasetId = Number(req.params.id);
    const filename = String(req.body.filename || "");
    if (!datasetId || !filename) {
        res.status(400).json({ error: "dataset id and filename required" });
        return;
    }

    const safeName = path.basename(filename);
    const datasetDir = path.join(DATASETS_BASE, String(datasetId));
    const fullPath = path.join(datasetDir, safeName);
    const normalized = path.normalize(fullPath);
    const root = path.normalize(datasetDir) + path.sep;

    if (!normalized.startsWith(root)) {
        res.status(400).json({ error: "Invalid file path" });
        return;
    }

    try {
        const datasetR = await pool.query(
            `
            SELECT id, known_face_id
            FROM datasets
            WHERE id = $1
            `,
            [datasetId]
        );
        if (datasetR.rowCount === 0) {
            res.status(404).json({ error: "Dataset not found" });
            return;
        }

        const faceId = Number(path.parse(safeName).name);
        let imageId = null;
        if (faceId) {
            const faceR = await pool.query(
                `
                SELECT image_id
                FROM image_faces
                WHERE id = $1
                  AND known_face_id = $2
                `,
                [faceId, datasetR.rows[0].known_face_id]
            );
            if (faceR.rowCount > 0) {
                imageId = faceR.rows[0].image_id;
            }
        }

        await fs.unlink(normalized);

        if (imageId) {
            const facesR = await pool.query(
                `
                SELECT id
                FROM image_faces
                WHERE image_id = $1
                  AND known_face_id = $2
                `,
                [imageId, datasetR.rows[0].known_face_id]
            );
            const remaining = new Set(
                facesR.rows.map(row => String(row.id))
            );
            let stillExists = false;
            const entries = await fs.readdir(datasetDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                const name = path.parse(entry.name).name;
                if (remaining.has(String(name))) {
                    stillExists = true;
                    break;
                }
            }

            if (!stillExists) {
                await pool.query(
                    `
                    DELETE FROM dataset_images
                    WHERE dataset_id = $1
                      AND image_id = $2
                    `,
                    [datasetId, imageId]
                );
            }
        }

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete dataset image" });
    }
});

app.post("/datasets/:id/delete-files", async (req, res) => {
    const datasetId = Number(req.params.id);
    const filenames = Array.isArray(req.body.filenames) ? req.body.filenames : [];
    if (!datasetId || filenames.length === 0) {
        res.status(400).json({ error: "dataset id and filenames required" });
        return;
    }

    const safeNames = filenames.map(name => path.basename(String(name || ""))).filter(Boolean);
    if (safeNames.length === 0) {
        res.status(400).json({ error: "No valid filenames" });
        return;
    }

    const datasetDir = path.join(DATASETS_BASE, String(datasetId));
    const root = path.normalize(datasetDir) + path.sep;

    try {
        const datasetR = await pool.query(
            `
            SELECT id, known_face_id
            FROM datasets
            WHERE id = $1
            `,
            [datasetId]
        );
        if (datasetR.rowCount === 0) {
            res.status(404).json({ error: "Dataset not found" });
            return;
        }

        const knownFaceId = datasetR.rows[0].known_face_id;
        const faceIds = safeNames
            .map(name => Number(path.parse(name).name))
            .filter(id => Number.isInteger(id) && id > 0);

        let imageIds = [];
        if (faceIds.length > 0) {
            const faceR = await pool.query(
                `
                SELECT id, image_id
                FROM image_faces
                WHERE known_face_id = $1
                  AND id = ANY($2::int[])
                `,
                [knownFaceId, faceIds]
            );
            imageIds = Array.from(new Set(faceR.rows.map(row => row.image_id)));
        }

        for (const name of safeNames) {
            const fullPath = path.join(datasetDir, name);
            const normalized = path.normalize(fullPath);
            if (!normalized.startsWith(root)) {
                res.status(400).json({ error: "Invalid file path" });
                return;
            }
            try {
                await fs.unlink(normalized);
            } catch (err) {
                if (err.code !== "ENOENT") {
                    throw err;
                }
            }
        }

        if (imageIds.length > 0) {
            const entries = await fs.readdir(datasetDir, { withFileTypes: true });
            const remainingFaceIds = new Set(
                entries
                    .filter(entry => entry.isFile())
                    .map(entry => Number(path.parse(entry.name).name))
                    .filter(id => Number.isInteger(id) && id > 0)
            );

            const facesR = await pool.query(
                `
                SELECT id, image_id
                FROM image_faces
                WHERE known_face_id = $1
                  AND image_id = ANY($2::int[])
                `,
                [knownFaceId, imageIds]
            );
            const imageToFaceIds = new Map();
            for (const row of facesR.rows) {
                if (!imageToFaceIds.has(row.image_id)) {
                    imageToFaceIds.set(row.image_id, []);
                }
                imageToFaceIds.get(row.image_id).push(row.id);
            }

            const imageIdsToRemove = [];
            for (const [imageId, ids] of imageToFaceIds.entries()) {
                const stillExists = ids.some(id => remainingFaceIds.has(id));
                if (!stillExists) {
                    imageIdsToRemove.push(imageId);
                }
            }

            if (imageIdsToRemove.length > 0) {
                await pool.query(
                    `
                    DELETE FROM dataset_images
                    WHERE dataset_id = $1
                      AND image_id = ANY($2::int[])
                    `,
                    [datasetId, imageIdsToRemove]
                );
            }
        }

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete dataset images" });
    }
});

app.get("/datasets/:id/media/:filename", async (req, res) => {
    const datasetId = Number(req.params.id)
    if (!datasetId) {
        res.status(400).send("dataset id required")
        return
    }

    const requested = String(req.params.filename || "")
    const safeName = path.basename(requested)
    const fullPath = path.join(DATASETS_BASE, String(datasetId), safeName)
    const normalized = path.normalize(fullPath)
    const root = path.normalize(path.join(DATASETS_BASE, String(datasetId))) + path.sep

    if (!normalized.startsWith(root)) {
        res.status(400).send("Invalid file path")
        return
    }

    res.sendFile(normalized)
})

const datasetJobs = new Map()

const parseBbox = (bbox) => {
    if (!bbox) return null
    if (typeof bbox === "string") {
        try {
            return JSON.parse(bbox)
        } catch (_err) {
            return null
        }
    }
    return bbox
}

const computeCrop = (bbox, imgWidth, imgHeight) => {
    const x = Number(bbox.x || 0)
    const y = Number(bbox.y || 0)
    const w = Number(bbox.w || 0)
    const h = Number(bbox.h || 0)
    const xPad = w * 0.05
    const yPad = h * 0.05
    const left = Math.max(0, Math.round(x - xPad))
    const top = Math.max(0, Math.round(y - yPad))
    const right = Math.min(imgWidth, Math.round(x + w + xPad))
    const bottom = Math.min(imgHeight, Math.round(y + h + yPad))
    const width = Math.max(1, right - left)
    const height = Math.max(1, bottom - top)
    return { left, top, width, height }
}

app.post("/datasets", async (req, res) => {
    const name = String(req.body.name || "").trim()
    const faceName = String(req.body.faceName || "").trim()
    let jobId = null

    if (!name || !faceName) {
        res.status(400).json({ error: "name and faceName are required" })
        return
    }

    try {
        const knownR = await pool.query(
            `
            SELECT id
            FROM known_faces
            WHERE name = $1
            LIMIT 1
            `,
            [faceName]
        )

        if (knownR.rowCount === 0) {
            res.status(404).json({ error: "Known face not found" })
            return
        }

        const knownFaceId = knownR.rows[0].id
        const datasetR = await pool.query(
            `
            INSERT INTO datasets (name, known_face_id)
            VALUES ($1, $2)
            RETURNING id
            `,
            [name, knownFaceId]
        )

        const datasetId = datasetR.rows[0].id
        const facesR = await pool.query(
            `
            SELECT f.id AS face_id,
                   f.image_id,
                   f.face_boundary AS bbox,
                   m.path AS media_path
            FROM image_faces f
            JOIN media m ON m.id = f.image_id
            WHERE f.known_face_id = $1
              AND m.path NOT ILIKE '%.heic'
              AND m.duplicate_of_id IS NULL
            ORDER BY f.id
            `,
            [knownFaceId]
        )

        jobId = randomUUID()
        datasetJobs.set(jobId, {
            status: "running",
            completed: 0,
            total: facesR.rowCount,
            error: null,
            datasetId
        })

        res.json({ jobId, datasetId })

        const outputDir = path.join(DATASETS_BASE, String(datasetId))
        await fs.mkdir(outputDir, { recursive: true })

        if (facesR.rowCount === 0) {
            datasetJobs.set(jobId, {
                ...datasetJobs.get(jobId),
                status: "completed"
            })
            return
        }

        for (const face of facesR.rows) {
            const bbox = parseBbox(face.bbox)
            if (!bbox) {
                datasetJobs.set(jobId, {
                    ...datasetJobs.get(jobId),
                    status: "error",
                    error: `Invalid bbox for face ${face.face_id}`
                })
                return
            }

            const srcPath = path.join(MEDIA_BASE, face.media_path)
            const ext = path.extname(face.media_path) || ".jpg"
            const filename = `${face.face_id}${ext}`
            const destPath = path.join(outputDir, filename)

            const img = sharp(srcPath)
            const meta = await img.metadata()
            if (!meta.width || !meta.height) {
                throw new Error(`Missing dimensions for ${face.media_path}`)
            }

            const crop = computeCrop(bbox, meta.width, meta.height)
            await img.extract(crop).toFile(destPath)

            await pool.query(
                `
                INSERT INTO dataset_images (dataset_id, image_id)
                VALUES ($1, $2)
                `,
                [datasetId, face.image_id]
            )

            const current = datasetJobs.get(jobId)
            datasetJobs.set(jobId, {
                ...current,
                completed: current.completed + 1
            })
        }

        datasetJobs.set(jobId, {
            ...datasetJobs.get(jobId),
            status: "completed"
        })
    } catch (err) {
        console.error(err)
        if (jobId && datasetJobs.has(jobId)) {
            datasetJobs.set(jobId, {
                ...datasetJobs.get(jobId),
                status: "error",
                error: err.message || "Dataset creation failed"
            })
        }
    }
})

app.get("/datasets/:jobId/status", (req, res) => {
    const job = datasetJobs.get(req.params.jobId)
    if (!job) {
        res.status(404).json({ error: "Job not found" })
        return
    }

    res.json({
        status: job.status,
        completed: job.completed,
        total: job.total,
        error: job.error,
        datasetId: job.datasetId
    })
})

app.post("/label", async (req, res) => {
    const face_id = Number(req.body.face_id);
    const name = String(req.body.name || "").trim();
    const mode = normalizeMode(req.body.mode);

    // If the name is empty, the frontend logic should have triggered /skip, 
    // but we'll add a safety check here just in case.
    if (!face_id || !name) {
        res.status(400).send("face_id and name are required");
        return;
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Get or Create the known_face record by name
        // This handles both new names and existing names typed into the datalist
        const knownFaceResult = await client.query(
            `
            INSERT INTO known_faces (name)
            VALUES ($1)
            ON CONFLICT (name) 
            DO UPDATE SET name = EXCLUDED.name -- No-op to get the ID
            RETURNING id
            `,
            [name]
        );

        const known_face_id = knownFaceResult.rows[0].id;

        // 2. Update the specific face instance
        await client.query(
            `
            UPDATE image_faces
            SET known_face_id = $1,
                assigned_by = 'manual',
                assigned_at = now()
            WHERE id = $2
            `,
            [known_face_id, face_id]
        );

        await client.query("COMMIT");
        res.redirect(`/faceid?mode=${mode}`);
    } catch (e) {
        await client.query("ROLLBACK");
        console.error(e);
        res.status(500).send("Server Error");
    } finally {
        client.release();
    }
});

// Resized JPEG thumbnails, cached on disk under THUMBS_BASE
app.get("/thumb/:id", async (req, res) => {
    const id = Number(req.params.id);
    const width = THUMB_WIDTHS.has(Number(req.query.w)) ? Number(req.query.w) : 300;
    if (!Number.isInteger(id)) return res.status(400).send("Bad id");

    const thumbPath = path.join(THUMBS_BASE, `${id}_${width}.jpg`);
    try {
        await fs.access(thumbPath);
        return res.sendFile(thumbPath);
    } catch {
        // not cached yet
    }

    try {
        const r = await pool.query(
            "SELECT path FROM media WHERE id = $1 AND type = 'image'",
            [id]
        );
        if (r.rows.length === 0) return res.status(404).send("Not found");

        await fs.mkdir(THUMBS_BASE, { recursive: true });
        // Write to a temp file first so two requests for the same thumb can't serve a half-written file
        const tmpPath = `${thumbPath}.${randomUUID()}.tmp`;
        await sharp(path.join(MEDIA_BASE, r.rows[0].path))
            .rotate() // apply EXIF orientation
            .resize({ width, withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(tmpPath);
        await fs.rename(tmpPath, thumbPath);
        res.sendFile(thumbPath);
    } catch (err) {
        console.error(err);
        res.status(500).send("Thumbnail error");
    }
});

app.get("/map", (req, res) => {
    res.render("map");
});

// All geotagged images as compact [id, lat, lon] rows; clustering happens in the browser
app.get("/api/map/points", async (req, res) => {
    try {
        // gps_location is (lon, lat); HEIC originals are skipped because their _converted JPGs carry the same location
        const r = await pool.query(`
            SELECT id, gps_location[1] AS lat, gps_location[0] AS lon
            FROM media
            WHERE type = 'image'
                AND gps_location IS NOT NULL
                AND NOT (gps_location[0] = 0 AND gps_location[1] = 0)
                AND path NOT ILIKE '%.heic'
                AND duplicate_of_id IS NULL
        `);
        res.json(r.rows.map(p => [Number(p.id), p.lat, p.lon]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

app.get("/api/media/:id", async (req, res) => {
    try {
        const r = await pool.query(
            "SELECT id, path, original_date FROM media WHERE id = $1",
            [Number(req.params.id)]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: "Not found" });
        res.json(r.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

app.get("/nsfw", (req, res) => {
    res.render("nsfw");
});

app.get("/api/nsfw", async (req, res) => {
    const limit = 24;
    const page = req.query.page ? Number(req.query.page) : 0;
    const minScore = req.query.min !== undefined ? Number(req.query.min) : 0.5;
    const label = req.query.label || "";

    const params = [limit, page * limit, minScore];
    let labelClause = "";
    if (label) {
        params.push(label);
        labelClause = `AND $${params.length} = ANY(nsfw_labels)`;
    }

    try {
        const r = await pool.query(`
            SELECT id, path, nsfw_score, nsfw_labels
            FROM media
            WHERE type = 'image'
                AND nsfw_score >= $3
                AND path NOT ILIKE '%.heic'
                AND duplicate_of_id IS NULL
                ${labelClause}
            ORDER BY nsfw_score DESC, id DESC
            LIMIT $1 OFFSET $2
        `, params);
        res.json(r.rows);
    } catch (err) {
        // 42703 = undefined column: db/add_nsfw.sql hasn't been applied yet
        if (err.code === "42703") {
            return res.status(409).json({ error: "NSFW columns are missing. Apply db/add_nsfw.sql and run detect_nsfw.py." });
        }
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => {
	console.log(`Face labeler: http://localhost:${PORT}`)
})
