// nowcast/model.js - the Nowcast's model interface. The radar reader, the place lookup, the summary and the map only use what is
// here: a model's spec (its input product, grid, frames and cadence; its output frames; its credit and licence) and run(inputs) ->
// frames. Another nowcast model (another grid, other inputs) drops in as one more entry with its own engine behind the same calls.

/** DeepMind's DGMR (Deep Generative Model of Rainfall), the 256 x 256 TF-Hub snapshot */
export const DGMR = {
  id: 'dgmr',
  name: 'DGMR',
  // inputs: MRMS rain rate on a local projection centred on the place, 4 frames 5 minutes apart, the newest at t0
  inputs: { product: 'rate', offsetsMin: [-15, -10, -5, 0], grid: { size: 256, km: 1, projection: 'local' }, units: 'mm/h', clip: [0, 128], scale: 1 / 32 },
  // outputs: 18 frames of rain rate, +5 to +90 minutes; a GAN: each member (latent) is one possible future, so it runs as an ensemble
  outputs: { frames: 18, firstMin: 5, everyMin: 5, grid: { size: 256, km: 1 }, units: 'mm/h', kind: 'rain' },
  ensemble: { members: 4, seed: 1 },
  precisions: ['float', 'int8'],   // float = the most accurate (default); int8 = less memory
  credit: 'Nowcast: DeepMind DGMR (CC BY 4.0), modified',
  creditLong: 'Nowcast model: DeepMind DGMR (CC BY 4.0), modified',
  licence: { id: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', source: 'https://github.com/google-deepmind/deepmind-research/tree/master/nowcasting',
    holder: 'Copyright 2021 DeepMind Technologies Limited',
    changes: 'Modified for this app: the weights converted to 16-bit floats (the full model) or quantised to 8-bit integers (the low-memory model), and run as WebGPU kernels.' },
  trainedOn: 'UK radar',
  label: 'Experimental · trained on UK radar',
};
export const MODELS = { dgmr: DGMR };
/** the minutes of output frame k (0-based) */
export const leadMin = (spec, k) => spec.outputs.firstMin + k * spec.outputs.everyMin;
