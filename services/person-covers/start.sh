# person-covers — the reconciler for named people's face covers.
#
# The `media-face-assign` pipeline covers a person when recognition locations one of their faces.
# Faces that move by hand go through no pipeline: naming a cluster, a merge, a split, "not a
# person". This sweep catches those, and the backlog of people named before covers were picked
# automatically. A person with a cover that still shows them costs one link read and one node
# read; the face query runs only for people who need a pick.
echo person-covers: starting
while true; do
  person-cover --all
  sleep 3600
done
