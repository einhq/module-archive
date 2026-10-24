import { Alert, Badge, Box, Button, Card, Group, Stack, Text } from '@mantine/core';
import {
  BrowseEntityCard,
  CardGrid,
  EmptyState,
  EntityDetailHeader,
  HeaderChoice,
  HeaderChoices,
  HeaderFilterBar,
  HeaderStats,
  ListFilterInput,
  PageLoader,
  TablerIcon,
} from '@ein/ui/components';
import { canWrite, countOf, matchesText, plainMarkdown } from '@ein/ui/lib';
import { useAccessIds, usePersistedState, useUrlParam } from '@ein/ui/hooks';
import { type DeviceEntry, type DeviceProposal, useDevices } from '../hooks/useDevices.ts';
import { isAuthenticated, openDialog } from '@ein/ui/signals';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

type Scope = 'registered' | 'unregistered';
type DeviceSort = 'name' | 'name-desc' | 'model';

const deviceDescription = (device: DeviceEntry): string => device.description ? plainMarkdown(device.description) : [device.make, device.model].filter(Boolean).join(' ');
const deviceHasBadge = (device: DeviceEntry): boolean => Boolean(device.serialNumber || device.timezone || device.digitizer || device.quicktimeUtc);

/**
 * A camera the archive has seen; the count is what makes it worth acting on.
 *
 * Two different actions, and the difference matters: a fingerprint nothing is
 * registered under is a new device, but one whose name already exists belongs to
 * that device — it just never carried the make, model or serial its files could
 * be matched by. Offering "Register" for the second kind would quietly build a
 * second copy of a camera the archive already knows. Adopting changes that
 * device, so it is offered only to a reader who may.
 */
function ProposalCard({ proposal, onRegister, onAdopt, busy, canAdopt }: {
  proposal: DeviceProposal;
  onRegister: () => void;
  onAdopt: () => void;
  busy: boolean;
  canAdopt: boolean;
}) {
  return (
    <Card radius='md' p={{ base: 'sm', sm: 'lg' }} h='100%'>
      <Stack gap='xs' h='100%' justify='space-between'>
        <Box style={{ minWidth: 0 }}>
          <Text fw={500} lineClamp={1}>
            {proposal.suggestedName}
          </Text>
          {(proposal.make || proposal.model) && (
            <Text size='xs' c='dimmed' lineClamp={1}>
              {[proposal.make, proposal.model].filter(Boolean).join(' · ')}
            </Text>
          )}
          {proposal.serialNumber && (
            <Text size='xs' c='dimmed'>
              Serial {proposal.serialNumber}
            </Text>
          )}
          <Group gap='xs' mt={6}>
            <Badge size='xs' variant='light' color='yellow'>
              {proposal.files.toLocaleString()} file{proposal.files === 1 ? '' : 's'}
            </Badge>
            {proposal.existingName && (
              <Badge size='xs' variant='light' color='gray'>
                registered as {proposal.existingName}, but unmatchable
              </Badge>
            )}
          </Group>
        </Box>
        {
          /* Full width and at the foot of the card, so a long device name cannot
            squeeze the text beside it and every card is the same shape. */
        }
        {proposal.existingPath
          ? canAdopt && (
            <Button size='compact-sm' variant='light' fullWidth leftSection={<TablerIcon name='link' size={14} />} onClick={onAdopt} loading={busy}>
              Add fingerprint
            </Button>
          )
          : (
            <Button size='compact-sm' variant='light' fullWidth leftSection={<TablerIcon name='plus' size={14} />} onClick={onRegister}>
              Register
            </Button>
          )}
      </Stack>
    </Card>
  );
}

/** The page draws its own band edge to edge. */
export const handle = { fullBleed: true };

