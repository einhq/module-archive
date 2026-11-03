# media-heal — close the media gaps nothing announced, without announcing work already on its way.
#
# `media-scan` finds files missing what a pipeline should have given them — no fingerprint, no
# voices, picture vectors from a model EMS no longer runs — and announces each as a fact for the
# pipeline to pick up. Its facts are predicates, true for as long as the work is not done, so a scan while
# the engine is behind announces again what is already on its way: a 15-minute timer once put
# 975,781 announcements on the trigger queue for 119,765 files. So this scans with
# `media-scan --if-idle`, which holds back each fact a pipeline with work ready would take (a
# ready trigger, or a ready media job of one of its kinds) and names the fact types it held. A
# backlog of one kind of work then holds off only its own gaps, not every other kind's for the
# hours it takes to drain (ein/core#546). Nothing a scan announces is already on its way, so one
# scan walks the whole archive and announces every gap it finds: the work waits in the pools,
# where `health` and the dashboard count it, rather than in slices nothing shows (ein/core#944).
#
# A pass that held types back is followed by one over only those types, which `--if-idle` starts
# once one of them has nothing waiting. A pass that finds nothing and holds nothing starts a rest,
# since a caught-up archive gains new gaps only from new files and model changes (ein/core#515).
#
# Failed pipeline work is not this service's: `pipeline heal` (run by pipeline-pruner) reruns it.
interval="${CFG_MEDIA_HEAL_INTERVAL:-900}"
rest="${CFG_MEDIA_HEAL_REST:-21600}"
# The fact types the last pass held back, comma-separated; empty for a pass over every type.
owed=""

echo media-heal: starting
while true; do
  if [ -n "$owed" ]; then
    result=$(JSON_OUTPUT=1 media-scan --if-idle --only "$owed" --scan-limit 0 --limit 0 --max-active 0)
  else
    result=$(JSON_OUTPUT=1 media-scan --if-idle --scan-limit 0 --limit 0 --max-active 0)
  fi
  if [ "$(echo "$result" | jq -r '.waiting')" != true ]; then
    complete=$(echo "$result" | jq -r '.complete')
    emitted=$(echo "$result" | jq -r '.emitted')
    held=""
    for type in $(echo "$result" | jq -r '.held[]'); do
      held="${held:+$held,}$type"
    done
    # Not the announced paths, which run to one per file the scan found.
    echo "media-heal: scanned $(echo "$result" | jq -r '.scanned'), announced $emitted, complete $complete${held:+, held back $held}"
    if [ "$complete" = true ]; then
      owed="$held"
      if [ -z "$owed" ] && [ "$emitted" = 0 ]; then
        sleep "$rest"
        continue
      fi
    fi
  fi
  sleep "$interval"
done
