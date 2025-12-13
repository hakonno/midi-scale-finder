export { readMidi, midiToNoteName };

const SCALES = {
    "Major":       [0, 2, 4, 5, 7, 9, 11],
    "Minor":       [0, 2, 3, 5, 7, 8, 10]
};

// Helper function to convert MIDI note number to note name
function midiToNoteName(pc) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    return names[pc];
}

// build scale by adding intervals to root
function buildScale(root, intervals) {
    return intervals.map(i => (root + i) % 12); 
}
    
// check if all used notes are in the scale
// every note must exist in the scale
function scaleMatches(scaleNotes, usedNotes) {
    return usedNotes.every(note => scaleNotes.includes(note));
}

function readMidi(arrayBuffer, onResult) {
    const midi = new Midi(arrayBuffer); // using library to parse MIDI

    // key = pitch class (0-11), value = total length
    const noteWeights  = new Map();

    // Extract MIDI note numbers from all tracks
    midi.tracks.forEach(track => {
        track.notes.forEach(note => {
            const pc = note.midi % 12;
            const duration = note.duration;
            
            noteWeights.set(
                pc, 
                (noteWeights.get(pc) || 0) + duration
            );
        });
    });

    const usedNotes = [...noteWeights.keys()]
        .sort((a, b) => a - b) // Sort pitch classes numerically

    let tonic = null;
    let maxWeight = 0;
    noteWeights.forEach((weight, pc) => {
        if (weight > maxWeight) {
            maxWeight = weight;
            tonic = pc;
        }
    });

    const matches = findMatchingScalesWeighted(
        usedNotes,
        noteWeights,
        tonic
    );

    if (onResult) {
        onResult(usedNotes, noteWeights, matches, tonic);
    }
}

// Find matching scales with weighted scoring
function findMatchingScalesWeighted(usedNotes, noteWeights, tonic) {
    const results = []; // to store scale match results

    // Iterate over all possible roots (0-11)
    for (let root = 0; root < 12; root++) {
        for (const [name, intervals] of Object.entries(SCALES)) {
            const scale = buildScale(root, intervals); // build scale notes

            let explained = 0;  // total weight of notes explained by the scale
            let missing = 0;    // total weight of notes not in the scale

            usedNotes.forEach(pc => {
                const weight = noteWeights.get(pc);

                let weighted = weight;

                // scale degree weighting
                if (pc === root) weighted *= 1.4;                    // tonic
                if (pc === (root + 7) % 12) weighted *= 1.25;        // dominant (5)
                if (pc === (root + 3) % 12 || pc === (root + 4) % 12)
                    weighted *= 1.15;                                // minor/major third

                if (scale.includes(pc)) {
                    explained += weighted;    // note is in the scale
                } else {
                    missing += weight;      // note is not in the scale
                }
            });

            let bonus = 0;      // bonus for root note presence

            if (root === tonic) {
                bonus = explained * 0.15; // 15 % boost?
            }

            results.push({
                root,
                name,
                score: explained + bonus,
                missing,
                tonicMatch: root === tonic
            });
        }
    }

    // Sorting:
    // 1. Highest explained weight
    // 2. Lowest missing weight
    results.sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        return a.missing - b.missing;
    });
    
    return results;
}


// testing
function isCorrectPrediction(matches, trueRoot, trueMode) {
    // check top 2 suggestions
    return matches.slice(0, 2).some(m => 
        m.root === trueRoot && m.name === trueMode
    );
}