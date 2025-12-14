import { readMidi, midiToNoteName, findMatchingScalesSimple } from './scaleDetector.js';

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const info = document.getElementById("info");
const output = document.getElementById("output");
const modeSimple = document.getElementById("modeSimple");
const modeAdvanced = document.getElementById("modeAdvanced");

// Store last processed data for mode switching
let lastProcessedData = null;

const hide = (el) => el.classList.add("hidden");
const show = (el) => el.classList.remove("hidden");

// Get current mode
function getMode() {
    return modeSimple.checked ? "simple" : "advanced";
}

// Handle mode change
modeSimple.addEventListener("change", () => {
    if (lastProcessedData) {
        displayResults(lastProcessedData);
    }
});
modeAdvanced.addEventListener("change", () => {
    if (lastProcessedData) {
        displayResults(lastProcessedData);
    }
});

// Display results based on current mode
function displayResults(data) {
    const { usedNotes, noteWeights, matches, tonic } = data;
    
    if (getMode() === "simple") {
        printResultsSimple(usedNotes, noteWeights);
    } else {
        printResultsWeighted(usedNotes, noteWeights, matches, tonic);
    }
}

// Process a file (used by both drag-drop and file input)
function processFile(file) {
    info.textContent = "";
    output.textContent = "";
    hide(info);
    hide(output);
    lastProcessedData = null;

    if (!file) {
        output.textContent = "No file selected";
        show(output);
        return;
    }

    if (!file.name.endsWith(".mid") && !file.name.endsWith(".midi")) {
        output.textContent = "Please select a MIDI file (.mid or .midi)";
        show(output);
        return;
    }
    
    info.textContent = "File: " + file.name;
    show(info);

    const reader = new FileReader();

    reader.onload = () => {
        const arrayBuffer = reader.result;
        readMidi(arrayBuffer, (usedNotes, noteWeights, matches, tonic) => {
            lastProcessedData = { usedNotes, noteWeights, matches, tonic };
            displayResults(lastProcessedData);
        });
    }

    reader.onerror = () => {
        output.textContent = "Error reading file. Please try again.";
        show(output);
    }

    reader.readAsArrayBuffer(file);
}

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
    processFile(file);
});

// Handle click to open file picker
dropzone.addEventListener("click", () => {
    fileInput.click();
});

// Handle keyboard activation (Enter or Space)
dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        fileInput.click();
    }
});

// Handle file selection from input
fileInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    processFile(file);
});

function printResultsWeighted(usedNotes, noteWeights, matches, tonic) {
    const totalWeight = [...noteWeights.values()]
    .reduce((a, b) => a + b, 0);
    
    // categorize matches
    const perfect = matches.filter(m => m.missing < 0.01);
    const strong = matches.filter(m => m.missing < 0.5);
    const weak = matches.filter(m => 
        m.missing >= 0.5 && m.missing < totalWeight * 0.6
    );

    // top candidate
    const top = matches[0];

    // helper to format candidate info
    function fmtCandidate(m) {
        const conf = (m.score / (m.score + m.missing)) || 0;
        const confPct = (conf * 100).toFixed(0) + "%";
        const tonicMark = m.tonicMatch ? "* tonic match" : "";
        return ` - ${midiToNoteName(m.root)} ${m.name}${tonicMark} — score: ${m.score.toFixed(2)}, missing: ${m.missing.toFixed(2)} (conf: ${confPct})`;
    }

    // build output
    let text = `Detected tonic: ${midiToNoteName(tonic)}\n\n`;
    // todo: explain to user what tonic means: 
    // The tonic is the “home” note of a piece—the pitch everything feels drawn back to. 
    // Knowing the tonic instantly tells you the song’s key, 
    // so you know which chords and melodies fit naturally.
    text += `Total note weight: ${totalWeight.toFixed(2)}\n\n`;

    text += "Notes found (weighted):\n";
    usedNotes.forEach(pc => {
        text += ` - ${midiToNoteName(pc)}: ${noteWeights.get(pc).toFixed(2)}\n`;
    });

    text += "\n\n";

    if (top) {
        text += `Best match: ${midiToNoteName(top.root)} ${top.name}  — confidence ${( (top.score / (top.score + top.missing)) * 100 ).toFixed(0)}%\n\n`;
    }

    // if perfect matches exist, show them
    if (perfect.length > 0) {
        text += "Perfect matches:\n";
        perfect.forEach(m => {
            text += fmtCandidate(m) + "\n";
        });
        // show a couple of other candidates if you want
        const remaining = matches.filter(m => !perfect.includes(m)).slice(0, 4);
        if (remaining.length) {
            text += "\nOther candidates:\n";
            remaining.forEach(m => text += fmtCandidate(m) + "\n");
        }
    } else if (strong.length > 0) {
        text += "Strong candidates:\n";
        strong.slice(0, 6).forEach(m => text += fmtCandidate(m) + "\n");
        text += "\nOther candidates (less likely):\n";
        weak.slice(0, 6).forEach(m => text += fmtCandidate(m) + "\n");
    } else {
        // fallback: show top few
        text += "Candidates:\n";
        matches.slice(0, 6).forEach(m => text += fmtCandidate(m) + "\n");
    }

    output.textContent = text;
    show(output);
}

// Simple mode: show all scales that contain all the notes
function printResultsSimple(usedNotes, noteWeights) {
    const matches = findMatchingScalesSimple(usedNotes);
    
    let text = "Notes found:\n";
    usedNotes.forEach(pc => {
        text += ` - ${midiToNoteName(pc)}\n`;
    });

    text += "\n";

    if (matches.length === 0) {
        text += "No matching scales found.\n";
        text += "The notes in this MIDI don't fit any standard Major or Minor scale.";
    } else {
        text += `Possible scales (${matches.length}):\n`;
        matches.forEach(m => {
            text += ` - ${m.rootName} ${m.name}\n`;
        });
        
        if (matches.length > 1) {
            text += "\nNote: Multiple scales can contain the same notes.\n";
            text += "Use Advanced mode for weighted analysis to find the most likely key.";
        }
    }

    output.textContent = text;
    show(output);
}
