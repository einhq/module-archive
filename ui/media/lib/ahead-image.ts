/**
 * An image for a picture fetched ahead of being shown, hidden in the document; `remove()` it once
 * it has loaded or failed. Chromium never lets go of an `<img>` with a `srcset` that was made
 * outside the document: it stays listed to pick its file again when the window changes size, with
 * its picture, for as long as the page lives, and a slideshow on a screen fetches one for every
 * slide to come. One in the document picks its file from `srcset` and `sizes` as the frame that
 * will show it does (`sizes` is of the window, not of a box), and is let go once taken out.
 */
export function aheadImage(): HTMLImageElement {
  const image = new Image();
  image.alt = '';
  image.hidden = true;
  document.body.append(image);
  return image;
}
