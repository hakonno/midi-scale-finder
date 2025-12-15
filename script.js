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
const resetAllBtn = document.getElementById('resetAllBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const selectionHint = document.getElementById('selectionHint');
const pianoMount = document.getElementById('pianoMount');

const keyboardModeToggle = document.getElementById('keyboardModeToggle');
const keyboardInputMode = document.getElementById('keyboardInputMode');

// Baseline (from MIDI) and current selection state
let midiBaselineNoteWeights = null; // Map<pitchClass, duration>
let midiBaselinePitchClasses = null; // Set<pitchClass>
let midiPctByPc = null; // Map<pitchClass, pct>
let selectedPitchClasses = new Set();

let history = [];
let historyIndex = -1;
let suppressHistory = false;

let lastAppliedScale = null; // { root:number, mode:string } | null

// Keyboard piano mode
let keyboardModeEnabled = false;
let keyboardMode = 'record'; // 'record' | 'live'
const heldKeyboardCodes = new Set();
let showAllScales = false;

const SCALE_INTERVALS = {
    Major: [0, 2, 4, 5, 7, 9, 11, 12],
    Minor: [0, 2, 3, 5, 7, 8, 10, 12]
};

function buildScalePreviewMidiSequence(root, mode) {
    const intervals = SCALE_INTERVALS[mode];
    if (!intervals) return [];
    const rootPc = ((Number(root) % 12) + 12) % 12;
    // Start around C4 (60) and go up one octave, ending on tonic again.
    const baseMidi = 60 + rootPc;
    return intervals.map((i) => baseMidi + i);
}

// Map physical key positions (event.code) to MIDI note numbers.
// Layout-agnostic: uses `event.code` (physical key), not `event.key` (label).
const KEYBOARD_MIDI_BY_CODE = {
    // Lower octave white keys: C4 -> E5
    KeyZ: 60, // C4
    KeyX: 62, // D4
    KeyC: 64, // E4
    KeyV: 65, // F4
    KeyB: 67, // G4
    KeyN: 69, // A4
    KeyM: 71, // B4
    Comma: 72, // C5
    Period: 74, // D5
    Slash: 76, // E5

    // Lower octave black keys
    KeyS: 61, // C#4
    KeyD: 63, // D#4
    KeyG: 66, // F#4
    KeyH: 68, // G#4
    KeyJ: 70  // A#4
    // (no black keys between E-F and B-C)
};

// Upper octave: C5 -> E6
Object.assign(KEYBOARD_MIDI_BY_CODE, {
    KeyQ: 72, // C5
    KeyW: 74, // D5
    KeyE: 76, // E5
    KeyR: 77, // F5
    KeyT: 79, // G5
    KeyY: 81, // A5
    KeyU: 83, // B5
    KeyI: 84, // C6
    KeyO: 86, // D6
    KeyP: 88, // E6

    Digit2: 73, // C#5
    Digit3: 75, // D#5
    Digit5: 78, // F#5
    Digit6: 80, // G#5
    Digit7: 82, // A#5
    Digit9: 85, // C#6
    Digit0: 87  // D#6
});

function isEditableTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!el.isContentEditable;
}

function getHeldPitchClasses() {
    const pcs = new Set();
    for (const code of heldKeyboardCodes) {
        const midi = KEYBOARD_MIDI_BY_CODE[code];
        if (!Number.isFinite(midi)) continue;
        pcs.add(((midi % 12) + 12) % 12);
    }
    return pcs;
}

function syncPressedFromKeyboard() {
    const pcs = getHeldPitchClasses();
    if (piano && typeof piano.setPressedPitchClasses === 'function') {
        piano.setPressedPitchClasses([...pcs]);
    }
}

function hasMidiEmphasisData() {
    return !!(midiBaselineNoteWeights && midiBaselineNoteWeights.size > 0);
}

function isSameKey(a, b) {
    if (!a || !b) return false;
    return a.root === b.root && a.name === b.name;
}

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
        // If user is manually editing notes, treat it as a freeform selection.
        lastAppliedScale = null;
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

function buildNoteWeightsForPitchClasses(pitchClassesSet) {
    const pcs = [...pitchClassesSet].sort((a, b) => a - b);
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

    const hasFileLabel = fileName && !fileName.classList.contains('hidden') && (fileName.textContent || '').trim().length > 0;
    const hasAnyState = hasBaseline || selectedPitchClasses.size > 0 || hasFileLabel;
    if (resetAllBtn) resetAllBtn.disabled = !hasAnyState;
}

