import { readMidi, midiToNoteName, findMatchingScalesSimple } from './scaleDetector.js';

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("fileName");
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
    output.textContent = "";
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
    
    fileName.textContent = `Uploaded file: ${file.name}`;
    show(fileName);

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
    
    // top candidate
    const top = matches[0];
    if (!top) {
        output.textContent = "No matches found.";
        show(output);
        return;
    }

    const confVal = (top.score / (top.score + top.missing)) || 0;
    const confPct = (confVal * 100).toFixed(0);
    
    let confClass = "conf-low";
    let confLabel = "Low";
    if (confVal >= 0.8) { confClass = "conf-high"; confLabel = "High"; }
    else if (confVal >= 0.5) { confClass = "conf-med"; confLabel = "Medium"; }

    // Generate reasons
    const rootName = midiToNoteName(top.root);
    const thirdInterval = top.name === "Major" ? 4 : 3;
    const thirdName = midiToNoteName((top.root + thirdInterval) % 12);
    const dominantName = midiToNoteName((top.root + 7) % 12);
    
    const reasons = [];
    const rootWeight = noteWeights.get(top.root) || 0;
    const maxWeight = Math.max(...noteWeights.values());
    
    if (rootWeight === maxWeight) {
        reasons.push(`Tonic (<strong>${rootName}</strong>) is the most frequent note`);
    } else if (rootWeight > maxWeight * 0.6) {
        reasons.push(`Tonic (<strong>${rootName}</strong>) is prominent`);
    }
    
    const thirdWeight = noteWeights.get((top.root + thirdInterval) % 12) || 0;
    if (thirdWeight > maxWeight * 0.3) {
        reasons.push(`${top.name} third (<strong>${thirdName}</strong>) is emphasized`);
    } else if (thirdWeight > 0) {
        reasons.push(`${top.name} third (<strong>${thirdName}</strong>) is present`);
    }
    
    const domWeight = noteWeights.get((top.root + 7) % 12) || 0;
    if (domWeight > maxWeight * 0.5) {
        reasons.push(`Dominant (<strong>${dominantName}</strong>) is strong`);
    } else if (domWeight > 0) {
        reasons.push(`Dominant (<strong>${dominantName}</strong>) appears`);
    }

    // Build HTML
    let html = `
        <div class="result-primary">
            <div class="key-estimation">
                Estimated key: <span class="key-name">${midiToNoteName(top.root)} ${top.name}</span>
            </div>
            <div class="confidence-badge ${confClass}">
                Confidence: ${confLabel} (${confPct}%)
            </div>
        </div>

        <div class="why-section">
            <div class="why-title">Why?</div>
            <ul class="why-list">
                ${reasons.map(r => `<li>${r}</li>`).join('')}
            </ul>
        </div>

        <details class="alternatives-details">
            <summary>See alternatives</summary>
            <div class="alternatives-content">
    `;

    // Add alternatives table
    html += `<table class="alt-table">
        <thead><tr><th>Key</th><th>Confidence</th><th>Score</th></tr></thead>
        <tbody>`;
    
    // Show top 10 alternatives (skipping the first one which is the winner)
    matches.slice(1, 11).forEach(m => {
        const c = (m.score / (m.score + m.missing)) || 0;
        const p = (c * 100).toFixed(0);
        html += `<tr>
            <td>${midiToNoteName(m.root)} ${m.name}</td>
            <td>${p}%</td>
            <td>${m.score.toFixed(1)}</td>
        </tr>`;
    });
    
    html += `</tbody></table>
            </div>
        </details>
    `;

    output.innerHTML = html;
    show(output);
}

// Simple mode: show all scales that contain all the notes
function printResultsSimple(usedNotes, noteWeights) {
    const matches = findMatchingScalesSimple(usedNotes);
    
    let html = "";

    if (matches.length === 0) {
        html += '<div class="possible-scales-header">No matching scales found</div>';
        html += '<p>The notes in this MIDI don\'t fit any standard Major or Minor scale.</p>';
    } else {
        html += `<div class="possible-scales-header">Possible scales: (${matches.length})</div>`;
        html += '<ul class="scale-list">';
        matches.forEach(m => {
            html += `<li class="scale-item">${m.rootName} ${m.name}</li>`;
        });
        html += '</ul>';
    }
    
    html += '<div class="notes-section">';
    html += '<div class="notes-header">These notes were found in MIDI:</div>';
    html += '<div class="notes-list">';
    usedNotes.forEach(pc => {
        html += `<span class="note-badge">${midiToNoteName(pc)}</span>`;
    });
    html += '</div></div>';
    
    if (matches.length > 1) {
        html += '<div class="hint-text">';
        html += 'Multiple scales can contain the same notes.<br>';
        html += 'Use Advanced mode for weighted analysis to find the most likely key.';
        html += '</div>';
    }

    output.innerHTML = html;
    show(output);
}
