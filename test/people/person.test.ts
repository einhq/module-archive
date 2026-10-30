/**
 * The people area's family model: person create (with dates), parents/children/
 * partners relation dirs (with kind + partnership dates), how-related kinship
 * (English + Swedish), cycle/date guards, check/fixup integrity, family-tree,
 * children, info, and events.
 */

import { LOCATIONS_ROOT, PEOPLE_ROOT } from '@archive/paths';
import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';

const testCtx = createTestContext({ modules: ['archive'] });
let client: ShellClient;

Deno.test({
  name: 'people module',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('create person (with dates)', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/anna --name Anna --gender female --born 1950-04-02`);
      const attrs = await client.execJson<{ name: string; gender: string; born: string }>(`attrs ${PEOPLE_ROOT}/anna`);
      assertEquals(attrs.name, 'Anna');
      assertEquals(attrs.gender, 'female');
      assertEquals(attrs.born, '1950-04-02');
    });

    await t.step('dispatcher forwards args to subcommands (arg --rest)', async () => {
      await cmd.shouldSucceed(`person create ${PEOPLE_ROOT}/nils --name Nils --gender male`);
      const nils = await client.execJson<{ name: string; gender: string }>(`attrs ${PEOPLE_ROOT}/nils`);
      assertEquals(nils.name, 'Nils');
      assertEquals(nils.gender, 'male');

      await cmd.shouldSucceed(`person create ${PEOPLE_ROOT}/mia2 --name Mia --fullname "Mia Berg" --gender female`);
      const mia = await client.execJson<{ fullname: string }>(`attrs ${PEOPLE_ROOT}/mia2`);
      assertEquals(mia.fullname, 'Mia Berg');

      const info = await client.execJson<{ name: string }>(`person info ${PEOPLE_ROOT}/nils`);
      assertEquals(info.name, 'Nils');
    });

    await t.step('create the rest of the family', async () => {
      for (
        const [name, gender, born] of [
          ['erik', 'male', '1948-01-10'],
          ['eva', 'female', '1925-01-01'],
          ['karl', 'male', '1923-01-01'],
          ['mia', 'female', '1975-06-01'],
          ['john', 'male', '2000-03-03'],
          ['edvin', 'male', '1978-09-09'],
          ['lisa', 'female', '2002-05-05'],
        ] as const
      ) {
        await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/${name} --name ${name} --gender ${gender} --born ${born}`);
      }
    });

    await t.step('set-parent creates parents/ ↔ children/ pair', async () => {
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/mia ${PEOPLE_ROOT}/anna`);
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/mia ${PEOPLE_ROOT}/erik`);
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/mia`);
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/edvin ${PEOPLE_ROOT}/anna`);
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/edvin ${PEOPLE_ROOT}/erik`);
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/lisa ${PEOPLE_ROOT}/edvin`);
      // anna's own parents (for role rendering in info)
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/anna ${PEOPLE_ROOT}/eva`);
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/anna ${PEOPLE_ROOT}/karl`);

      const childLink = await client.execJson<{ relation: { peerLink: string } }>(`attrs -L ${PEOPLE_ROOT}/mia/parents/anna`);
      assertEquals(childLink.relation.peerLink, `${PEOPLE_ROOT}/anna/children/mia`);
      const parentTarget = await client.execJson<{ softlink: string }>(`props -L ${PEOPLE_ROOT}/anna/children/mia`);
      assertEquals(parentTarget.softlink, `${PEOPLE_ROOT}/mia`);
    });

    await t.step('set-parent stores kind for non-blood ties, the flag before or after the people', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/sten --name Sten --gender male --born 1970`);
      await cmd.shouldSucceed(`person-set-parent --kind step ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/sten`);
      const link = await client.execJson<{ relation: { kind: string } }>(`attrs -L ${PEOPLE_ROOT}/john/parents/sten`);
      assertEquals(link.relation.kind, 'step');
      await cmd.shouldSucceed(`person-remove ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/sten`);
    });

    await t.step('set-parent rejects duplicates and cycles', async () => {
      await cmd.shouldFail(`person-set-parent ${PEOPLE_ROOT}/mia ${PEOPLE_ROOT}/anna`); // duplicate
      await cmd.shouldFail(`person-set-parent ${PEOPLE_ROOT}/anna ${PEOPLE_ROOT}/mia`); // cycle
      await cmd.shouldFail(`person-set-parent ${PEOPLE_ROOT}/anna ${PEOPLE_ROOT}/john`); // cycle
    });

    await t.step('set-partner stores kind + dates on both links', async () => {
      await cmd.shouldSucceed(`person-set-partner --kind married --from 1972-05-20 ${PEOPLE_ROOT}/anna ${PEOPLE_ROOT}/erik`);
      const a = await client.execJson<{ relation: { kind: string; from: string } }>(`attrs -L ${PEOPLE_ROOT}/anna/partners/erik`);
      assertEquals(a.relation.kind, 'married');
      assertEquals(a.relation.from, '1972-05-20');
      const b = await client.execJson<{ relation: { from: string } }>(`attrs -L ${PEOPLE_ROOT}/erik/partners/anna`);
      assertEquals(b.relation.from, '1972-05-20');

      await cmd.shouldSucceed(`person-set-partner ${PEOPLE_ROOT}/anna ${PEOPLE_ROOT}/erik --to 1990-01-01`);
      const closed = await client.execJson<{ relation: { to: string } }>(`attrs -L ${PEOPLE_ROOT}/erik/partners/anna`);
      assertEquals(closed.relation.to, '1990-01-01');
    });

    await t.step('how-related: lineal (English + Swedish + env var)', async () => {
      assertStringIncludes(await client.execString(`person-how-related ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/anna`), 'grandmother');
      assertStringIncludes(await client.execString(`person-how-related --lang sv ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/anna`), 'mormor');
      assertStringIncludes(await client.execString(`person-how-related ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/erik --lang sv`), 'morfar');
      assertStringIncludes(
        await client.execString(`export CFG_LANGUAGE=sv && person-how-related ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/anna`),
        'mormor',
      );
    });

    await t.step('how-related: collateral', async () => {
      assertStringIncludes(await client.execString(`person-how-related ${PEOPLE_ROOT}/mia ${PEOPLE_ROOT}/edvin`), 'brother');
      assertStringIncludes(await client.execString(`person-how-related ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/edvin`), 'uncle');
      assertStringIncludes(await client.execString(`person-how-related ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/lisa`), 'first cousin');
    });

    await t.step('how-related: partner + step + unrelated', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/lars --name Lars --gender male`);
      await cmd.shouldSucceed(`person-set-partner ${PEOPLE_ROOT}/mia ${PEOPLE_ROOT}/lars`);
      assertStringIncludes(await client.execString(`person-how-related ${PEOPLE_ROOT}/mia ${PEOPLE_ROOT}/lars`), 'partner');
      assertStringIncludes(await client.execString(`person-how-related ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/lars`), 'stepfather');

      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/stranger --name Stranger --gender other`);
      await cmd.shouldFail(`person-how-related ${PEOPLE_ROOT}/john ${PEOPLE_ROOT}/stranger`); // not related -> exit 1
    });

    await t.step('remove', async () => {
      await cmd.shouldSucceed(`person-remove ${PEOPLE_ROOT}/mia ${PEOPLE_ROOT}/lars`);
      assertEquals((await client.execString(`ls ${PEOPLE_ROOT}/mia/partners`)).includes('lars'), false);
    });

    await t.step('set-home / remove-home manage person↔location residence pair', async () => {
      await cmd.shouldSucceed(`mkdir -p ${LOCATIONS_ROOT}`);
      await cmd.shouldSucceed(`mknode -t position ${LOCATIONS_ROOT}/villa --as name=Villa`);
      await cmd.shouldSucceed(`person-set-home ${PEOPLE_ROOT}/anna ${LOCATIONS_ROOT}/villa --from 1990 --to 2000`);

      const homeLink = await client.execJson<{ softlink: string }>(`props -L ${PEOPLE_ROOT}/anna/homes/villa`);
      assertEquals(homeLink.softlink, `${LOCATIONS_ROOT}/villa`);
      const rel = await client.execJson<{ relation: { peerLink: string; from: string; to: string }; movedIn?: string; movedOut?: string }>(
        `attrs -L ${PEOPLE_ROOT}/anna/homes/villa`,
      );
      assertEquals(rel.relation.peerLink, `${LOCATIONS_ROOT}/villa/residents/anna`);
      assertEquals(rel.relation.from, '1990');
      assertEquals(rel.relation.to, '2000');
      const resident = await client.execJson<{ softlink: string }>(`props -L ${LOCATIONS_ROOT}/villa/residents/anna`);
      assertEquals(resident.softlink, `${PEOPLE_ROOT}/anna`);

      // The span is denormalized onto the person-side half so the timeline can
      // index it — and onto that half only, or every move would be emitted twice.
      assertEquals(rel.movedIn, '1990');
      assertEquals(rel.movedOut, '2000');
      const residentAttrs = await client.execJson<{ movedIn?: string }>(`attrs -L ${LOCATIONS_ROOT}/villa/residents/anna`);
      assertEquals(residentAttrs.movedIn, undefined);

      await cmd.shouldFail(`person-set-home ${PEOPLE_ROOT}/anna ${LOCATIONS_ROOT}/villa --from 1991`); // exists
      await cmd.shouldFail(`person-set-home ${PEOPLE_ROOT}/anna ${LOCATIONS_ROOT}/villa --update --from notadate`);
      await cmd.shouldFail(`person-set-home ${PEOPLE_ROOT}/anna ${LOCATIONS_ROOT}/villa --update --from 2000 --to 1990`);
      await cmd.shouldFail(`person-set-home ${PEOPLE_ROOT}/anna ${LOCATIONS_ROOT}/hus --update`); // nothing to update

      // --update takes the flags given as the whole new span, so leaving --to
      // off reopens a residence that was closed by mistake.
      await cmd.shouldSucceed(`person-set-home ${PEOPLE_ROOT}/anna ${LOCATIONS_ROOT}/villa --update --from 1991-05`);
      const reopened = await client.execJson<{ relation: { from: string; to?: string }; movedIn: string; movedOut?: string }>(`attrs -L ${PEOPLE_ROOT}/anna/homes/villa`);
      assertEquals(reopened.relation.from, '1991-05');
      assertEquals(reopened.relation.to, undefined);
      assertEquals(reopened.movedIn, '1991-05');
      assertEquals(reopened.movedOut, undefined);
      // Both halves carry the relation, so the location agrees about the span.
      const peer = await client.execJson<{ relation: { from: string; to?: string } }>(`attrs -L ${LOCATIONS_ROOT}/villa/residents/anna`);
      assertEquals(peer.relation.from, '1991-05');
      assertEquals(peer.relation.to, undefined);

      // Nothing has drifted between the relation and its projection.
      await cmd.shouldSucceed('person-check');

      // A peer already gone is not a failure. relations-guard removes the second
      // half the moment it sees the first go, so an explicit removal can find it
      // missing.
      await cmd.shouldSucceed(`rm ${LOCATIONS_ROOT}/villa/residents/anna`);
      await cmd.shouldSucceed(`person-remove-home ${PEOPLE_ROOT}/anna ${LOCATIONS_ROOT}/villa`);
      await cmd.shouldFail(`stat ${PEOPLE_ROOT}/anna/homes/villa`);
      await cmd.shouldFail(`stat ${LOCATIONS_ROOT}/villa/residents/anna`);
    });

    await t.step('children lists the children/ dir', async () => {
      const children = await client.execJson<Array<{ name: string; path: string }>>(`person-children ${PEOPLE_ROOT}/anna`);
      assertEquals(children.map((c) => c.name).sort(), ['edvin', 'mia']);
    });

    await t.step('family-tree renders ancestors and descendants', async () => {
      const tree = await client.execString(`person-family-tree ${PEOPLE_ROOT}/john`);
      assertStringIncludes(tree, 'Ancestors:');
      assertStringIncludes(tree, 'Descendants:');
      assertStringIncludes(tree, 'Anna'); // anna's name attr, john's grandmother
    });

    await t.step('check clean, then flags broken reciprocity, fixup repairs', async () => {
      await cmd.shouldSucceed('person-check');

      await cmd.shouldSucceed(`rm ${PEOPLE_ROOT}/anna/children/mia`); // no guard in non-boot: orphan stays
      assertStringIncludes(await client.execString(`ls ${PEOPLE_ROOT}/mia/parents`), 'anna');
      assertEquals((await client.execString(`ls ${PEOPLE_ROOT}/anna/children`)).includes('mia'), false);

      await cmd.shouldFail('person-check');
      assertStringIncludes(await client.execString('person-fixup'), 'person fixup:');
      assertStringIncludes(await client.execString(`ls ${PEOPLE_ROOT}/anna/children`), 'mia');
      await cmd.shouldSucceed('person-check');
    });

    await t.step('mv keeps reciprocal paths; fixup rewrites a stale one from where the link resolves', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/dora --name Dora`);
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/olof --name Olof`);
      await cmd.shouldSucceed(`person-set-parent ${PEOPLE_ROOT}/dora ${PEOPLE_ROOT}/olof`);

      await cmd.shouldSucceed(`mv ${PEOPLE_ROOT}/dora ${PEOPLE_ROOT}/doris`);
      assertEquals((await client.execJson<{ softlink: string }>(`props -L ${PEOPLE_ROOT}/olof/children/dora`)).softlink, `${PEOPLE_ROOT}/doris`);
      const peerOf = async (link: string) => (await client.execJson<{ relation: { peerLink: string } }>(`attrs -L ${link}`)).relation.peerLink;
      assertEquals(await peerOf(`${PEOPLE_ROOT}/olof/children/dora`), `${PEOPLE_ROOT}/doris/parents/olof`);
      await cmd.shouldSucceed('person-check');

      await cmd.shouldSucceed(`attrs -L -J 'relation={"peerLink":"${PEOPLE_ROOT}/gone/parents/olof"}' ${PEOPLE_ROOT}/olof/children/dora`);
      await cmd.shouldFail('person-check');
      assertStringIncludes(await client.execString('person-fixup --dry-run'), 'rewrite peer');
      await cmd.shouldSucceed('person-fixup');
      await cmd.shouldFail(`ls ${PEOPLE_ROOT}/gone`);
      assertEquals(await peerOf(`${PEOPLE_ROOT}/olof/children/dora`), `${PEOPLE_ROOT}/doris/parents/olof`);
      assertEquals(await peerOf(`${PEOPLE_ROOT}/doris/parents/olof`), `${PEOPLE_ROOT}/olof/children/dora`);
      await cmd.shouldSucceed('person-check');

      await cmd.shouldSucceed(`rm -r ${PEOPLE_ROOT}/doris ${PEOPLE_ROOT}/olof`);
    });

    await t.step('check flags a died-before-born inconsistency', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/ghost --name Ghost --born 2000 --died 1990`);
      await cmd.shouldFail('person-check');
      await cmd.shouldSucceed(`rm -r ${PEOPLE_ROOT}/ghost`);
      await cmd.shouldSucceed('person-check');
    });

    await t.step('add + list events (blobs with body + child position)', async () => {
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/anna birth --type birth --date 1950-04-02 --body "Born in Stockholm" --lat=59.33 --lng=18.06`);
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/anna death --type death --date 2070-01-01`);
      const eventAttrs = await client.execJson<{ eventType: string; mimetype: string; name: string }>(`attrs ${PEOPLE_ROOT}/anna/events/birth`);
      assertEquals(eventAttrs.eventType, 'birth');
      assertEquals(eventAttrs.mimetype, 'text/markdown');
      // event is a file node (db tier) whose content is the body
      const props = await client.execJson<{ softlink?: string }>(`stat ${PEOPLE_ROOT}/anna/events/birth`);
      assertEquals((props as unknown as { type: string }).type, 'file');
      // geo lives in a child position node
      const loc = await client.execJson<{ lat: number; lng: number }>(`cat ${PEOPLE_ROOT}/anna/events/birth/position`);
      assertEquals(loc.lat, 59.33);
      const names = await client.execJson<string[]>(`ls ${PEOPLE_ROOT}/anna/events`);
      assertEquals(names.toSorted(), ['birth', 'death']);
      // a dated birth/death is mirrored onto the person, where the timeline reads it
      const personAttrs = await client.execJson<{ born?: string; died?: string }>(`attrs ${PEOPLE_ROOT}/anna`);
      assertEquals(personAttrs.born, '1950-04-02');
      assertEquals(personAttrs.died, '2070-01-01');
    });

    await t.step('add-event without a name makes one from the type and date, never reusing one', async () => {
      const added = await client.execJson<{ path: string }>(`person-add-event ${PEOPLE_ROOT}/anna --type engagement --date 1971-12-24`);
      assertEquals(added.path, `${PEOPLE_ROOT}/anna/events/engagement-1971-12-24`);
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/anna --type engagement --date 1971-12-24 --body "Second one"`);
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/anna --body "No date"`);
      const names = await client.execJson<string[]>(`ls ${PEOPLE_ROOT}/anna/events`);
      assertEquals(names.toSorted(), ['birth', 'death', 'engagement-1971-12-24', 'engagement-1971-12-24-2', 'event']);
      // The title is the body's first line; with no body, the name stands in.
      assertEquals((await client.execJson<{ name: string }>(`attrs ${PEOPLE_ROOT}/anna/events/engagement-1971-12-24-2`)).name, 'Second one');
      assertEquals((await client.execJson<{ name: string }>(`attrs ${PEOPLE_ROOT}/anna/events/engagement-1971-12-24`)).name, 'engagement-1971-12-24');
      await cmd.shouldSucceed(`rm ${PEOPLE_ROOT}/anna/events/engagement-1971-12-24 ${PEOPLE_ROOT}/anna/events/engagement-1971-12-24-2 ${PEOPLE_ROOT}/anna/events/event`);
    });

    await t.step('add-event --writer links the person who wrote the text, replacing the link when given again', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/tora --name Tora`);
      const writerOf = async (event: string) => (await client.execJson<{ softlink: string }>(`props -L ${event}/writer`)).softlink;

      const added = await client.execJson<{ path: string }>(`person-add-event ${PEOPLE_ROOT}/anna letter --date 1975 --body "A letter" --writer ${PEOPLE_ROOT}/tora`);
      assertEquals(await writerOf(added.path), `${PEOPLE_ROOT}/tora`);
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/anna letter --writer ${PEOPLE_ROOT}/anna`);
      assertEquals(await writerOf(added.path), `${PEOPLE_ROOT}/anna`);

      // Only a person can be the writer, and a refused one adds no event.
      await cmd.shouldFail(`person-add-event ${PEOPLE_ROOT}/anna --body "Unsigned" --writer ${PEOPLE_ROOT}/anna/events`);
      assertEquals((await client.execJson<string[]>(`ls ${PEOPLE_ROOT}/anna/events`)).toSorted(), ['birth', 'death', 'letter']);

      await cmd.shouldSucceed(`rm -r ${added.path} ${PEOPLE_ROOT}/tora`);
    });

    await t.step('check flags a birth or death event not mirrored onto born/died', async () => {
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/sven --name Sven --born 1930`);
      // An event that refines the attr agrees with it.
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/sven birth --type birth --date 1930-05-06`);
      await cmd.shouldSucceed(`attrs ${PEOPLE_ROOT}/sven -s born=1930`);
      await cmd.shouldSucceed('person-check');

      // A death recorded only as an event leaves `died` unset.
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/sven death --date 2001-02-03`);
      await cmd.shouldSucceed(`attrs ${PEOPLE_ROOT}/sven/events/death -s eventType=death`);
      await cmd.shouldFail('person-check');
      const kinds = async () => (JSON.parse(await client.execString('person-check; true')) as Array<{ kind: string }>).map((i) => i.kind);
      assertEquals(await kinds(), ['life-date-missing']);

      await cmd.shouldSucceed(`attrs ${PEOPLE_ROOT}/sven -s died=2001`);
      await cmd.shouldSucceed('person-check');
      await cmd.shouldSucceed(`attrs ${PEOPLE_ROOT}/sven -s born=1931`);
      assertEquals(await kinds(), ['life-date-drift']);

      await cmd.shouldSucceed(`rm -r ${PEOPLE_ROOT}/sven`);
      await cmd.shouldSucceed('person-check');
    });

    await t.step('person-info includes relations (gender-derived roles) and events', async () => {
      type PersonInfoResult = {
        name: string;
        relations: Array<{ role: string; path: string; name?: string }>;
        events: Array<{ eventType: string; date?: string }>;
      };
      const info = await client.execJson<PersonInfoResult>(`person-info ${PEOPLE_ROOT}/anna`);
      assertEquals(info.name, 'Anna');
      assertEquals(info.relations.find((r) => r.role === 'mother')?.path, `${PEOPLE_ROOT}/eva`);
      assertEquals(info.relations.find((r) => r.role === 'father')?.path, `${PEOPLE_ROOT}/karl`);
      assertEquals(info.relations.some((r) => r.role === 'partner' && r.path === `${PEOPLE_ROOT}/erik`), true);
      assertEquals(info.relations.some((r) => r.role === 'child'), true);
      assertEquals(info.events.some((e) => e.eventType === 'birth'), true);
    });
    await t.step('person-info carries age, contact and named homes', async () => {
      await cmd.shouldSucceed(`attrs ${PEOPLE_ROOT}/erik -s birthname=Ek`);
      const info = await client.execJson<{
        birthname?: string;
        age?: { years: number; approx: boolean; atDeath: boolean };
      }>(`person-info ${PEOPLE_ROOT}/erik`);
      assertEquals(info.birthname, 'Ek');
      // Born 1948 and still alive, so the age is counted to today and grows with
      // the calendar — asserting the number would be a test that expires.
      assertEquals(info.age?.atDeath, false);
      assertEquals(info.age !== undefined && info.age.years > 70, true);

      // A dead person's age is the one they reached, which is fixed.
      await cmd.shouldSucceed(`person-create ${PEOPLE_ROOT}/hilda --name Hilda --gender female --born 1900-03-01 --died 1971-09-15`);
      const hilda = await client.execJson<{ age: { years: number; atDeath: boolean } }>(`person-info ${PEOPLE_ROOT}/hilda`);
      assertEquals(hilda.age.years, 71);
      assertEquals(hilda.age.atDeath, true);

      // Homes report the location's name, not just its slug.
      await cmd.shouldSucceed(`person-set-home ${PEOPLE_ROOT}/anna ${LOCATIONS_ROOT}/villa --from 1990 --to 2000`);
      const anna = await client.execJson<{ homes: Array<{ path: string; name?: string; from?: string }> }>(`person-info ${PEOPLE_ROOT}/anna`);
      assertEquals(anna.homes[0].name, 'Villa');
      assertEquals(anna.homes[0].from, '1990');
    });

    await t.step('person-graph draws only edges it has both ends for', async () => {
      type Graph = {
        root: string;
        nodes: Record<string, {
          name: string;
          parents: string[];
          children: string[];
          partners: Array<{ path: string; kind?: string; from?: string }>;
          parentCount: number;
          childCount: number;
        }>;
      };

      const graph = await client.execJson<Graph>(`person-graph ${PEOPLE_ROOT}/anna --up 1 --down 1`);
      assertEquals(graph.root, `${PEOPLE_ROOT}/anna`);

      const anna = graph.nodes[`${PEOPLE_ROOT}/anna`];
      assertEquals(anna.parents.toSorted(), [`${PEOPLE_ROOT}/eva`, `${PEOPLE_ROOT}/karl`]);
      assertEquals(anna.children.toSorted(), [`${PEOPLE_ROOT}/edvin`, `${PEOPLE_ROOT}/mia`]);
      assertEquals(anna.partners.map((p) => p.path), [`${PEOPLE_ROOT}/erik`]);
      assertEquals(anna.partners[0].kind, 'married');

      // One generation down reaches mia, but not mia's own child — so her card
      // says there is more below without the graph carrying it.
      const mia = graph.nodes[`${PEOPLE_ROOT}/mia`];
      assertEquals(mia.children, []);
      assertEquals(mia.childCount, 1);

      // A partner comes in so the couple can be drawn, but is never walked
      // through: erik's children are anna's too and are already here, while his
      // parents are outside the slice entirely.
      assertEquals(graph.nodes[`${PEOPLE_ROOT}/erik`] !== undefined, true);
      assertEquals(graph.nodes[`${PEOPLE_ROOT}/john`], undefined);
    });

    await t.step('person-graph at depth 0 is the person and their partner', async () => {
      type Graph = { nodes: Record<string, { parents: string[]; parentCount: number }> };
      const graph = await client.execJson<Graph>(`person-graph ${PEOPLE_ROOT}/anna --up 0 --down 0`);
      assertEquals(Object.keys(graph.nodes).toSorted(), [`${PEOPLE_ROOT}/anna`, `${PEOPLE_ROOT}/erik`]);
      // Nothing drawn above her, but the count still says there is something.
      assertEquals(graph.nodes[`${PEOPLE_ROOT}/anna`].parents, []);
      assertEquals(graph.nodes[`${PEOPLE_ROOT}/anna`].parentCount, 2);
    });

    await t.step('person-graph --only is the person and the people named; --to the line of relations between two', async () => {
      type Graph = { nodes: Record<string, { parents: string[]; children: string[]; parentCount: number }> };
      const [anna, karl, mia] = ['anna', 'karl', 'mia'].map((slug) => `${PEOPLE_ROOT}/${slug}`);

      // No walk and no partner: erik and eva are anna's, but not asked for.
      const only = await client.execJson<Graph>(`person-graph ${anna} --only ${karl}`);
      assertEquals(Object.keys(only.nodes).toSorted(), [anna, karl]);
      assertEquals(only.nodes[anna].parents, [karl]);
      // The counts are still the real ones.
      assertEquals(only.nodes[anna].parentCount, 2);

      const line = await client.execJson<Graph>(`person-graph ${mia} --to ${karl}`);
      assertEquals(Object.keys(line.nodes).toSorted(), [anna, karl, mia]);
      assertEquals(line.nodes[mia].parents, [anna]);
      assertEquals(line.nodes[anna].parents, [karl]);
    });

    await t.step('person-timeline merges life, homes, partnership and children', async () => {
      type Feed = { entries: Array<{ kind: string; key: string; date: string; title: string; eventType?: string; description?: string; location?: string }> };
      const feed = await client.execJson<Feed>(`person-timeline ${PEOPLE_ROOT}/anna`);
      const at = (date: string) => feed.entries.filter((e) => e.date === date);

      // Newest first, like every other feed here.
      assertEquals(feed.entries[0].date, '2070-01-01');
      assertEquals(feed.entries.at(-1)?.date, '1950-04-02');

      // The birth comes from the attr; its body and location come from the event
      // file, folded onto it rather than arriving as a second entry.
      const birth = at('1950-04-02');
      assertEquals(birth.length, 1);
      assertEquals(birth[0].kind, 'birth');
      assertStringIncludes(birth[0].description ?? '', 'Born in Stockholm');
      assertEquals(birth[0].location, `${PEOPLE_ROOT}/anna/events/birth/position`);

      // A residence is a span, so it becomes its two ends.
      // The same kind the corpus-wide feed emits for the same residence, so a
      // move reads identically on either page.
      assertEquals(at('1990')[0].kind, 'move');
      assertEquals(at('1990')[0].eventType, 'moved-in');
      assertEquals(at('2000')[0].kind, 'move');
      assertEquals(at('2000')[0].eventType, 'moved-out');

      assertEquals(at('1972-05-20')[0].eventType, 'marriage');
      assertEquals(at('1990-01-01')[0].eventType, 'separation');

      // Each child's birth, owned by the child so the card links to them.
      assertStringIncludes(at('1975-06-01')[0].title, 'mia');
      assertEquals(at('1975-06-01')[0].kind, 'birth');

      // --no-albums drops the expensive half and nothing else. There is no media
      // here, so the two answers match; what is asserted is that the flag is
      // wired to the album source alone.
      const quick = await client.execJson<Feed>(`person-timeline ${PEOPLE_ROOT}/anna --no-albums`);
      assertEquals(quick.entries.map((e) => e.key), feed.entries.map((e) => e.key));
      assertEquals(quick.entries.some((e) => e.kind === 'album'), false);
    });

    await t.step('location-timeline shows who came and went, pointing at them', async () => {
      type Feed = { location: string; name: string; entries: Array<{ kind: string; date: string; title: string; path: string; eventType?: string; ownerPath?: string }> };
      // A story written on the location itself, as the importer leaves some.
      await cmd.shouldSucceed(
        `mkdir -p ${LOCATIONS_ROOT}/villa/events && mknode -t file ${LOCATIONS_ROOT}/villa/events/fire --as date=1995-03-01 --as name=Fire --as eventType=generic`,
      );

      const feed = await client.execJson<Feed>(`location-timeline ${LOCATIONS_ROOT}/villa --no-albums`);
      assertEquals(feed.name, 'Villa');
      assertEquals(feed.entries.map((e) => e.date), ['2000', '1995-03-01', '1990']);

      const [left, fire, arrived] = feed.entries;
      assertEquals(arrived.eventType, 'moved-in');
      assertEquals(left.eventType, 'moved-out');
      // The same title the person-side entry has, but the card leads to the
      // person: on the location's own page, the location is where the reader is.
      assertEquals(arrived.title, 'Anna moved to Villa');
      assertEquals(arrived.path, `${PEOPLE_ROOT}/anna`);
      assertEquals(fire.kind, 'event');
      assertEquals(fire.ownerPath, `${LOCATIONS_ROOT}/villa`);

      await cmd.shouldFail(`location-timeline ${LOCATIONS_ROOT}/nowhere`);
    });

    await t.step('a wedding recorded twice appears once, naming both spouses', async () => {
      type Feed = { entries: Array<{ kind: string; date: string; title: string; eventType?: string; people?: string[]; description?: string }> };

      // The archive holds the wedding under one spouse — as an event file with a
      // story in it — and on the relation itself, which is what puts it on the
      // other spouse's page too. Both are the same day.
      await cmd.shouldSucceed(`person-add-event ${PEOPLE_ROOT}/anna wedding --type marriage --date 1972-05-20 --body "Gifta i Storkyrkan"`);

      const hers = await client.execJson<Feed>(`person-timeline ${PEOPLE_ROOT}/anna --no-albums`);
      const day = hers.entries.filter((entry) => entry.date === '1972-05-20');
      assertEquals(day.length, 1);
      // The event survives — it is the half with a body — and takes the second
      // person from the relation, which is the only place the archive says it.
      assertStringIncludes(day[0].description ?? '', 'Storkyrkan');
      assertEquals(day[0].people?.toSorted(), [`${PEOPLE_ROOT}/anna`, `${PEOPLE_ROOT}/erik`]);

      // Erik has no event file; the relation is the whole of his wedding.
      const his = await client.execJson<Feed>(`person-timeline ${PEOPLE_ROOT}/erik --no-albums`);
      const hisDay = his.entries.filter((entry) => entry.date === '1972-05-20');
      assertEquals(hisDay.length, 1);
      // No `name` on Erik's node in this fixture, so the basename stands in.
      assertEquals(hisDay[0].title, 'erik and Anna married');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
