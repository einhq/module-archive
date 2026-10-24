# Owns the CPU-bound media resources the engine must not run N-wide inline.
#
# Each of these is a whole-library or whole-file operation that would otherwise
# fill the engine's shared semaphore during a crawl:
#   unzip         — a zip in a staging category expanded          (1 slot, priority 100)
#   ingest        — metadata extraction and source hashing        (1 slot, priority 100)
#   stills        — pictures of every media file (sizes, posters, (1 slot, priority 60)
#                   a video's storyboard)
#   face-assign   — a kNN over every known face embedding      (1 slot, priority 40)
#   face-transfer — legacy tag → detection, plus a crop each    (1 slot, priority 90)
#   fingerprint   — perceptual hash calculation                    (1 slot, priority 30)
#   dedupe        — a staged file's duplicate findings          (1 slot, priority 20)
#   retime        — staged files dated by a category's rules     (1 slot, priority 20)
#   organize      — a staging category's groups planned again     (1 slot, priority 15)
#   sidecars      — Takeout and XMP sidecars paired with files    (1 slot, priority 30)
#   transcode     — minutes of ffmpeg per video or audio file  (2 slots, priority 10)
#
# A `kind` with no worker declaring it is not a slow step, it is a step that
# waits forever — the pool has nobody to claim it. So every kind a pipeline
# names must appear below.
#
# Priority lives on the jobs now, so face assignment (which gates people showing
# up in the UI) still never waits behind a queue of video encodes. What is
# expressed here is capacity: CFG_CPU_SLOTS is the budget and each step's
# `requires` says how much of it a job takes — which is why one transcode
# excludes a concurrent face assignment on a two-slot box, but two assignments
# can share it. --concurrency is only an upper bound; the budget is the limit.
# CFG_CPU_NON_ENTRY_SLOTS is a soft reservation inside that budget. Ingest
# keeps normal priority over the unreserved share, while admitted downstream
# work gets first choice of the reserved tail. If none can run, ingest borrows
# it immediately; this is a work-conserving reservation, not an idle partition.
# When it is transcode's turn and only one slot is free, the worker holds that
# slot and admits nothing else until a second frees, or a two-slot job would
# wait forever behind the one-slot kinds refilling the pool one slot at a time.
#
# Lives here rather than being added ad-hoc with `service add`: module services are
# registered and enabled by mod-setup at every boot, so this survives a lost database.
# The pool path comes from POOLS_PATH, which boot exports into /etc/bashrc and this
# service sources. It is NOT a literal: the root-layout split moved the pools under
# /var, and a literal `/pools/media` here kept resolving -- to a second, empty pool node
# that nothing ever wrote to. The engine filled /var/pools/media while both workers sat
# parked on /pools/media claiming nothing, with no error on either side. See
# ein/core#210.
echo cpu-worker: starting

pipeline-worker --pool "${POOLS_PATH:-/var/pools}/media" \
  --capacity cpu="${CFG_CPU_SLOTS:-2}" \
  --kind unzip \
  --kind ingest \
  --kind stills \
  --kind face-assign \
  --kind face-transfer \
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
  --reserve-kind face-transfer \
  --reserve-kind speaker-assign \
  --reserve-kind fingerprint \
  --reserve-kind dedupe \
  --reserve-kind retime \
  --reserve-kind organize \
  --reserve-kind sidecars \
  --reserve-kind transcode \
  --concurrency "${CFG_CPU_WORKERS:-4}"
