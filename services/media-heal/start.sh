# media-heal — the clock of the media-heal pipeline, which closes the media gaps nothing announced.
#
# Each interval, `media-heal` announces a pass when one is due: not while one runs or the last
# failed, not within the rest after a pass that found nothing, and not while every kind of gap
# the pass would find has work waiting. The pass itself is a pipeline instance, which shows in
# Ongoing with its progress (ein/core#1003).
#
# Failed pipeline work is not this service's: `pipeline heal` (run by pipeline-pruner) reruns it.
interval="${CFG_MEDIA_HEAL_INTERVAL:-900}"

echo media-heal: starting
while true; do
  media-heal
  sleep "$interval"
done
