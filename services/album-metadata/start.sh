# album-metadata — the reconciler for every album's stacks, denormalized span, cover and profile.
#
# All of them are answers about an album's *members*, written onto the album node so the
# timeline can order albums without listing any of them.
#
# They are kept current by the `media-album` pipeline, on the `media.album.members-changed`
# fact archive-bridge derives from membership events and from a member's metadata,
# fingerprint or retime. This sweep is what fills the gaps the bridge cannot see — a hard
# link into an imported album's `files/`, a fact lost while the bridge was down — exactly as
# `media-scan` does for file facts. Hourly: the passes are a listing per album when nothing
# changed. Staging suggestions are not swept: their members change with every organizer run,
# and `media-album` follows each change.
#
# All passes avoid writes when nothing changed. Stack detection still reads the complete
# album order against one paged index of photo fingerprints; span and cover then use their stored
# signatures to skip unchanged work. Profiles are read again only once a week each (`--stale`):
# a face named or a position arriving raises no album fact, so that is how they reach a profile.
echo album-metadata: starting
while true; do
  album-stack refresh --all
  album-span --all --stale
  album-cover --all --stale
  album-profile --all --stale
  sleep 3600
done
