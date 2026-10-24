# Owns admission of the model-bound media steps. The engine puts them in /pools/media
# instead of running them inline; this worker claims from it, and what it offers as
# `models` is how many model requests EiN keeps in flight against EMS at once.
#
# THE CARD IS EMS'S (2026-09-12). Every model left this image for the media service, so
# no GPU is passed to this container and nothing here knows whether a request ran on the
# card or the CPU — EMS decides that, and names a fallback in its health. The steps this
# worker runs are HTTP calls into EMS, which has its own admission (EMS_LIMIT_MODELS, a
# bounded queue, a reserve for interactive requests) and its own model residency and
# eviction. What this worker keeps is what EMS cannot decide for us:
#
#   - these calls are slow (a recording's transcription about a minute on the card, its
#     voices half that) and must not fill the engine's inline lane during a crawl;
#   - EMS's queue is FIFO and bounded, and answers `busy` past its depth, so EiN has to
#     bound what it sends and choose which of its backlogs gets to queue there.
#
# CFG_MODEL_SLOTS is that bound. Size it against EMS_LIMIT_MODELS on the EMS side: more
# slots than EMS runs at once only moves the wait from this pool to EMS's queue, and past
# its depth into `busy` failures and retries.
#
# KINDS ARE BACKLOGS, NOT DEVICES. Until 2026-09-15 they were `gpu-*` and each step declared
# a VRAM figure; both described a card this container has not had since the split, and the
# figures reserved nothing on EMS. A kind is the unit the rotation below fairs between, and
# each step takes one slot.
#
# Rotation is round-robin over the kind list rather than by priority, so a kind with little
# work drains and hands its slots straight on.
#
# --kind-quantum survives for one reason only, and it is not model affinity — EMS keeps its
# models resident and rotating kinds evicts nothing. faces is priority 100 against the other
# kinds' 50 and a crawl emits face jobs continuously, so "always take the highest priority"
# would starve the rest outright. The quantum is the anti-starvation bound and nothing more:
# a worker only crosses it after all commands of its current kind have finished.
#
# Priority orders jobs *within* a kind; the quantum decides between kinds.
#
# Lives here rather than being added ad-hoc with `service add`: module services are
# registered and enabled by mod-setup at every boot, so this survives a lost database.
# The pool path comes from POOLS_PATH, which boot exports into /etc/bashrc and this
# service sources. It is NOT a literal: the root-layout split moved the pools under
# /var, and a literal `/pools/media` here kept resolving -- to a second, empty pool node
# that nothing ever wrote to. The engine filled /var/pools/media while both workers sat
# parked on /pools/media claiming nothing, with no error on either side. See
# ein/core#210.
echo models-worker: starting

pipeline-worker --pool "${POOLS_PATH:-/var/pools}/media" \
  --capacity models="${CFG_MODEL_SLOTS:-2}" \
  --kind faces \
  --kind embed-picture \
  --kind ocr \
  --kind embed-text \
  --kind transcribe \
  --kind diarize \
  --kind shots \
  --kind-quantum "${CFG_MODEL_KIND_QUANTUM_MS:-900000}" \
  --concurrency "${CFG_MODEL_SLOTS:-2}"
