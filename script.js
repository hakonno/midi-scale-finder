const dropzone = document.getElementById("dropzone");
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
    output.textContent = "File: " + file.name;

    const reader = new FileReader();

    reader.onload = () => {
        const arrayBuffer = reader.result;
        readMidi(arrayBuffer);
    }

    reader.readAsArrayBuffer(file);

});

function readMidi(arrayBuffer) {
    const midi = new Midi(arrayBuffer); // using library to parse MIDI

    const pitchClasses = new Set();

    // Extract MIDI note numbers from all tracks
    midi.tracks.forEach(track => {
        track.notes.forEach(note => {
            const pc = note.midi % 12;
            pitchClasses.add(pc);
        });
    });

    const usedNotes = [...pitchClasses]
        .sort((a, b) => a - b) // Sort pitch classes numerically

    const matches = findMatchingScales(usedNotes);
    
    let text = "Notes found: \n";
    text += usedNotes.map(midiToNoteName).join(", ");
    text += "\n\nPossible scales:\n";

    matches.forEach(m => {
        text += `${midiToNoteName(m.root)} ${m.name}\n`;
    })

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

function findMatchingScales(usedNotes) {
    const results = [];

    for (let root = 0; root < 12; root++) {
        for (const [name, intervals] of Object.entries(SCALES)) {
            const scale = buildScale(root, intervals);

            if (scaleMatches(scale, usedNotes)) {
                results.push({
                    root,
                    name
                });
            }
        }
    }
    
    return results;
}