export default function DevicesPage() {
  const [search, setSearch] = useUrlParam('q');
  const [scope, setScope] = useState<Scope>('registered');
  const [sortBy, setSortBy] = usePersistedState<DeviceSort>('devices.list.sort', 'name');
  const { devices, loading, error, scan, scanning, scanError, runScan, adopt } = useDevices();
  const access = useAccessIds();
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const matching = devices.filter((device) => matchesText([device.name, device.model, device.make, device.serialNumber], search));

    if (sortBy === 'name-desc') return matching.toSorted((a, b) => b.name.localeCompare(a.name));
    if (sortBy === 'model') {
      return matching.toSorted((a, b) => [a.make, a.model, a.name].filter(Boolean).join(' ').localeCompare([b.make, b.model, b.name].filter(Boolean).join(' ')));
    }
    return matching.toSorted((a, b) => a.name.localeCompare(b.name));
  }, [devices, search, sortBy]);

  const showUnregistered = () => {
    setScope('unregistered');
    // The scan is a question about the whole corpus, so it is asked once per
    // visit rather than on every render of this view.
    if (!scan && !scanning) void runScan();
  };

  const [adopting, setAdopting] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<string | null>(null);

  const adoptProposal = async (proposal: DeviceProposal, key: string) => {
    try {
      setAdopting(key);
      setAdopted(null);
      const linked = await adopt(proposal);
      setAdopted(
        linked > 0
          ? `Linked ${linked.toLocaleString()} file${linked === 1 ? '' : 's'} to ${proposal.existingName}.`
          : `${proposal.existingName} now carries the fingerprint, but no unclaimed files matched it.`,
      );
    } finally {
      setAdopting(null);
    }
  };

  const register = (proposal: DeviceProposal) => {
    const known = { name: proposal.suggestedName, make: proposal.make, model: proposal.model, serial: proposal.serialNumber };
    const query = new URLSearchParams(Object.entries(known).flatMap(([key, value]) => (value ? [[key, value]] : [])));
    openDialog(`/devices/new?${query}`);
  };

  return (
    <Box>
      <EntityDetailHeader
        title='Devices'
        pattern='device'
        meta={!loading && <HeaderStats items={[countOf(devices.length, 'device', 'devices')]} />}
        flowContent
        controls={
          <HeaderFilterBar input={<ListFilterInput value={search} onChange={setSearch} what='devices' />}>
            <HeaderChoices>
              <HeaderChoice
                label='Show'
                variant='segmented'
                value={scope}
                onChange={(next) => (next === 'unregistered' ? showUnregistered() : setScope('registered'))}
                options={[
                  { label: `Registered (${devices.length})`, value: 'registered', icon: <TablerIcon name='camera-check' size={18} /> },
                  { label: scan ? `Unregistered (${scan.proposals.length})` : 'Unregistered', value: 'unregistered', icon: <TablerIcon name='camera-question' size={18} /> },
                ]}
              />
              <HeaderChoice
                label='Sort'
                value={sortBy}
                onChange={(value) => setSortBy(value as DeviceSort)}
                disabled={scope === 'unregistered'}
                options={[
                  { value: 'name', label: 'Name (A-Z)', icon: <TablerIcon name='sort-ascending-letters' size={18} /> },
                  { value: 'name-desc', label: 'Name (Z-A)', icon: <TablerIcon name='sort-descending-letters' size={18} /> },
                  { value: 'model', label: 'Make / model', icon: <TablerIcon name='camera' size={18} /> },
                ]}
              />
            </HeaderChoices>
          </HeaderFilterBar>
        }
      />

      <Box px='md' py='lg'>
        <Stack gap='lg'>
          {error && (
            <Alert icon={<TablerIcon name='alert-circle' size={16} />} color='red'>
              {error.message}
            </Alert>
          )}

          {scope === 'registered' && (
            loading ? <PageLoader /> : (
              <>
                <CardGrid
                  items={filtered}
                  itemKey={(device) => device.id}
                  textParts={(device) => ({ description: Boolean(deviceDescription(device)), badges: deviceHasBadge(device) })}
                >
                  {(device) => (
                    <BrowseEntityCard
                      title={device.name}
                      description={deviceDescription(device)}
                      coverPath={device.path}
                      kind='device'
                      onClick={() => navigate(`/devices/${device.id}`)}
                      badges={deviceHasBadge(device) && (
                        <>
                          {device.serialNumber && <Badge size='xs' variant='light' color='marine'>{device.serialNumber}</Badge>}
                          {device.timezone && <Badge size='xs' variant='light' color='gray'>{device.timezone}</Badge>}
                          {device.digitizer && <Badge size='xs' variant='light' color='yellow'>scanner</Badge>}
                          {device.quicktimeUtc && <Badge size='xs' variant='light' color='gray'>video UTC</Badge>}
                        </>
                      )}
                    />
                  )}
                </CardGrid>

                {devices.length === 0 && (
                  <EmptyState
                    title='No devices registered yet'
                    actions={
                      <>
                        <Button variant='light' onClick={showUnregistered}>Show unregistered</Button>
                        {isAuthenticated.value && <Button variant='default' onClick={() => openDialog('/devices/new')}>New device</Button>}
                      </>
                    }
                  >
                    The cameras and phones that took the pictures. Unregistered lists the ones the archive has already seen.
                  </EmptyState>
                )}
                {devices.length > 0 && filtered.length === 0 && (
                  <Box ta='center' py='xl'>
                    <Text c='dimmed'>No devices found matching "{search}"</Text>
                  </Box>
                )}
              </>
            )
          )}

          {scope === 'unregistered' && (
            <Stack gap='sm'>
              <Group justify='space-between' wrap='nowrap' align='flex-start'>
                <Text size='sm' c='dimmed' style={{ maxWidth: '68ch' }}>
                  Cameras found in the indexed media that match nothing in the registry. Registering one lets its photos be linked to it, and its timezone and owners apply.
                  Adding a fingerprint to a device that already exists also goes and links the files it identifies — quick for a serial, slow for a make and model, which has
                  no index behind it.
                </Text>
                <Button
                  size='compact-sm'
                  variant='light'
                  leftSection={<TablerIcon name='radar' size={14} />}
                  loading={scanning}
                  onClick={() => void runScan()}
                  style={{ flexShrink: 0 }}
                >
                  Rescan
                </Button>
              </Group>

              {scanError && (
                <Alert icon={<TablerIcon name='alert-circle' size={16} />} color='red'>
                  {scanError}
                </Alert>
              )}

              {adopted && (
                <Alert color='marine' variant='light' withCloseButton onClose={() => setAdopted(null)}>
                  {adopted}
                </Alert>
              )}

              {scanning && !scan && <PageLoader />}

              {scan && scan.proposals.length > 0 && (
                // Two columns, down to phones — but never a card narrower than its action button,
                // which on a 320px screen means one.
                <Box
                  style={{
                    display: 'grid',
                    gap: 'var(--mantine-spacing-sm)',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(max(150px, calc((100% - var(--mantine-spacing-sm)) / 2)), 1fr))',
                  }}
                >
                  {scan.proposals.map((proposal) => {
                    const key = proposal.serialNumber ?? `${proposal.make}|${proposal.model}`;
                    return (
                      <ProposalCard
                        key={key}
                        proposal={proposal}
                        busy={adopting === key}
                        canAdopt={!proposal.existingOwnership || canWrite(proposal.existingOwnership, access)}
                        onRegister={() => register(proposal)}
                        onAdopt={() => void adoptProposal(proposal, key)}
                      />
                    );
                  })}
                </Box>
              )}

              {scan && scan.proposals.length === 0 && (
                <Box ta='center' py='xl'>
                  <Group gap='xs' justify='center'>
                    <TablerIcon name='camera' size={16} />
                    <Text c='dimmed'>
                      Every camera the media names is registered ({scan.matched.toLocaleString()} files matched).
                    </Text>
                  </Group>
                </Box>
              )}

              {scan?.truncated && (
                <Text size='xs' c='dimmed'>
                  Only the most-used cameras are listed; there are more.
                </Text>
              )}
            </Stack>
          )}
        </Stack>
      </Box>
    </Box>
  );
}
