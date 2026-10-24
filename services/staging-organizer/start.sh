# staging-organizer — the organizer's safety net. The `staging-organize` pipeline organizes a
# category when archive-bridge sees its files change or someone asks; what the bridge does not
# announce (a person named on a face, a geocode, a tag, a pin or a link made by hand in a group)
# still lands in the audit trail, so every 15 minutes each category with anything waiting since
# its last run, or a week since its last full build, is asked for a run (`--if-pending`), which
# the pipeline makes. Then the groups due a match are matched (`staging match --stale`): no
# matches for their members as they are, or a candidate album's profile newer than them.
#
# Hourly, each user's staging area is made whole (its layout only: nothing moves), and every
# inbox's duplicate findings are checked against where their files are now, which a move made
# outside staging's own verbs can leave wrong. Live uploads are indexed by archive-bridge's
# pipelines; this loop does not run media-scan, since repeating a gap-recovery producer while the
# pipeline is behind creates duplicate trigger events.
echo staging-organizer: starting
round=0
while true; do
  if [ $(( round % 4 )) -eq 0 ]; then
    staging init --all --layout-only
    staging duplicates --repair --all
  fi
  staging organize --all --queue --if-pending
  staging match --all --stale
  round=$(( round + 1 ))
  sleep 900
done