function updateOutputFromSelection(pitchClassesOverride) {
    let activePcs;
    if (pitchClassesOverride instanceof Set) {
        activePcs = new Set([...pitchClassesOverride].map(Number));
    } else if (Array.isArray(pitchClassesOverride)) {
        activePcs = new Set(pitchClassesOverride.map(Number));
    } else if (keyboardModeEnabled && keyboardMode === 'live') {
        activePcs = getHeldPitchClasses();
    } else {
        activePcs = selectedPitchClasses;
    }

    const usedNotes = [...activePcs].sort((a, b) => a - b);

    if (usedNotes.length === 0) {
        scaleOutput.innerHTML = `
            <div class="result-block">
                <div class="possible-scales-header">Possible scales</div>
                <p>Select one or more notes to see possible Major/Minor scales.</p>
            </div>
        `;
        if (keyboardModeEnabled) {
            selectionHint.textContent = (keyboardMode === 'live')
                ? 'Keyboard mode (Live): hold notes; scales update instantly.'
                : 'Keyboard mode (Record): play notes to add them; Clear to start over.';
        } else {
            selectionHint.textContent = midiBaselinePitchClasses
                ? 'Select/deselect notes to refine the MIDI.'
                : 'Upload MIDI or start selecting notes to find a key/scale.';
        }
        updateTitle(null);
        updateResetButtonState();
        updateUndoRedoButtons();
        return;
    }

    const noteWeights = buildNoteWeightsForPitchClasses(activePcs);
    const showEmphasis = hasMidiEmphasisData();
    const weightedMatches = findMatchingScalesWeighted(usedNotes, noteWeights);
    const simpleMatches = findMatchingScalesSimple(usedNotes);

    const rankByKey = new Map(
        weightedMatches.map((m, idx) => [`${m.root}-${m.name}`, idx])
    );

    let fullCandidates;
    if (simpleMatches.length > 0) {
        fullCandidates = simpleMatches.slice();
        if (showEmphasis) {
            fullCandidates.sort((a, b) => (rankByKey.get(`${a.root}-${a.name}`) ?? 999) - (rankByKey.get(`${b.root}-${b.name}`) ?? 999));
        } else {
            // No MIDI weighting available: keep ordering stable and neutral.
            fullCandidates.sort((a, b) => {
                if (a.root !== b.root) return a.root - b.root;
                return String(a.name).localeCompare(String(b.name));
            });
        }
    } else {
        fullCandidates = weightedMatches.slice(0, 12).map(m => ({ root: m.root, name: m.name, rootName: midiToNoteName(m.root) }));
    }

    const totalCandidates = fullCandidates.length;
    const isLive = keyboardModeEnabled && keyboardMode === 'live';
    const isScrollEnabled = !!showAllScales;

    // Keep the full candidate list; the UI reserves a fixed area and hides overflow.
    const candidates = fullCandidates;

    const best = candidates[0];

    const selectedKey = lastAppliedScale
        ? { root: lastAppliedScale.root, name: lastAppliedScale.mode }
        : null;

    const bestForTitle = selectedKey || best;

    let headerText;
    if (lastAppliedScale) {
        const selectedLabel = `${midiToNoteName(lastAppliedScale.root)} ${lastAppliedScale.mode}`;
        headerText = `Selected key: ${selectedLabel}`;
    } else {
        if (isLive) {
            headerText = `Possible keys (held notes): (${totalCandidates})`;
        } else {
            headerText = (simpleMatches.length > 0)
                ? `Possible keys (contain all selected notes): (${candidates.length})`
                : `Closest Major/Minor keys: (${candidates.length})`;
        }
    }

    const scalesHtml = buildPossibleScalesSection(
        candidates,
        best,
        noteWeights,
        weightedMatches,
        {
            showEmphasis,
            isLive,
            totalCandidates,
            showAllEnabled: showAllScales,
            isScrollEnabled
        }
    );
    const whyHtml = (lastAppliedScale || !showEmphasis) ? '' : buildWhyDetails(best, noteWeights);

    scaleOutput.innerHTML = `
        <div class="result-block">
            <div class="possible-scales-header">${headerText}</div>
            ${scalesHtml}
            ${whyHtml}
        </div>
    `;

    if (keyboardModeEnabled) {
        selectionHint.textContent = (keyboardMode === 'live')
            ? 'Keyboard mode (Live): hold notes; release to change.'
            : 'Keyboard mode (Record): play notes to add them; Clear to start over.';
    } else {
        selectionHint.textContent = midiBaselinePitchClasses
            ? 'Select/deselect notes; scales update instantly.'
            : 'Manual mode: select notes; scales update instantly.';
    }
    if (showEmphasis || lastAppliedScale) {
        updateTitle(bestForTitle);
    } else {
        updateTitle(null);
    }
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
            lastAppliedScale = null;
            midiBaselineNoteWeights = noteWeights;
            midiBaselinePitchClasses = new Set(usedNotes);
            midiPctByPc = buildPctMap(noteWeights);

            piano.setMidiPercentages(midiPctByPc);
            piano.setSelectedPitchClasses(usedNotes, { silent: true });
            selectedPitchClasses = new Set(usedNotes);

            showAllScales = false;
            updateOutputFromSelection();
        });
    }

    reader.onerror = () => {
        selectionHint.textContent = 'Error reading file. Please try again.';
    }

    reader.readAsArrayBuffer(file);
}

