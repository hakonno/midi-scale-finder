// Tuning script - finds optimal multipliers for scale detection
// Run with: node tune.js
// First run: npm install @tonejs/midi

const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');
const { Midi } = require('@tonejs/midi');

const MIDI_FOLDER = 'C:\\Users\\hakon\\Documents\\Unsynced programmering\\Free-Chord-Progressions-main\\allmajorminor';

const SCALES = {
    "Major": [0, 2, 4, 5, 7, 9, 11],
    "Minor": [0, 2, 3, 5, 7, 8, 10]
};

function buildScale(root, intervals) {
    return intervals.map(i => (root + i) % 12);
}

function noteNameToMidi(name) {
    const map = {
        "C": 0, "C#": 1, "Db": 1,
        "D": 2, "D#": 3, "Eb": 3,
        "E": 4, "F": 5,
        "F#": 6, "Gb": 6,
        "G": 7, "G#": 8, "Ab": 8,
        "A": 9, "A#": 10, "Bb": 10,
        "B": 11
    };
    return map[name];
}

function parseFilename(filename) {
    const parts = filename.replace('.mid', '').split('_');
    if (parts.length >= 2) {
        return { key: parts[0], mode: parts[1] };
    }
    return null;
}

// Load all MIDI files once
function loadMidiFiles() {
    const files = readdirSync(MIDI_FOLDER).filter(f => f.endsWith('.mid'));
    const data = [];

    for (const filename of files) {
        const expected = parseFilename(filename);
        if (!expected || (expected.mode !== "Major" && expected.mode !== "Minor")) continue;

        const filepath = join(MIDI_FOLDER, filename);
        const buffer = readFileSync(filepath);
        const midi = new Midi(buffer);

        const noteWeights = new Map();
        midi.tracks.forEach(track => {
            track.notes.forEach(note => {
                const pc = note.midi % 12;
                noteWeights.set(pc, (noteWeights.get(pc) || 0) + note.duration);
            });
        });

        const usedNotes = [...noteWeights.keys()].sort((a, b) => a - b);
        const expectedRoot = noteNameToMidi(expected.key);

        data.push({
            filename,
            usedNotes,
            noteWeights,
            expectedRoot,
            expectedMode: expected.mode
        });
    }

    return data;
}

// Score function with configurable multipliers
function findMatchingScales(usedNotes, noteWeights, params) {
    const {
        tonicMult,
        dominantMult,
        subdominantMult,
        thirdMult,
        wrongThirdPenalty,
        outsidePenalty
    } = params;

    const results = [];

    for (let root = 0; root < 12; root++) {
        for (const [name, intervals] of Object.entries(SCALES)) {
            const scale = buildScale(root, intervals);
            let score = 0;
            let penalty = 0;

            usedNotes.forEach(pc => {
                const weight = noteWeights.get(pc);

                if (scale.includes(pc)) {
                    const scaleDegree = (pc - root + 12) % 12;
                    let points = weight;

                    if (scaleDegree === 0) {
                        points *= tonicMult;
                    } else if (scaleDegree === 7) {
                        points *= dominantMult;
                    } else if (scaleDegree === 5) {
                        points *= subdominantMult;
                    } else if (name === "Major" && scaleDegree === 4) {
                        points *= thirdMult;
                    } else if (name === "Minor" && scaleDegree === 3) {
                        points *= thirdMult;
                    }

                    score += points;
                } else {
                    penalty += weight * outsidePenalty;
                    
                    const scaleDegree = (pc - root + 12) % 12;
                    if (name === "Major" && scaleDegree === 3) {
                        penalty += weight * wrongThirdPenalty;
                    } else if (name === "Minor" && scaleDegree === 4) {
                        penalty += weight * wrongThirdPenalty;
                    }
                }
            });

            results.push({ root, name, score: score - penalty });
        }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
}

// Test accuracy with given parameters
function testAccuracy(midiData, params) {
    let correct = 0;

    for (const file of midiData) {
        const matches = findMatchingScales(file.usedNotes, file.noteWeights, params);
        const top = matches[0];

        if (top.root === file.expectedRoot && top.name === file.expectedMode) {
            correct++;
        }
    }

    return correct;
}

// Main tuning loop
async function tune() {
    console.log('Loading MIDI files...');
    const midiData = loadMidiFiles();
    console.log(`Loaded ${midiData.length} files\n`);

    let bestScore = 0;
    let bestParams = null;
    let tested = 0;

    // Define search ranges
    const tonicRange = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];
    const dominantRange = [1.0, 1.5, 2.0, 2.5, 3.0];
    const subdominantRange = [0.5, 1.0, 1.5, 2.0];
    const thirdRange = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
    const wrongThirdRange = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
    const outsideRange = [1.0, 1.5, 2.0, 2.5, 3.0];

    const totalCombinations = tonicRange.length * dominantRange.length * 
        subdominantRange.length * thirdRange.length * 
        wrongThirdRange.length * outsideRange.length;

    console.log(`Testing ${totalCombinations} combinations...\n`);

    for (const tonicMult of tonicRange) {
        for (const dominantMult of dominantRange) {
            for (const subdominantMult of subdominantRange) {
                for (const thirdMult of thirdRange) {
                    for (const wrongThirdPenalty of wrongThirdRange) {
                        for (const outsidePenalty of outsideRange) {
                            const params = {
                                tonicMult,
                                dominantMult,
                                subdominantMult,
                                thirdMult,
                                wrongThirdPenalty,
                                outsidePenalty
                            };

                            const score = testAccuracy(midiData, params);
                            tested++;

                            if (score > bestScore) {
                                bestScore = score;
                                bestParams = { ...params };
                                const pct = ((score / midiData.length) * 100).toFixed(1);
                                console.log(`NEW BEST: ${score}/${midiData.length} (${pct}%)`);
                                console.log(`  tonic=${tonicMult}, dom=${dominantMult}, sub=${subdominantMult}, third=${thirdMult}, wrongThird=${wrongThirdPenalty}, outside=${outsidePenalty}`);
                            }

                            if (tested % 5000 === 0) {
                                console.log(`Progress: ${tested}/${totalCombinations} (${((tested/totalCombinations)*100).toFixed(1)}%)`);
                            }
                        }
                    }
                }
            }
        }
    }

    console.log('\n=== FINAL RESULTS ===');
    console.log(`Best accuracy: ${bestScore}/${midiData.length} (${((bestScore/midiData.length)*100).toFixed(1)}%)`);
    console.log('\nOptimal multipliers:');
    console.log(JSON.stringify(bestParams, null, 2));

    console.log('\nCode to use in scaleDetector.js:');
    console.log(`
    if (scaleDegree === 0) {
        points *= ${bestParams.tonicMult}; // TONIC
    } else if (scaleDegree === 7) {
        points *= ${bestParams.dominantMult}; // DOMINANT
    } else if (scaleDegree === 5) {
        points *= ${bestParams.subdominantMult}; // SUBDOMINANT
    }
    
    // Third bonus
    if (name === "Major" && scaleDegree === 4) {
        points *= ${bestParams.thirdMult};
    } else if (name === "Minor" && scaleDegree === 3) {
        points *= ${bestParams.thirdMult};
    }
    
    // Penalties
    penalty += weight * ${bestParams.outsidePenalty}; // outside scale
    penalty += weight * ${bestParams.wrongThirdPenalty}; // wrong third
    `);
}

tune().catch(console.error);
