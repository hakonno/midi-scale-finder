export { readMidi, midiToNoteName };

const SCALES = {
    "Major":       [0, 2, 4, 5, 7, 9, 11],
    "Minor":       [0, 2, 3, 5, 7, 8, 10]
};

// Helper function to convert MIDI note number to note name
function midiToNoteName(pc) {
    const names = ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"];
    return names[pc];
}

// build scale by adding intervals to root
function buildScale(root, intervals) {
    return intervals.map(i => (root + i) % 12); 
}

function getModeCharacteristicNotes(root, mode) {
    if (mode === "Major") {
        return {
            characteristic: (root + 4) % 12,  // major third
            avoid: (root + 3) % 12            // minor third
        };
    } else if (mode === "Minor") {
        return {
            characteristic: (root + 3) % 12,  // minor third
            avoid: (root + 4) % 12            // major third
        };
    }
    return null;
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

    const matches = findMatchingScalesWeighted(
        usedNotes,
        noteWeights
    );

    const tonic = matches[0]?.root ?? 0;

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

            let score  = 0;  // total weight of notes explained by the scale
            let penalty = 0;    // total weight of notes not in the scale

            usedNotes.forEach(pc => {
                const weight = noteWeights.get(pc);

                if (scale.includes(pc)) {
                    // Note IS in the scale
                    const scaleDegree = (pc - root + 12) % 12;
                    
                    // Base points
                    let points = weight;

                    // Bonus for important scale degrees
                    if (scaleDegree === 0) {
                        // TONIC
                        points *= 4.5;
                    } else if (scaleDegree === 7) {
                        // DOMINANT 
                        points *= 2;
                    } else if (scaleDegree === 5) {
                        // SUBDOMINANT
                        points *= 0.2;
                    } else if (scaleDegree === 3 || scaleDegree === 4) {
                        // THIRD (major or minor) - important for defining mode
                        if (name === "Major" && scaleDegree === 4) {
                            points *= 1.6; // Major third in Major scale
                        } else if (name === "Minor" && scaleDegree === 3) {
                            points *= 1.6; // Minor third in Minor scale
                        }
                    }

                    score += points;
                } else {
                    // Note is not in scale. big problem
                    penalty += weight * 2.0;
                    
                    // Extra penalty if it is the "wrong" third
                    const scaleDegree = (pc - root + 12) % 12;
                    if (name === "Major" && scaleDegree === 3) {
                        penalty += weight * 1.0; // Minor third in Major = bad
                    } else if (name === "Minor" && scaleDegree === 4) {
                        penalty += weight * 1.0; // Major third in Minor = bad
                    }
                }
            });

            results.push({
                root,
                name,
                score: score - penalty,
                rawScore: score,
                missing: penalty,
                tonicMatch: false // (can be set later if needed
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