resetAllBtn?.addEventListener('click', () => {
    // Full reset: forget the uploaded MIDI and return to a clean manual state.
    midiBaselineNoteWeights = null;
    midiBaselinePitchClasses = null;
    midiPctByPc = null;
    lastAppliedScale = null;
    showAllScales = false;

    if (fileName) {
        fileName.textContent = '';
        hide(fileName);
    }
    if (fileInput) {
        // Allow selecting the same file again.
        fileInput.value = '';
    }

    if (piano && typeof piano.clearMidiPercentages === 'function') {
        piano.clearMidiPercentages();
    }
    if (piano && typeof piano.setPressedPitchClasses === 'function') {
        piano.setPressedPitchClasses([]);
    }

    selectedPitchClasses = new Set();
    piano.setSelectedPitchClasses([], { silent: true });

    // Reset history to a single empty state.
    suppressHistory = true;
    history = [];
    historyIndex = -1;
    suppressHistory = false;
    pushHistory(new Set());

    updateOutputFromSelection();
});

clearBtn.addEventListener('click', () => {
    lastAppliedScale = null;
    showAllScales = false;
    applySelection([], { silent: true, recordHistory: true });
});

resetToMidiBtn.addEventListener('click', () => {
    if (!midiBaselinePitchClasses || midiBaselinePitchClasses.size === 0) return;
    lastAppliedScale = null;
    showAllScales = false;
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
    const toggleBtn = e.target.closest('[data-action="toggle-show-all-scales"]');
    if (toggleBtn) {
        showAllScales = !showAllScales;
        updateOutputFromSelection();
        return;
    }

    const btn = e.target.closest('[data-scale-root][data-scale-mode]');
    if (!btn) return;
    const root = Number(btn.dataset.scaleRoot);
    const mode = btn.dataset.scaleMode;
    if (!Number.isFinite(root) || !mode) return;

    const pcs = getScalePitchClasses(root, mode);
    lastAppliedScale = { root, mode };
    showAllScales = false;
    applySelection(pcs, { silent: true, recordHistory: true });
});

