# MIDI Scale Finder

Tiny web page to guess the key (tonic + Major/Minor) of a MIDI file.

- Open [index.html](index.html) in a browser.
- Drag a `.mid`/`.midi` file onto the big drop zone.
- The result shows the tonic and whether it leans Major or Minor.

Notes
- Only Major/Minor are considered; relative pairs can flip (e.g., C Major vs A Minor).
- Heuristic detector, tested 565/640 (≈88%) on a small labeled set.
- Internal tester lives at [test.html](test.html) (hidden tuner, filename must contain key/mode like `C_Major.mid`).
