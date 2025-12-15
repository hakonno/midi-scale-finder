import {
    readMidi,
    midiToNoteName,
    findMatchingScalesWeighted,
    findMatchingScalesSimple,
    getScalePitchClasses
} from './scaleDetector.js';

import { createVerticalPiano } from './pianoView.js';

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("fileName");
const output = document.getElementById("output");
const scaleOutput = document.getElementById("scaleOutput");
const scaleTitle = document.getElementById("scaleTitle");
const clearBtn = document.getElementById('clearBtn');
const resetToMidiBtn = document.getElementById('resetToMidiBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const selectionHint = document.getElementById('selectionHint');
const pianoMount = document.getElementById('pianoMount');

// Baseline (from MIDI) and current selection state
let midiBaselineNoteWeights = null; // Map<pitchClass, duration>
let midiBaselinePitchClasses = null; // Set<pitchClass>
let midiPctByPc = null; // Map<pitchClass, pct>
let selectedPitchClasses = new Set();

let history = [];
let historyIndex = -1;
let suppressHistory = false;

function pcsKey(pcs) {
    return [...pcs].slice().sort((a, b) => a - b).join(',');
}

function pushHistory(nextSet) {
    if (suppressHistory) return;

    const key = pcsKey(nextSet);
    const currentKey = (historyIndex >= 0 && history[historyIndex]) ? pcsKey(history[historyIndex]) : null;
    if (key === currentKey) {
        updateUndoRedoButtons();
        return;
    }

    // Drop redo branch
    history = history.slice(0, historyIndex + 1);
    history.push(new Set(nextSet));
    historyIndex = history.length - 1;
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    undoBtn.disabled = historyIndex <= 0;
    redoBtn.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
}

function applySelection(pcs, { silent = false, recordHistory = true } = {}) {
    const next = new Set((pcs || []).map(Number));
    piano.setSelectedPitchClasses([...next], { silent: true });
    selectedPitchClasses = next;
    updateOutputFromSelection();
    if (recordHistory) pushHistory(next);
}

const piano = createVerticalPiano({
    mountEl: pianoMount,
    onSelectionChange: (nextSelected) => {
        selectedPitchClasses = nextSelected;
        pushHistory(nextSelected);
        updateOutputFromSelection();
    }
});

// Init history with empty state
pushHistory(new Set());

const hide = (el) => el.classList.add("hidden");
const show = (el) => el.classList.remove("hidden");

function sumWeights(noteWeights) {
    let total = 0;
    for (const v of noteWeights.values()) total += v;
    return total;
}

function buildPctMap(noteWeights) {
    const total = sumWeights(noteWeights);
    const safeTotal = total > 0 ? total : 1;
    const map = new Map();
    for (const [pc, w] of noteWeights.entries()) {
        map.set(pc, Math.round((w / safeTotal) * 100));
    }
    return map;
}

function buildNoteWeightsForSelection() {
    const pcs = [...selectedPitchClasses].sort((a, b) => a - b);
    const noteWeights = new Map();

    if (midiBaselineNoteWeights && midiBaselineNoteWeights.size > 0) {
        const baselineValues = [...midiBaselineNoteWeights.values()];
        const minWeight = Math.min(...baselineValues);
        const defaultAdded = Number.isFinite(minWeight) ? Math.max(0.0001, minWeight * 0.25) : 1;

        for (const pc of pcs) {
            noteWeights.set(pc, midiBaselineNoteWeights.get(pc) ?? defaultAdded);
        }
    } else {
        for (const pc of pcs) {
            noteWeights.set(pc, 1);
        }
    }

    return noteWeights;
}

function updateTitle(best) {
    if (!best) {
        scaleTitle.textContent = 'Auto Scale';
        return;
    }
    scaleTitle.textContent = `${midiToNoteName(best.root)} ${best.name}`;
}

function updateResetButtonState() {
    const hasBaseline = !!(midiBaselinePitchClasses && midiBaselinePitchClasses.size > 0);
    resetToMidiBtn.disabled = !hasBaseline;
    clearBtn.disabled = selectedPitchClasses.size === 0;
}

function updateOutputFromSelection() {
    const usedNotes = [...selectedPitchClasses].sort((a, b) => a - b);

    if (usedNotes.length === 0) {
        scaleOutput.innerHTML = `
            <div class="result-block">
                <div class="possible-scales-header">Possible scales</div>
                <p>Select one or more notes to see possible Major/Minor scales.</p>
            </div>
        `;
        selectionHint.textContent = midiBaselinePitchClasses
            ? 'Select/deselect notes to refine the MIDI.'
            : 'Upload MIDI or start selecting notes to find a key/scale.';
        updateTitle(null);
        updateResetButtonState();
        updateUndoRedoButtons();
        return;
    }

    const noteWeights = buildNoteWeightsForSelection();
    const weightedMatches = findMatchingScalesWeighted(usedNotes, noteWeights);
    const simpleMatches = findMatchingScalesSimple(usedNotes);

    const rankByKey = new Map(
        weightedMatches.map((m, idx) => [`${m.root}-${m.name}`, idx])
    );

    const candidates = (simpleMatches.length > 0)
        ? simpleMatches
            .slice()
            .sort((a, b) => (rankByKey.get(`${a.root}-${a.name}`) ?? 999) - (rankByKey.get(`${b.root}-${b.name}`) ?? 999))
        : weightedMatches.slice(0, 12).map(m => ({ root: m.root, name: m.name, rootName: midiToNoteName(m.root) }));

    const best = candidates[0];

    const headerText = (simpleMatches.length > 0)
        ? `Possible scales (contain all selected notes): (${candidates.length})`
        : `Closest Major/Minor matches: (${candidates.length})`;

    const scalesHtml = buildPossibleScalesSection(candidates, best, noteWeights, weightedMatches);
    const whyHtml = buildWhyDetails(best, noteWeights);

    scaleOutput.innerHTML = `
        <div class="result-block">
            <div class="possible-scales-header">${headerText}</div>
            ${scalesHtml}
            ${whyHtml}
        </div>
    `;

    selectionHint.textContent = midiBaselinePitchClasses
        ? 'Select/deselect notes; scales update instantly.'
        : 'Manual mode: select notes; scales update instantly.';
    updateTitle(best);
    updateResetButtonState();
    updateUndoRedoButtons();
}

// Process a file (used by both drag-drop and file input)
function processFile(file) {
    // keep the UI visible; just update baseline + selection

    if (!file) {
        selectionHint.textContent = 'No file selected. Use manual note selection.';
        return;
    }

    if (!file.name.endsWith(".mid") && !file.name.endsWith(".midi")) {
        selectionHint.textContent = 'Please select a MIDI file (.mid or .midi).';
        return;
    }
    
    fileName.textContent = `Uploaded file: ${file.name}`;
    show(fileName);

    const reader = new FileReader();

    reader.onload = () => {
        const arrayBuffer = reader.result;
        readMidi(arrayBuffer, (usedNotes, noteWeights, matches, tonic) => {
            midiBaselineNoteWeights = noteWeights;
            midiBaselinePitchClasses = new Set(usedNotes);
            midiPctByPc = buildPctMap(noteWeights);

            piano.setMidiPercentages(midiPctByPc);
            piano.setSelectedPitchClasses(usedNotes, { silent: true });
            selectedPitchClasses = new Set(usedNotes);
            updateOutputFromSelection();
        });
    }

    reader.onerror = () => {
        selectionHint.textContent = 'Error reading file. Please try again.';
    }

    reader.readAsArrayBuffer(file);
}

clearBtn.addEventListener('click', () => {
    applySelection([], { silent: true, recordHistory: true });
});

resetToMidiBtn.addEventListener('click', () => {
    if (!midiBaselinePitchClasses || midiBaselinePitchClasses.size === 0) return;
    applySelection([...midiBaselinePitchClasses], { silent: true, recordHistory: true });
});

undoBtn.addEventListener('click', () => {
    if (historyIndex <= 0) return;
    suppressHistory = true;
    historyIndex -= 1;
    const state = history[historyIndex] || new Set();
    applySelection([...state], { silent: true, recordHistory: false });
    suppressHistory = false;
    updateUndoRedoButtons();
});

redoBtn.addEventListener('click', () => {
    if (historyIndex < 0 || historyIndex >= history.length - 1) return;
    suppressHistory = true;
    historyIndex += 1;
    const state = history[historyIndex] || new Set();
    applySelection([...state], { silent: true, recordHistory: false });
    suppressHistory = false;
    updateUndoRedoButtons();
});

// Clickable scales: apply scale pitch-classes to selection
scaleOutput.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scale-root][data-scale-mode]');
    if (!btn) return;
    const root = Number(btn.dataset.scaleRoot);
    const mode = btn.dataset.scaleMode;
    if (!Number.isFinite(root) || !mode) return;

    const pcs = getScalePitchClasses(root, mode);
    applySelection(pcs, { silent: true, recordHistory: true });
});

