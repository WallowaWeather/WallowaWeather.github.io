// config.js - Wallowa Weather's model packs: each address next to the sha256 of its manifest.json (engine/core/pin.js checks every
// manifest against it before it is used or kept; the manifest pins every 16 MiB chunk). Every pack downloads from Hugging Face at a
// pinned revision, with its licence and notice beside it. When a pack moves only its address changes here; the pin stays the manifest's
// sha256.
(function () {
  'use strict';
  var HF = 'https://huggingface.co/';
  var PACKS = {
    'dgmr-nowcast': [HF + 'JoshHughes/wallowa-weather-dgmr/resolve/01f2f30da01564b3a74928660e04f539efbdb513/', 'aa85bbb896e1bdc31107cca8a1d8b20c4a5cec3070a28e0079fa0bdb6392e179', { 'f16/': '318033bfa105a7f8879a68312f3583ea60298ca60524c770fa24b7f590d8f5d3' }],
    'stormscope-mrms': [HF + 'JoshHughes/wallowa-weather-stormscope/resolve/12dfe4bc575ad4adecfbba040d6fffea04a9d48f/', '4381f661b29e4c1a52fe715298d8b173dac4ac9067faad4b5959a91e3f6595d9'],
    'beam': [HF + 'JoshHughes/wallowa-weather-beam/resolve/0f77e76e34b7a5a5e3e9deb5f23cba183d59837a/', 'b4b7d3371b90e694d7a37fe8456a8e302d1a843248367cff6cc76144596529d1']
  };
  var packs = {}, pins = {};
  for (var k in PACKS) { packs[k] = PACKS[k][0]; pins[k] = PACKS[k][1]; var sub = PACKS[k][2] || {}; for (var s in sub) pins[k + '/' + s] = sub[s]; }
  // publicUrl: the app's public address, set for a public release (a field report's public post may carry it); empty on a test server, so
  // a post never carries the address the app happens to be served from
  window.P0_CONFIG = { packs: packs, manifestSha256: pins, publicUrl: 'https://wallowaweather.github.io/' };
})();
