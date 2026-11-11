// nowcast/skill.js - "How accurate is this?": only what was measured, nothing more. The evaluation (Nov 2026): 12 cases of recorded
// NOAA MRMS radar from May 2025 to Nov 2026 across the lower 48 (7 with thunderstorms, 2 mixed, 3 steady rain), each 256 x 256 km, the
// model's 4 runs (seed 1) scored against the radar that came later. CSI = hits / (hits + misses + false alarms) for rain over a rate.
const row = (name, v) => [name, ...v.map((x) => x.toFixed(2))];
export const SKILL = {
  intro: [
    'The nowcast is DeepMind\'s DGMR, trained on UK radar. This app runs it on US radar from NOAA as an experiment. These are the scores we measured on 12 past US cases (7 with thunderstorms), checking each nowcast against the radar that came later.',
    'The score is the critical success index (CSI): of all the places where the nowcast or the radar had rain over a rate, the share where both had it. 1 is perfect, 0 is no skill. "Persistence" is the simple guess that the rain stays where it is now: a nowcast only helps where it beats that.',
  ],
  tables: [
    { title: 'All 12 cases: rain over 1 mm/h (light)', head: ['', '+10 min', '+30', '+60', '+90'],
      rows: [row('Nowcast (4 runs)', [0.858, 0.784, 0.711, 0.654]), row('Low-memory model', [0.855, 0.782, 0.703, 0.641]), row('Persistence', [0.802, 0.676, 0.577, 0.507])] },
    { title: 'All 12 cases: over 4 mm/h (moderate)', head: ['', '+10 min', '+30', '+60', '+90'],
      rows: [row('Nowcast (4 runs)', [0.638, 0.515, 0.393, 0.322]), row('Low-memory model', [0.636, 0.519, 0.397, 0.321]), row('Persistence', [0.519, 0.374, 0.276, 0.216])] },
    { title: 'All 12 cases: over 8 mm/h (heavy)', head: ['', '+10 min', '+30', '+60', '+90'],
      rows: [row('Nowcast (4 runs)', [0.544, 0.375, 0.251, 0.132]), row('Low-memory model', [0.544, 0.372, 0.220, 0.112]), row('Persistence', [0.389, 0.217, 0.140, 0.112])],
      note: 'By 90 minutes, heavy rain is barely better than persistence (and the low-memory model not at all).' },
    { title: 'The 7 thunderstorm cases: over 8 mm/h (heavy)', head: ['', '+10 min', '+30', '+60', '+90'],
      rows: [row('Nowcast (4 runs)', [0.538, 0.361, 0.263, 0.149]), row('Persistence', [0.372, 0.184, 0.113, 0.091])] },
  ],
  outro: [
    'Its rain fades faster than real rain: measured against the radar that came later, the strongest 5% of its rain is about 20% weaker by +30 minutes, 30% by +60 and 40% by +90, while its rain area is 15-20% too wide. Light rain can fade much faster: on one drizzly night (Nov 2) every run had lost about half of the rain by +30 minutes, while the rain on the radar stayed steady.',
    'It usually draws heavy rain cores too small: in one storm case, 60 minutes ahead, the radar had about 6,300 km² of rain over 20 mm/h and the nowcast about 1,200 km². So a "light" or "moderate" nowcast can still turn out heavy.',
    'In 2 of the 12 cases persistence did better at some rates (steady rain near Puget Sound; heavy rain in Tennessee). The scores come from one set of 12 cases and one seed; your place and day can differ.',
    'For warnings, follow the National Weather Service and your local officials. This nowcast is experimental.',
  ],
};