// Handle drag over
dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("drag-over");
});

// Handle drag leave
dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("drag-over");
});

// Handle file drop
dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag-over");
    
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

function buildResultsLayout(usedNotes, noteWeights, weightedMatches) {
    if (!weightedMatches || weightedMatches.length === 0 || noteWeights.size === 0) {
        return `<div class="result-block">
            <div class="possible-scales-header">No results</div>
            <p>Could not detect notes from this MIDI.</p>
        </div>`;
    }

    const simpleMatches = findMatchingScalesSimple(usedNotes);
    const rankByKey = new Map(
        weightedMatches.map((m, idx) => [`${m.root}-${m.name}`, idx])
    );

    const candidates = (simpleMatches.length > 0)
        ? simpleMatches
            .slice()
            .sort((a, b) => (rankByKey.get(`${a.root}-${a.name}`) ?? 999) - (rankByKey.get(`${b.root}-${b.name}`) ?? 999))
        : weightedMatches.slice(0, 12).map(m => ({ root: m.root, name: m.name, rootName: midiToNoteName(m.root) }));

    const best = candidates[0];

    const headerText = (simpleMatches.length > 0)
        ? `Possible scales (contain all detected notes): (${candidates.length})`
        : `Closest Major/Minor matches: (${candidates.length})`;

    const scalesHtml = buildPossibleScalesSection(candidates, best, noteWeights, weightedMatches);
    const whyHtml = buildWhyDetails(best, noteWeights);
    const notesHtml = buildNotesFoundSection(usedNotes, noteWeights);

    const hintHtml = buildHintText(simpleMatches.length, candidates, best, noteWeights);

    return `
        <div class="result-block">
            <div class="possible-scales-header">${headerText}</div>
            ${scalesHtml}
            ${whyHtml}
        </div>
        <div class="result-block">
            ${notesHtml}
            ${hintHtml}
        </div>
    `;
}

