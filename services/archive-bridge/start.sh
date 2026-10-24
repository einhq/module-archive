# Derives media and location domain facts from VFS mutations and publishes them
# to /dev/events, where the pipeline engine picks them up as triggers.
#
# Lives here rather than being added ad-hoc with `service add`: module services
# are registered and enabled by mod-setup at every boot, so this survives a lost
# database.
archive-bridge
