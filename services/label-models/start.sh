# label-models — keeps label suggestions current.
#
# A label's model goes stale when what carries it or what was rejected for it changes, and after a
# week whatever changed, since the archive it was measured on has grown. The labels page retrains
# the one label it shows; this sweep keeps the rest, and the vocabulary's words, ready.
echo label-models: starting
while true; do
  label-model train --all --if-stale
  sleep 3600
done
