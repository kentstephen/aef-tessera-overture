/**
 * WGS84 to UTM, northern hemisphere form (EPSG:326zz) everywhere: TESSERA's
 * zone groups use it even south of the equator, where northings run negative.
 * Krueger's series to n^6 (Karney 2011), well under a millimeter inside a zone.
 */
const A_ = 6378137;
const F_ = 1 / 298.257223563;
const N_ = F_ / (2 - F_);
const K0 = 0.9996;
const E0 = 500000;
const n2 = N_ * N_, n3 = n2 * N_, n4 = n3 * N_, n5 = n4 * N_, n6 = n5 * N_;
const AR = (A_ / (1 + N_)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const ALPHA = [
  N_ / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
  (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
  (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
  (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
  (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
  (212378941 * n6) / 319334400,
];
const E2N = (2 * Math.sqrt(N_)) / (1 + N_);
const RAD = Math.PI / 180;

/** The UTM zone (1 to 60) of a longitude. */
export function zoneOf(lon: number): number {
  return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
}

/** Easting and northing (meters) of a point in a zone, written to out. */
export function toUtm(lon: number, lat: number, zone: number, out: Float64Array | number[]): void {
  const phi = lat * RAD;
  const dl = (lon - ((zone - 1) * 6 - 180 + 3)) * RAD;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E2N * Math.atanh(E2N * s));
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1];
    x += a * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    y += a * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  out[0] = E0 + K0 * AR * x;
  out[1] = K0 * AR * y;
}
