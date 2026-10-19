# Media Catalogue

#### Create DB

```
# create the database
createdb -U postgres media_catalogue 
# create the tables
psql -d media_catalogue -U postgres -f db/tables.sql 
psql -d media_catalogue -U postgres -f db/data.sql 
```

#### Create Python Environment

```
python3 -m venv medcat_venv
source ./medcat_venv/bin/activate
pip install -r requirements.txt
mv .env-default .env # and then populate the .env file
# NudeNet (for detect_nsfw.py): --no-deps stops it pulling in CPU onnxruntime, which clashes with onnxruntime-gpu
pip install --no-deps nudenet==3.4.2
```

If `requirements.txt` already lists `nudenet`, remove `onnxruntime` (the CPU one) afterwards if pip installed it: `pip uninstall onnxruntime && pip install --force-reinstall onnxruntime-gpu==1.23.2`

#### Install ExifTool

```
# If on Mac
brew install exiftool
```

#### Saving Progress

```
# Backup Database
pg_dump --data-only --inserts --no-owner --no-privileges media_catalogue > db/data.sql 
# Save Requirements
pip freeze > requirements.txt
```

#### Scripts

 - `catalogue.py`: catalogues all images and vides in MEDIABASEPATH; `--skip-existing` skips paths already in the table (much faster on re-runs)
 - `detect_nsfw.py`: scores unchecked images with NudeNet and sets `nsfw_score`, `nsfw_labels` and `nsfw_checked_at`. Needs `db/add_nsfw.sql` applied to existing databases. `NSFW_THRESHOLD` in .env (default 0.5) only affects the printed yes/no
 - `parse_faces.py`: find faces in unparsed images and create records in the faces table
 - `convert_heic.py`: converts any heic files to jpg so they can be parsed
 - `detect_dupes.py`: detects duplicate media and marks it as such
 - `detect_faces.py`: detects faces in the data base, based on new data

#### Adding New Files

After copying new photos into a folder under MEDIABASEPATH, run these in order from the project root with the venv active (`source ./medcat_venv/bin/activate`):

```
# 1. Mount the drive (by label, since the /dev/sdX name can change between boots)
sudo mkdir -p /mnt/robs-drive && sudo mount -t exfat -o rw,uid=$(id -u),gid=$(id -g),umask=0022 /dev/disk/by-label/robs-drive /mnt/robs-drive

# 2. Add the new files to the media table
python catalogue.py --skip-existing

# 3. Convert new HEIC files to JPG (adds a row for each _converted JPG)
python convert_heic.py

# 4. Mark duplicates, so the steps below skip them
python detect_dupes.py

# 5. Find faces in the new images
python parse_faces.py

# 6. Score the new images for NSFW content (independent of step 5, either order works)
python detect_nsfw.py

# 7. Optional: after labelling faces in the gallery, re-match unlabelled faces against the new labels
python detect_faces.py

# 8. Back up the database (see Saving Progress)
pg_dump --data-only --inserts --no-owner --no-privileges media_catalogue > db/data.sql
```

All of these are safe to re-run: steps 2, 3, 5 and 6 only process files they haven't handled yet, and steps 4 and 7 just recompute their results.


#### Mounting the drive

```
sudo mount -o remount,rw,uid=$(id -u),gid=$(id -g),umask=0022 /mnt/robs-drive
sudo mkdir -p /mnt/robs-drive && sudo mount -t exfat /dev/sda2 /mnt/robs-drive
```