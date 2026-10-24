#!/bin/bash
# Regenerate the committed media fixtures for the container E2E tier.
#
# The EiN image has no media tools any more — exiftool, ImageMagick and ffmpeg all live in
# EMS — so the fixtures the media E2E tests upload are committed, and this is the recipe they
# were made with. Run it inside the EMS container, which has every tool:
#
#   podman exec -i ems bash -s -- /files-tmp/fixtures < modules/archive/test/media/fixtures/make-fixtures.sh
#   cp /path/to/files-tmp/fixtures/* modules/archive/test/media/fixtures/
#
# The numbers here are the ones `media-fixtures.ts` documents (PHOTO, ROTATED, ROTATED_VIDEO,
# ANAMORPHIC); change them together. Regenerating changes bytes the tests measure against, so
# do it deliberately and rerun `make container-test`.
set -euo pipefail

out=${1:?usage: make-fixtures.sh <output dir>}
mkdir -p "$out"

# PHOTO: bigger than the largest derivative box (2560) on one axis and not square, so every
# aspect-preserving derivative is a real downscale of a known 4:3 source.
convert -size 3200x2400 gradient:blue-yellow "$out/photo.jpg"
exiftool -DateTimeOriginal='2020:06:15 12:30:00' -GPSLatitude=59.3293 -GPSLatitudeRef=N \
  -GPSLongitude=18.0686 -GPSLongitudeRef=E -overwrite_original "$out/photo.jpg"

# 1s 320x240 H.264 test pattern with sine audio.
ffmpeg -v error -f lavfi -i testsrc=duration=1:size=320x240:rate=10 -f lavfi -i sine=frequency=440:duration=1 \
  -shortest -pix_fmt yuv420p -y "$out/clip.mp4"

# 6s at 10 fps: long enough for a transcode to split into several encode windows.
ffmpeg -v error -f lavfi -i testsrc=duration=6:size=320x240:rate=10 -f lavfi -i sine=frequency=440:duration=6 \
  -shortest -pix_fmt yuv420p -y "$out/long.mp4"

# 4s AAC sine tone, long enough for chromaprint.
ffmpeg -v error -f lavfi -i sine=frequency=440:duration=4 -c:a aac -y "$out/tone.m4a"

# 2s MPEG-2 program stream: exiftool reports no Duration for it, ffprobe measures one.
ffmpeg -v error -f lavfi -i testsrc=duration=2:size=320x240:rate=25 -f lavfi -i sine=frequency=440:duration=2 \
  -c:v mpeg2video -c:a mp2 -shortest -f mpeg -y "$out/program-stream.mpg"

# 2s MJPEG in AVI: a codec NVDEC has no usable decoder for.
ffmpeg -v error -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -c:v mjpeg -pix_fmt yuvj422p -an -y "$out/legacy.avi"

# ROTATED: a 400x200 raster tagged Orientation=6 (angle 270, display frame 200x400) with a red
# marker block at raw (40,40)-(79,79).
convert -size 400x200 gradient:blue-yellow -fill red -draw 'rectangle 40,40 79,79' "$out/rotated.jpg"
exiftool -Orientation=6 -n -DateTimeOriginal='2020:06:15 12:30:00' -overwrite_original "$out/rotated.jpg"

# ROTATED_VIDEO: a portrait phone clip, rotation in the container display matrix. exiftool
# rather than ffmpeg writes it: `-metadata:s:v rotate=` writes no matrix and `-display_rotation`
# the opposite sign; `Rotation=90` produces `rotation=-90`, byte for byte what iPhone clips carry.
ffmpeg -v error -f lavfi -i testsrc=duration=1:size=320x240:rate=10 -pix_fmt yuv420p -y "$out/rotated.mp4"
exiftool -Rotation=90 -n -overwrite_original "$out/rotated.mp4"

# ANAMORPHIC: coded 480x360 with SAR 4:3, i.e. a 640x360 picture, in the container exiftool
# reads the ratio from (MP4) and the one it does not (MPEG-TS, the AVCHD `.MTS` shape).
ffmpeg -v error -f lavfi -i testsrc=duration=1:size=480x360:rate=10 -vf setsar=4/3 -pix_fmt yuv420p -y "$out/anamorphic.mp4"
ffmpeg -v error -f lavfi -i testsrc=duration=1:size=480x360:rate=10 -vf setsar=4/3 -pix_fmt yuv420p -c:v libx264 -f mpegts -y "$out/anamorphic.m2ts"

ls -l "$out"
