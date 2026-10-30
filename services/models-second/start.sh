# A second models worker (see models/start.sh): the same backlogs, its own slots, the reverse
# order. Two workers rotating apart mostly hold different kinds, so EMS runs two families side by
# side, each worker's slow steps filling its own slots and not the other's (ein/core#734). Off
# while CFG_MODEL_SECOND_SLOTS is 0; size the two together against EMS's model limit and card.
#
# Off, it idles rather than exits: an enabled service that has stopped is one that is down, and
# changing the setting restarts this script, which then starts the worker.
if [ "${CFG_MODEL_SECOND_SLOTS:-0}" -le 0 ]; then
  echo models-second: off, CFG_MODEL_SECOND_SLOTS is 0
  while true; do
    sleep 86400
  done
fi
echo models-second: starting

pipeline-worker --pool "${POOLS_PATH:-/var/pools}/media" \
  --capacity models="${CFG_MODEL_SECOND_SLOTS}" \
  --kind shots \
  --kind diarize \
  --kind transcribe \
  --kind embed-text \
  --kind ocr \
  --kind embed-picture \
  --kind faces \
  --kind-quantum "${CFG_MODEL_KIND_QUANTUM_MS:-3600000}" \
  --concurrency "${CFG_MODEL_SECOND_SLOTS}"