// Right-click scale preview: do not overwrite selection
scaleOutput.addEventListener('contextmenu', (e) => {
    const btn = e.target.closest('[data-scale-root][data-scale-mode]');
    if (!btn) return;
    e.preventDefault();

    const root = Number(btn.dataset.scaleRoot);
    const mode = btn.dataset.scaleMode;
    if (!Number.isFinite(root) || !mode) return;

    const midiSeq = buildScalePreviewMidiSequence(root, mode);
    if (piano && typeof piano.unlockAudioFromGesture === 'function') {
        piano.unlockAudioFromGesture();
    }
    if (piano && typeof piano.previewMidiSequence === 'function') {
        piano.previewMidiSequence(midiSeq, { velocity: 0.85, intervalMs: 190, endPauseMs: 160, endVelocity: 1 });
        return;
    }

    // Fallback (should be rare): play pitch-classes as-is.
    const pcs = getScalePitchClasses(root, mode);
    if (piano && typeof piano.previewPitchClassSequence === 'function') {
        piano.previewPitchClassSequence(pcs, { velocity: 0.85, intervalMs: 190 });
    } else if (piano && typeof piano.previewPitchClasses === 'function') {
        piano.previewPitchClasses(pcs, { velocity: 0.85, intervalMs: 190 });
    }
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

    const perfectCount = enriched.filter(m => m.inPct === 100).length;

    const extraParts = [];
    if (bestInPct < maxInPct) {
        extraParts.push('Match% just means notes are inside the key. Best guess also looks at which notes are emphasized.');
    }
    if (perfectCount > 1) {
        extraParts.push('When multiple keys are 100% match, the order is a tie-break based on note emphasis (tonic/3rd/5th).');
    }
    const extra = extraParts.length ? ` ${extraParts.join(' ')}` : '';

    return `<div class="hint-text">Many keys can contain the same notes. The one tagged “Best guess” uses which notes are emphasized in the MIDI/selection.${extra}</div>`;
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

function buildPossibleScalesSection(candidates, best, noteWeights, weightedMatches, options = {}) {
    const rankByKey = new Map(
        (weightedMatches || []).map((m, idx) => [`${m.root}-${m.name}`, idx])
    );

    const {
        showEmphasis = true,
        isLive = false,
        totalCandidates = candidates.length,
        showAllEnabled = false,
        isScrollEnabled = false
    } = options;

    const selectedKey = lastAppliedScale ? { root: lastAppliedScale.root, name: lastAppliedScale.mode } : null;
    const enriched = candidates.map(m => {
        const isSelected = selectedKey ? (m.root === selectedKey.root && m.name === selectedKey.name) : false;
        const isBest = selectedKey ? isSelected : (m.root === best.root && m.name === best.name);
        const { inPct, outPct } = computeScaleCoveragePct(m.root, m.name, noteWeights);
        const weightedRank = rankByKey.get(`${m.root}-${m.name}`) ?? 999;
        return { ...m, isBest, isSelected, inPct, outPct, weightedRank };
    });

    enriched.sort((a, b) => {
        if (a.isBest !== b.isBest) return a.isBest ? -1 : 1;
        if (b.inPct !== a.inPct) return b.inPct - a.inPct;
        if (a.outPct !== b.outPct) return a.outPct - b.outPct;
        return a.weightedRank - b.weightedRank;
    });

    const perfectCount = enriched.filter(m => m.inPct === 100).length;

    const rel = (lastAppliedScale)
        ? {
            root: lastAppliedScale.mode === 'Major'
                ? (lastAppliedScale.root + 9) % 12
                : (lastAppliedScale.root + 3) % 12,
            mode: lastAppliedScale.mode === 'Major' ? 'Minor' : 'Major'
        }
        : null;

    const items = enriched.map(m => {
        const label = `${midiToNoteName(m.root)} ${m.name}`;
        const isRelative = !!(rel && m.root === rel.root && m.name === rel.mode);

        if (!showEmphasis) {
            const metaText = m.isSelected ? 'Selected'
                : (isRelative ? 'Relative key'
                    : `${m.inPct}% match`);

            return `
                <li class="scale-item scale-item--compact${m.isBest ? " best" : ""}">
                    <button type="button" class="scale-item-btn scale-item-btn--compact" data-scale-root="${m.root}" data-scale-mode="${m.name}" aria-label="Select ${label}">
                        <span class="scale-compact-name">${label}</span>
                        <span class="scale-compact-meta">${metaText}</span>
                    </button>
                </li>
            `;
        }

        const showEmphasisRank = showEmphasis && perfectCount > 1 && m.inPct === 100 && m.weightedRank < 999;
        const emphasis = showEmphasisRank ? ` · emphasis #${m.weightedRank + 1}` : '';

        const meta = m.isSelected ? 'Selected'
            : (isRelative ? 'Relative key'
                : ((m.outPct > 0)
                    ? `${m.inPct}% match · ${m.outPct}% outside${emphasis}`
                    : `${m.inPct}% match${emphasis}`));

        const tag = m.isSelected
            ? '<span class="scale-tag">Selected</span>'
            : (!lastAppliedScale && m.isBest)
                ? '<span class="scale-tag">Best guess</span>'
                : '';

        return `
            <li class="scale-item${m.isBest ? " best" : ""}">
                <button type="button" class="scale-item-btn" data-scale-root="${m.root}" data-scale-mode="${m.name}" aria-label="Select ${label}">
                    <div class="scale-line">
                        <span class="scale-name">${label}</span>
                        ${tag}
                    </div>
                    <div class="scale-meta">${meta}</div>
                </button>
            </li>
        `;
    }).join("");

    const shouldShowToggle = totalCandidates > 10;
    const toggleBtn = shouldShowToggle
        ? `<button type="button" class="scale-toggle-btn" data-action="toggle-show-all-scales" aria-pressed="${showAllEnabled ? 'true' : 'false'}">
                ${showAllEnabled ? 'Hide' : `Show all (${totalCandidates})`}
           </button>`
        : '';

    const fixedWrapClass = `scale-list-wrap scale-list-wrap--fixed${showAllEnabled ? ' scale-list-wrap--scroll' : ''}`;
    const fixedListClass = !showEmphasis
        ? 'scale-list scale-list--compact'
        : 'scale-list scale-list--onecol';

    const footer = `
        <div class="hint-text scale-footer">
            <span>Tip: Right-click a key for preview.</span>
            ${toggleBtn}
        </div>
    `;

    return `
        <div class="${fixedWrapClass}">
            <ul class="${fixedListClass}">${items}</ul>
        </div>
        ${footer}
    `;
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

function cleanupTransientInputState() {
    // BFCache/tab restore can skip keyup events and keep JS state alive.
    // Reset transient held/pressed state and stop any queued previews/audio.
    heldKeyboardCodes.clear();
    if (piano && typeof piano.setPressedPitchClasses === 'function') {
        piano.setPressedPitchClasses([]);
    }
    if (piano && typeof piano.stopAllAudio === 'function') {
        piano.stopAllAudio();
    } else if (piano && typeof piano.cancelPreviews === 'function') {
        piano.cancelPreviews();
    }
    if (keyboardModeEnabled && keyboardMode === 'live') {
        updateOutputFromSelection();
    }
}

window.addEventListener('pagehide', cleanupTransientInputState);
window.addEventListener('pageshow', (e) => {
    if (e && e.persisted) cleanupTransientInputState();
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden) cleanupTransientInputState();
});

function setKeyboardModeEnabled(nextEnabled) {
    keyboardModeEnabled = !!nextEnabled;
    if (keyboardInputMode) keyboardInputMode.disabled = !keyboardModeEnabled;

    // Do not force showAllScales off here; it's a page-wide preference.

    if (!keyboardModeEnabled) {
        heldKeyboardCodes.clear();
        syncPressedFromKeyboard();
        updateOutputFromSelection();
    } else {
        syncPressedFromKeyboard();
        updateOutputFromSelection();
    }
}

if (keyboardInputMode) {
    keyboardMode = keyboardInputMode.value === 'live' ? 'live' : 'record';
}

if (keyboardModeToggle) {
    keyboardModeToggle.addEventListener('change', () => {
        if (keyboardModeToggle.checked) {
            if (piano && typeof piano.unlockAudioFromGesture === 'function') {
                piano.unlockAudioFromGesture();
            }
        }
        setKeyboardModeEnabled(keyboardModeToggle.checked);
    });
}

if (keyboardInputMode) {
    keyboardInputMode.addEventListener('change', () => {
        keyboardMode = keyboardInputMode.value === 'live' ? 'live' : 'record';
        updateOutputFromSelection();
    });
}

window.addEventListener('blur', () => {
    if (!keyboardModeEnabled) return;
    heldKeyboardCodes.clear();
    syncPressedFromKeyboard();
    if (keyboardMode === 'live') updateOutputFromSelection();
});

window.addEventListener('keydown', (e) => {
    if (!keyboardModeEnabled) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditableTarget(e.target)) return;

    const midi = KEYBOARD_MIDI_BY_CODE[e.code];
    if (!Number.isFinite(midi)) return;
    if (e.repeat) {
        e.preventDefault();
        return;
    }

    e.preventDefault();

    heldKeyboardCodes.add(e.code);
    syncPressedFromKeyboard();

    lastAppliedScale = null;
    if (piano && typeof piano.unlockAudioFromGesture === 'function') {
        piano.unlockAudioFromGesture();
    }
    if (piano && typeof piano.playMidiNote === 'function') {
        piano.playMidiNote(midi, 0.95);
    }

    const pc = ((midi % 12) + 12) % 12;
    if (keyboardMode === 'record') {
        if (!selectedPitchClasses.has(pc)) {
            const next = new Set(selectedPitchClasses);
            next.add(pc);
            applySelection([...next], { silent: true, recordHistory: true });
        }
    } else {
        updateOutputFromSelection(getHeldPitchClasses());
    }
});

window.addEventListener('keyup', (e) => {
    if (!keyboardModeEnabled) return;
    if (isEditableTarget(e.target)) return;

    const midi = KEYBOARD_MIDI_BY_CODE[e.code];
    if (!Number.isFinite(midi)) return;

    e.preventDefault();

    heldKeyboardCodes.delete(e.code);
    syncPressedFromKeyboard();

    if (keyboardMode === 'live') {
        updateOutputFromSelection(getHeldPitchClasses());
    }
});
