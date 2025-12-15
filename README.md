# MIDI Scale Finder

Find the most likely **key/scale of a MIDI file** (currently **Major/Minor only**) directly in your browser.

Live site: https://midi.hakono.me/

## What the website does

- You drop in a `.mid` / `.midi` file.
- It reads all note events (across all tracks), reduces them to pitch classes (C…B), and estimates the most likely **tonic + mode**.
- It shows:
	- a single **best guess** (e.g. “E Minor”) with a rough confidence label
	- a short list of alternatives
	- a collapsible list of *every* Major/Minor scale that contains the detected pitch set (“fits these notes”)

This is meant for quick “what key is this MIDI in?” checks for melodies and chord progressions.

## How it works

Everything runs client-side.

1. **Parse MIDI** using the Tone.js MIDI parser (vendored as `Midi.js`).
2. Build `noteWeights`: `pitchClass -> totalDuration` (duration is summed over the whole file).
3. Score all **24 candidates** (12 roots × Major/Minor):
	 - add points for notes that are inside the scale
	 - boost “important” degrees (tonic, dominant, subdominant, the mode-defining third)
    	 - the boost values are tuned with `tune.js` to maximize accuracy on a small(!) labeled set of 640 chord progressions.
	 - subtract a penalty for notes outside the scale (and an extra penalty for the “wrong” third)
4. Sort by score and display the top result.

The “confidence” shown in the UI is a heuristic derived from the score/penalty numbers. It is not statistically calibrated.

## Limitations

- **Major/Minor only.** No modes, harmonic/melodic minor, blues scales, etc.
- **Relative major/minor can flip** (same pitch set). The weighted scoring tries to pick a tonic.
- **Key changes/modulation**: it assumes one key for the whole file.
- MIDI with lots of chromatic passing tones, borrowed chords, or dense percussion can confuse it (it currently doesn’t ignore drums).

On a small labeled set, it’s been about **~88% top-1 accuracy**. more testing should be done.

## Contributing

This is a static site.

- Main UI: `index.html`, `script.js`
- Detection logic: `scaleDetector.js`
- MIDI parser: `Midi.js` (from https://unpkg.com/@tonejs/midi@2.0.28/build/Midi.js)

### Run locally

Because the app uses ES modules (`<script type="module">`), you’ll usually want a local server (not `file://`). For example:

```bash
python -m http.server
```

Then open `http://localhost:8000/`.

### Test / tune the scoring

- `test.html` is an internal evaluator (and optional in-browser grid search tuner).
	- Filenames must contain key + mode, e.g. `C_Major.mid` or `G#Minor_MyChords.mid`.
- `tune.js` is a Node script used to grid-search the scoring multipliers offline.

