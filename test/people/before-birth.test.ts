import { assertEquals } from '@std/assert';
import { takenBeforeBirth } from '@archive/people/before-birth';

Deno.test('takenBeforeBirth: only a photo surely older than the birth', () => {
  const cases: [string, unknown, string, unknown, boolean][] = [
    ['2017-08-01T18:14:39+02:00', undefined, '2018-04-18T10:34', undefined, true],
    ['2018-04-17', undefined, '2018-04-18', undefined, true],
    // The day of the birth, or a month or year that holds it, may show them.
    ['2018-04-18T09:00:00+02:00', undefined, '2018-04-18T10:34', undefined, false],
    ['2018-04', undefined, '2018-04-18', undefined, false],
    ['2018', undefined, '2018-04-18', undefined, false],
    // A birth known to the month or the year starts at its first day.
    ['2018-03-31', undefined, '2018-04', undefined, true],
    ['2017-12', undefined, '2018', undefined, true],
    // About stretches either date two years towards "could be"; before has no lower bound.
    ['2015', undefined, '2018', 'about', true],
    ['2016', undefined, '2018', 'about', false],
    ['2015', 'about', '2018', undefined, true],
    ['2016', 'about', '2018', undefined, false],
    ['1990', undefined, '2018', 'before', false],
    ['2017', undefined, '2018', 'after', true],
    // Without either date nothing is ruled out.
    ['', undefined, '2018', undefined, false],
    ['2017', undefined, '', undefined, false],
  ];
  for (const [takenAt, takenAtQualifier, born, bornQualifier, expected] of cases) {
    assertEquals(takenBeforeBirth({ takenAt, takenAtQualifier }, { born, bornQualifier }), expected, `${takenAt} ${takenAtQualifier ?? ''} / ${born} ${bornQualifier ?? ''}`);
  }
});
