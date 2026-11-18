// A QR code as SVG markup (the uqr encoder; drawing it here keeps it one crisp path).

import { encode } from 'uqr';

/** SVG for `text`: dark modules on white, with the standard four-module quiet zone. */
export function qrSvg(text: string): string {
  const { data, size } = encode(text, { ecc: 'M', border: 4 });
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y][x]) continue;
      // Join runs of dark modules on a row into one rectangle.
      let run = 1;
      while (x + run < size && data[y][x + run]) run++;
      path += `M${x} ${y}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
