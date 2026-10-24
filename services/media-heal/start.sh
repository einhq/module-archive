# media-heal — close the media gaps nothing announced, once the engine has caught up.
#
# `media-scan` finds files missing what a pipeline should have given them — no fingerprint, no
# voices, picture vectors from a model EMS no longer runs — and announces each as a fact for the
# pipeline to pick up. Its facts are predicates, true for as long as the work is not done, so a scan while
# the engine is behind announces again what is already on its way: a 15-minute timer once put
# 975,781 announcements on the trigger queue for 119,765 files. So this scans only when nothing
# is waiting — no ready job in the media pool or the trigger pool — when a gap it finds is a real
# gap and not lag. A scan examines a slice of the archive and resumes where it stopped; once a
# pass reaches the end, the next starts after a rest, since a caught-up archive gains new gaps
# only from new files and model changes (ein/core#515).
#
# Failed pipeline work is not this service's: `pipeline heal` (run by pipeline-pruner) reruns it.
pools="${POOLS_PATH:-/var/pools}"
interval="${CFG_MEDIA_HEAL_INTERVAL:-900}"
rest="${CFG_MEDIA_HEAL_REST:-21600}"

ready() {
  JSON_OUTPUT=1 pool stat "$1" 2>/dev/null | jq -r '.counts.ready // 0'
}

echo media-heal: starting
while true; do
  media=$(ready "$pools/media")
  triggers=$(ready "$pools/triggers")
  if [ "$media" = 0 ] && [ "$triggers" = 0 ]; then
    result=$(JSON_OUTPUT=1 media-scan --limit 2000 --max-active 2000)
    echo "media-heal: $result"
    if [ "$(echo "$result" | jq -r '.complete')" = true ]; then
      sleep "$rest"
      continue
    fi
  fi
  sleep "$interval"
done
