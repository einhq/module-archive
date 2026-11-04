# Admits the media pool's work that is not a model request, against one budget of `cpu` slots.
#
# The engine puts these steps in /pools/media instead of running them inline, so a crawl cannot
# start hundreds at once. Some run here, on EiN's own data:
#   unzip         — a zip in a staging category expanded               (priority 100)
#   ingest        — a file's metadata (EMS reads it) and its hash     (priority 100)
#   face-assign   — a kNN over every known face embedding              (priority 40)
#   speaker-assign — the same for a recording's voices                  (priority 40)
#   dedupe        — a staged file's duplicate findings                 (priority 20)
#   retime        — staged files dated by a category's rules           (priority 20)
#   organize      — a staging category's groups planned again          (priority 15)
#   sidecars      — Takeout and XMP sidecars paired with files         (priority 30)
# and some wait on EMS, which decodes and encodes the media:
#   stills        — pictures of every media file and a video's storyboard (priority 60)
#   fingerprint   — perceptual hashes                                  (priority 30)
#   transcode     — a video or audio file's web rendition, two slots   (priority 10)
# The model requests (faces, vectors, transcripts) are the `models` worker's.
#
# A `kind` with no worker declaring it waits forever — the pool has nobody to claim it — so every
# kind a pipeline step names with `requires: cpu` appears below (test/media/model-slots.test.ts).
#
# CFG_CPU_SLOTS is the budget and each step's `requires` what a job takes of it, so one transcode
# excludes a concurrent face assignment on a two-slot box while two assignments share it;
# --concurrency is only an upper bound. CFG_CPU_NON_ENTRY_SLOTS is a soft reservation inside the
# budget: ingest keeps normal priority over the unreserved share, admitted downstream work gets
# first choice of the reserved tail, and ingest borrows it whenever none of that can run. When it
# is transcode's turn and only one slot is free, the worker holds that slot and admits nothing
# else until a second frees, or a two-slot job would wait forever behind one-slot kinds.
#
# The pool path comes from POOLS_PATH, which boot exports into /etc/bashrc and this service
# sources; a literal path would name an empty pool nothing writes to (ein/core#210).
echo media-worker: starting

pipeline-worker --pool "${POOLS_PATH:-/var/pools}/media" \
  --capacity cpu="${CFG_CPU_SLOTS:-2}" \
  --kind unzip \
  --kind ingest \
  --kind stills \
  --kind face-assign \
  --kind speaker-assign \
  --kind fingerprint \
  --kind dedupe \
  --kind retime \
  --kind organize \
  --kind sidecars \
  --kind transcode \
  --reserve-capacity cpu="${CFG_CPU_NON_ENTRY_SLOTS:-1}" \
  --reserve-kind stills \
  --reserve-kind face-assign \
  --reserve-kind speaker-assign \
  --reserve-kind fingerprint \
  --reserve-kind dedupe \
  --reserve-kind retime \
  --reserve-kind organize \
  --reserve-kind sidecars \
  --reserve-kind transcode \
  --concurrency "${CFG_CPU_WORKERS:-4}"
