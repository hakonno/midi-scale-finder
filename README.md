# MIDI Scale Finder
- try it: [midi.hakono.me](https://midi.hakono.me/)
- Uses MIDI.js from https://unpkg.com/@tonejs/midi@2.0.28/build/Midi.js
- Only Major/Minor are considered for now; relative pairs can flip (e.g., C Major vs A Minor).
- About (≈88%) accuracy on a small labeled set.
- Internal tester lives at [midi.hakono.me/test.html](https://midi.hakono.me/test.html) (hidden tuner, filename must contain key/mode like `C_Major.mid`).