function buildHintText(simpleMatchCount, candidates, best, noteWeights) {
    if (simpleMatchCount <= 1) return "";

    const enriched = candidates.map(c => {
        const { inPct } = computeScaleCoveragePct(c.root, c.name, noteWeights);
        return { ...c, inPct };
    });

    const bestInPct = enriched.find(m => m.root === best.root && m.name === best.name)?.inPct ?? 0;
    const maxInPct = Math.max(...enriched.map(m => m.inPct));

    const extra = (bestInPct < maxInPct)
        ? " Match% just means notes are inside the scale. Best guess also looks at which notes are emphasized."
        : "";

    return `<div class="hint-text">Many scales can contain the same notes. The one tagged “Best guess” uses which notes are emphasized in the MIDI.${extra}</div>`;
}

function computeScaleCoveragePct(root, mode, noteWeights) {
    const total = sumWeights(noteWeights);
    if (total <= 0) return { inPct: 0, outPct: 0 };

    const scaleNotes = getScalePitchClasses(root, mode);
    let inTotal = 0;
    for (const [pc, w] of noteWeights.entries()) {
        if (scaleNotes.includes(pc)) inTotal += w;
    }
    const inPct = Math.round((inTotal / total) * 100);
    const outPct = Math.max(0, 100 - inPct);
    return { inPct, outPct };
}

