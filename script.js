const dropzone = document.getElementById("dropzone");
const info = document.getElementById("info");
const output = document.getElementById("output");

const SCALES = {
    "Major":       [0, 2, 4, 5, 7, 9, 11],
    "Minor":       [0, 2, 3, 5, 7, 8, 10]
};


// Handle drag over
dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.style.background = "#333";
});

// Handle drag leave
dropzone.addEventListener("dragleave", () => {
    dropzone.style.background = "";
});

// Handle file drop
dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.style.background = "";

    const file = event.dataTransfer.files[0];

    if (!file.name.endsWith(".mid") && !file.name.endsWith(".midi")) {
        output.textContent = "Please drop a MIDI file";
        return;
    }
    info.textContent = "File: " + file.name;

    const reader = new FileReader();

    reader.onload = () => {
        const arrayBuffer = reader.result;
        readMidi(arrayBuffer);
    }

    reader.readAsArrayBuffer(file);

});

function readMidi(arrayBuffer) {
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

    const matches = findMatchingScalesWeighted(usedNotes, noteWeights);

    printResultsWeighted(usedNotes, noteWeights, matches);
}

function printResultsWeighted(usedNotes, noteWeights, matches) {
    const perfect = matches.filter(m => m.missing < 0.01);
    const strong = matches.filter(m => m.missing < 0.5);
    const weak   = matches.filter(m => m.missing < m.score);

    const totalWeight = [...noteWeights.values()]
    .reduce((a, b) => a + b, 0);

    let text = "Notes found (weighted):\n";
    usedNotes.forEach(pc => {
        text += ` - ${midiToNoteName(pc)}: ${noteWeights.get(pc).toFixed(2)}\n`;
    });

    text = `Total note weight: ${totalWeight.toFixed(2)}\n` + text;

    text += "\n\n";
    text += "\nPossible keys:\n";

    if (perfect.length > 0) {
        text += "Perfect matches:\n";
        perfect.forEach(m => {
            text += ` - ${midiToNoteName(m.root)} ${m.name}\n`;
            text += ` (score: ${m.score.toFixed(2)})\n`;
        });
    } else { 
        text += "Strong candidates:\n";
        strong.forEach(m => {
            text += ` - ${midiToNoteName(m.root)} ${m.name} (missing ${m.missing.toFixed(2)} notes)\n`;
            text += ` (score: ${m.score.toFixed(2)})\n`;
        });
    }

    text += "\nOther candidates (less likely):\n";
    weak.slice(0, 7).forEach(m => {
        text += ` - ${midiToNoteName(m.root)} ${m.name} (missing ${m.missing.toFixed(2)} notes)\n`;
        text += ` (score: ${m.score.toFixed(2)})\n`;
    });

    output.textContent = text;
}

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


// Find matching scales with weighted scoring
function findMatchingScalesWeighted(usedNotes, noteWeights) {
    const results = []; // to store scale match results

    // Iterate over all possible roots (0-11)
    for (let root = 0; root < 12; root++) {
        for (const [name, intervals] of Object.entries(SCALES)) {
            const scale = buildScale(root, intervals); // build scale notes

            let explained = 0;  // total weight of notes explained by the scale
            let missing = 0;    // total weight of notes not in the scale

            usedNotes.forEach(pc => {
                const weight = noteWeights.get(pc);

                if (scale.includes(pc)) {
                    explained += weight;    // note is in the scale
                } else {
                    missing += weight;      // note is not in the scale
                }
            });

            results.push({
                root,
                name,
                score: explained,
                missing
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