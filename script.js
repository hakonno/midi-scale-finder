import { readMidi, midiToNoteName } from './scaleDetector.js';

const dropzone = document.getElementById("dropzone");
const info = document.getElementById("info");
const output = document.getElementById("output");

const hide = (el) => el.classList.add("hidden");
const show = (el) => el.classList.remove("hidden");

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

    info.textContent = "";
    output.textContent = "";
    hide(info);
    hide(output);

    const file = event.dataTransfer.files[0];

    if (!file.name.endsWith(".mid") && !file.name.endsWith(".midi")) {
        output.textContent = "Please drop a MIDI file";
        show(output);
        return;
    }
    info.textContent = "File: " + file.name;
    show(info);

    const reader = new FileReader();

    reader.onload = () => {
        const arrayBuffer = reader.result;
        readMidi(arrayBuffer, printResultsWeighted);
    }

    reader.readAsArrayBuffer(file);

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
