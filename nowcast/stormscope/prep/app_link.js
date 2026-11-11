// nowcast/stormscope/prep/app_link.js - the ONE place that points at the app's own modules (moved into the app for v056). lcc.js (the HRRR Lambert grid) reproduces stormscope/lat.npy and lon.npy bit-exactly after float32 rounding (all
// 1,835,008 crop pixels, chk_lcc.mjs); grib2.js is the app's MRMS GRIB2 (template 5.41, PNG) reader.
export { hrrrLatLon, hrrrIJ, cropRC, HRRR } from '../lcc.js';
export { readGrib2, decodePngRows, gunzip, codeAt, pngHeader } from '../../grib2.js';
