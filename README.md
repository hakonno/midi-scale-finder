# MIDI Scale Finder

Find the most likely **key/scale** (currently **Major/Minor only**) from either:

- a dropped/uploaded `.mid` / `.midi` file,
- a set of notes you pick manually (click the piano), including a computer-keyboard “piano mode”, or
- a hardware MIDI keyboard (Web MIDI; Chrome/Edge/Firefox).

Live site: https://midi.hakono.me/

## What the website does

- You can upload a `.mid` / `.midi` file, or build a note set by selecting notes on the piano (mouse/touch/keyboard).
- It reduces notes to pitch classes (C…B) and estimates the most likely **tonic + mode**.
- It shows a ranked list of candidate Major/Minor keys, with a **best guess** highlighted.

This is meant for quick “what key is this in?” checks for melodies, chord progressions, or any small set of notes.

## How it works

Everything runs client-side.

1. **Parse MIDI** using the Tone.js MIDI parser (vendored as `Midi.js`).
2. Build `noteWeights`: `pitchClass -> weight`.
	- For MIDI upload: weight is total note duration across the whole file.
	- For manual note selection: weights are neutral (all selected notes count equally).
3. Score all **24 candidates** (12 roots × Major/Minor):
	 - add points for notes that are inside the scale
	 - boost “important” degrees (tonic, dominant, subdominant, the mode-defining third)
    	 - the boost values are tuned with `tune.js` to maximize accuracy on a small(!) labeled set of 640 chord progressions.
	 - subtract a penalty for notes outside the scale (and an extra penalty for the “wrong” third)
4. Sort by score and display the top result.

The “match %” shown in the UI means “how much of the input is inside the key” (by duration for MIDI, or by count for manual selection). It’s a descriptive metric, not a calibrated probability.

## Limitations

- **Major/Minor only.** No modes, blues scales, etc. The raised 7th (leading tone) in minor gets a reduced penalty, so harmonic-minor material is detected as the right Minor key.
- **Relative major/minor can flip** (same pitch set). The weighted scoring tries to pick a tonic.
- **Key changes/modulation**: it assumes one key for the whole file.
- MIDI with lots of chromatic passing tones or borrowed chords can confuse it. Percussion tracks (MIDI channel 10) are ignored.

On the 640-file labeled set it reaches **86.6% top-1** (98.4% top-2) for Major/Minor, and **100% top-1** on 300 harmonic-minor progressions. More testing on real songs should be done.

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
- `tune.js` is a Node script used to grid-search the scoring multipliers offline:

```bash
npm install
node tune.js <path-to-midi-folder>
```

The folder must contain `.mid` files named like `C_Major_...mid` / `A_Minor_...mid`. The original training set is the Major/Minor files from https://github.com/BenLeon2001/Free-Chord-Progressions (640 files).
## Piano audio

The piano uses stereo Salamander Grand Piano v3 recordings by Alexander Holm
([source](https://github.com/sfzinstruments/SalamanderGrandPiano), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)).
The app uses velocity layers 4, 9, and 15, shortened, faded where trimmed, and
encoded to MP3 at 44.1 kHz. Nearby notes are transposed from the closest
recording. The full set is about 7.6 MB on disk. The browser loads a middle
register layer when audio is first activated and fetches other recordings
as needed. The visible octave starts loading in the background when the
page opens. Playback waits for a pending recording and uses a synthesized
voice if the recording is unavailable. MIDI note releases and sustain pedal messages
control how long the sound rings.
