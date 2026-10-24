/**
 * XMP sidecars (`@archive/media/xmp`): a packet read in both RDF spellings, the capture time at the
 * precision written and never the file's creation date, the GPS position, title, caption, rating,
 * label and keywords; and a folder's `.xmp` files paired by name, a shared stem going to the RAW.
 *
 * Every packet here is invented.
 */
import { assertEquals } from '@std/assert';
import { matchXmp, parseXmp, xmpDate } from '@archive/media/xmp';

/** Lightroom's spelling: properties as attributes, lists as elements. */
const ATTRIBUTES = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmp:CreateDate="2024-03-02T10:11:12"
   xmp:Rating="4"
   xmp:Label="Red"
   photoshop:DateCreated="1968-07"
   exif:GPSLatitude="57,42.0N"
   exif:GPSLongitude="11,57.0E">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Sommarstugan</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Anna &amp; Bo vid bryggan</rdf:li></rdf:Alt></dc:description>
   <dc:subject><rdf:Bag><rdf:li>sjö</rdf:li><rdf:li>segelbåt</rdf:li><rdf:li>sjö</rdf:li></rdf:Bag></dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/** darktable's spelling: every property an element. */
const ELEMENTS = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="">
<exif:DateTimeOriginal>2019-06-01T12:34:56.120+02:00</exif:DateTimeOriginal>
<exif:GPSLatitude>33,51,54.5S</exif:GPSLatitude>
<exif:GPSLongitude>151,12,36W</exif:GPSLongitude>
<xmp:Rating>-1</xmp:Rating>
</rdf:Description></rdf:RDF></x:xmpmeta>`;

Deno.test('a packet in attributes gives its date at its own precision, never the creation date', () => {
  assertEquals(parseXmp(ATTRIBUTES), {
    kind: 'xmp',
    wallClock: '1968-07',
    where: { lat: 57.7, lng: 11.95 },
    title: 'Sommarstugan',
    description: 'Anna & Bo vid bryggan',
    rating: 4,
    label: 'Red',
    keywords: ['sjö', 'segelbåt'],
  });
});

Deno.test('a packet in elements is read the same; a southern and western position is negative', () => {
  const read = parseXmp(ELEMENTS);
  assertEquals(read?.wallClock, '2019-06-01T12:34:56+02:00');
  assertEquals(read?.rating, -1);
  assertEquals([read?.where?.lat.toFixed(4), read?.where?.lng.toFixed(4)], ['-33.8651', '-151.2100']);
});

Deno.test('XMP dates in their forms; anything else is no date', () => {
  assertEquals(xmpDate('1968'), '1968');
  assertEquals(xmpDate('1968-07-14'), '1968-07-14');
  assertEquals(xmpDate('2019-06-01T12:34+02:00'), '2019-06-01T12:34+02:00');
  assertEquals(xmpDate('2019-06-01T12:34:56Z'), '2019-06-01T12:34:56Z');
  assertEquals(xmpDate('2019:06:01 12:34:56'), '2019-06-01T12:34:56');
  assertEquals(xmpDate('0000:00:00 00:00:00'), undefined);
  assertEquals(xmpDate('last summer'), undefined);
});

Deno.test('text that is no XMP packet is nothing', () => {
  assertEquals(parseXmp('{"title": "IMG_0001.jpg"}'), undefined);
  assertEquals(parseXmp('<html><body>no</body></html>'), undefined);
});

Deno.test('an XMP file pairs by the whole name, then by the stem, a stem shared by a RAW and a JPEG going to the RAW', () => {
  const media = [
    { name: 'IMG_0001.jpg', mimetype: 'image/jpeg' },
    { name: 'DSC_0002.NEF', mimetype: 'image/x-nikon-nef' },
    { name: 'DSC_0002.jpg', mimetype: 'image/jpeg' },
    { name: 'scan0003.tif', mimetype: 'image/tiff' },
    { name: 'IMG_0004.jpg', mimetype: 'image/jpeg' },
    { name: 'IMG_0004.png', mimetype: 'image/png' },
  ];
  assertEquals(Object.fromEntries(matchXmp(['IMG_0001.jpg.xmp', 'DSC_0002.xmp', 'scan0003.XMP', 'IMG_0004.xmp', 'IMG_0009.xmp'], media)), {
    'IMG_0001.jpg.xmp': 'IMG_0001.jpg',
    'DSC_0002.xmp': 'DSC_0002.NEF',
    'scan0003.XMP': 'scan0003.tif',
  });
  // A file takes one: the whole name first, the stem's only when the file is still free.
  assertEquals(Object.fromEntries(matchXmp(['IMG_0001.xmp', 'IMG_0001.jpg.xmp'], media)), { 'IMG_0001.jpg.xmp': 'IMG_0001.jpg' });
});