function buildPossibleScalesSection(candidates, best, noteWeights, weightedMatches) {
    const rankByKey = new Map(
        (weightedMatches || []).map((m, idx) => [`${m.root}-${m.name}`, idx])
    );

    const enriched = candidates.map(m => {
        const isBest = m.root === best.root && m.name === best.name;
        const { inPct, outPct } = computeScaleCoveragePct(m.root, m.name, noteWeights);
        const weightedRank = rankByKey.get(`${m.root}-${m.name}`) ?? 999;
        return { ...m, isBest, inPct, outPct, weightedRank };
    });

    enriched.sort((a, b) => {
        if (a.isBest !== b.isBest) return a.isBest ? -1 : 1;
        if (b.inPct !== a.inPct) return b.inPct - a.inPct;
        if (a.outPct !== b.outPct) return a.outPct - b.outPct;
        return a.weightedRank - b.weightedRank;
    });

    const items = enriched.map(m => {
        const label = `${midiToNoteName(m.root)} ${m.name}`;
        const meta = (m.outPct > 0)
            ? `${m.inPct}% match · ${m.outPct}% outside`
            : `${m.inPct}% match`;

        return `
            <li class="scale-item${m.isBest ? " best" : ""}">
                <button type="button" class="scale-item-btn" data-scale-root="${m.root}" data-scale-mode="${m.name}" aria-label="Select ${label}">
                    <div class="scale-line">
                        <span class="scale-name">${label}</span>
                        ${m.isBest ? '<span class="scale-tag">Best guess</span>' : ''}
                    </div>
                    <div class="scale-meta">${meta}</div>
                </button>
            </li>
        `;
    }).join("");

    return `<ul class="scale-list">${items}</ul>`;
}

function buildWhyDetails(best, noteWeights) {
    if (!best || noteWeights.size === 0) return "";

    const rootName = midiToNoteName(best.root);
    const thirdInterval = best.name === "Major" ? 4 : 3;
    const thirdName = midiToNoteName((best.root + thirdInterval) % 12);
    const dominantName = midiToNoteName((best.root + 7) % 12);

    const reasons = [];
    const rootWeight = noteWeights.get(best.root) || 0;
    const maxWeight = Math.max(...noteWeights.values());

    if (maxWeight > 0) {
        if (rootWeight === maxWeight) {
            reasons.push(`<strong>${rootName}</strong> is the most-used note <span class="why-meaning">(often feels like “home”)</span>`);
        } else if (rootWeight > maxWeight * 0.6) {
            reasons.push(`<strong>${rootName}</strong> is used a lot <span class="why-meaning">(can point to the home note)</span>`);
        }

        const thirdPc = (best.root + thirdInterval) % 12;
        const thirdWeight = noteWeights.get(thirdPc) || 0;
        if (thirdWeight > maxWeight * 0.3) {
            reasons.push(`The <strong>${thirdName}</strong> (${best.name} 3rd) stands out <span class="why-meaning">(the 3rd helps decide Major vs Minor)</span>`);
        } else if (thirdWeight > 0) {
            reasons.push(`The <strong>${thirdName}</strong> (${best.name} 3rd) is present <span class="why-meaning">(the 3rd helps decide Major vs Minor)</span>`);
        }

        const domPc = (best.root + 7) % 12;
        const domWeight = noteWeights.get(domPc) || 0;
        if (domWeight > maxWeight * 0.5) {
            reasons.push(`The dominant <strong>${dominantName}</strong> is strong <span class="why-meaning">(dominant often leads back to the home note)</span>`);
        } else if (domWeight > 0) {
            reasons.push(`The dominant <strong>${dominantName}</strong> appears <span class="why-meaning">(dominant often leads back to the home note)</span>`);
        }
    }

    if (reasons.length === 0) {
        reasons.push(`No clear single-note emphasis; this is the closest overall match. <span class="why-meaning">(notes are spread more evenly)</span>`);
    }

    return `
        <details class="why-details">
            <summary>Why the best guess?</summary>
            <div class="why-section">
                <ul class="why-list">
                    ${reasons.map(r => `<li>${r}</li>`).join('')}
                </ul>
            </div>
        </details>
    `;
}

function buildNotesFoundSection(usedNotes, noteWeights) {
    const total = sumWeights(noteWeights);
    const safeTotal = total > 0 ? total : 1;

    const sortedNotes = usedNotes
        .map(pc => ({ pc, weight: noteWeights.get(pc) || 0 }))
        .sort((a, b) => {
            if (b.weight !== a.weight) return b.weight - a.weight;
            return a.pc - b.pc;
        });

    const chips = sortedNotes.map(({ pc, weight }) => {
        const pct = Math.round((weight / safeTotal) * 100);
        return `
            <div class="note-chip">
                <div class="note-name">${midiToNoteName(pc)}</div>
                <div class="note-meta">${pct}%</div>
            </div>
        `;
    }).join("");

    return `
        <div class="notes-section">
            <div class="notes-header">These notes were found in MIDI:</div>
            <div class="notes-list">${chips}</div>
        </div>
    `;
}

// Initialize UI on first load (manual mode)
updateOutputFromSelection();

// Expose Piano API globally (optional)
window.piano = piano;
