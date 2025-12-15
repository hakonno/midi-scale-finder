import {
    readMidi,
    midiToNoteName,
    findMatchingScalesSimple,
    getScalePitchClasses
} from './scaleDetector.js';

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("fileName");
const output = document.getElementById("output");

// Store last processed data so we can re-render without re-reading the file
let lastProcessedData = null;

const hide = (el) => el.classList.add("hidden");
const show = (el) => el.classList.remove("hidden");

function displayResults(data) {
    const { usedNotes, noteWeights, matches: weightedMatches } = data;

    output.innerHTML = buildResultsLayout(usedNotes, noteWeights, weightedMatches);
    show(output);
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

function sumWeights(noteWeights) {
    let total = 0;
    for (const v of noteWeights.values()) total += v;
    return total;
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
                <div class="scale-line">
                    <span class="scale-name">${label}</span>
                    ${m.isBest ? '<span class="scale-tag">Best guess</span>' : ''}
                </div>
                <div class="scale-meta">${meta}</div>
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
