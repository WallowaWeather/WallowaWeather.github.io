// nowcast/stormscope/prep/index.js - PILOT (v056): StormScope's inputs built on the phone (NOAA MRMS, GOES-East ABI + GLM), matching
// Derived from NVIDIA Earth2Studio, earth2studio/models/px/stormscope.py (the input preparation). Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES, Apache License 2.0 (licenses/Apache-2.0.txt); re-implemented in JavaScript and changed for this app.
// NVIDIA Earth2Studio's own preparation (checked against it: GOES / MRMS / static bit-exact, GLM and cos-zenith within one float32 ulp).
export { prepareStormScope, loadGrid } from './cond.js';
