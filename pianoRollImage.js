const BLACK_PITCHES = new Set([1, 3, 6, 8, 10]);
const MIN_BLACK_KEYS = 5;
const BLACK_KEY_MAX = 110;
const WHITE_KEY_MIN = 125;
const MAX_IMAGE_EDGE = 2400;
const pitchClass = note => ((note % 12) + 12) % 12;

function blackKeyRuns(lightness, x, height) {
    const runs = [];
    let start = -1;
    for (let y = 0; y <= height; y++) {
        if (y < height && lightness(x, y) < BLACK_KEY_MAX) {
            if (start < 0) start = y;
        } else if (start >= 0) {
            const size = y - start;
            const shoulder = Math.max(2, Math.round(size * 0.2));
            if (start >= shoulder && y + shoulder <= height && size >= 4 && size <= 80
                && lightness(x, start - shoulder) >= WHITE_KEY_MIN
                && lightness(x, y + shoulder - 1) >= WHITE_KEY_MIN) {
                runs.push({ center: (start + y - 1) / 2, size });
            }
            start = -1;
        }
    }
    return runs;
}

function traceKeyboard(runs, start, firstPitch) {
    const first = runs[start];
    const rows = [{ center: first.center, offset: 0 }];
    let pitch = firstPitch;
    let step = first.size;
    let offset = 0;

    for (let i = start + 1; i < runs.length; i++) {
        let interval = 1;
        while (!BLACK_PITCHES.has(pitchClass(pitch - interval))) interval++;
        const previous = rows.at(-1);
        const run = runs[i];
        const measuredStep = (run.center - previous.center) / interval;
        if (Math.abs(measuredStep - step) > step * 0.22
            || Math.abs(run.size - measuredStep) > measuredStep * 0.35) break;

        offset += interval;
        pitch = pitchClass(pitch - interval);
        rows.push({ center: run.center, offset });
        step = (run.center - first.center) / offset;
    }

    if (rows.length < MIN_BLACK_KEYS) return null;
    // Average the origin across the observed rows to reduce fractional-pixel error.
    const origin = rows.reduce((sum, row) => sum + row.center - row.offset * step, 0) / rows.length;
    return { firstPitch, origin, step, offset, rows: rows.length };
}

function findKeyboard(lightness, width, height) {
    let best = null;
    const searchRight = Math.min(Math.floor(width / 3), 640);
    for (let x = 0; x < searchRight; x += 2) {
        const runs = blackKeyRuns(lightness, x, height);
        for (let start = 0; start <= runs.length - MIN_BLACK_KEYS; start++) {
            for (const pitch of BLACK_PITCHES) {
                const candidate = traceKeyboard(runs, start, pitch);
                if (!candidate || (best && candidate.rows <= best.rows)) continue;
                best = { ...candidate, x };
            }
        }
    }
    return best;
}

function findGridLeft(keyboard, lightness, width) {
    const whiteRows = [];
    for (let row = 0; row <= keyboard.offset; row++) {
        if (!BLACK_PITCHES.has(pitchClass(keyboard.firstPitch - row))) {
            whiteRows.push(Math.round(keyboard.origin + row * keyboard.step));
        }
    }
    const rightLimit = Math.min(width, keyboard.x + Math.ceil(keyboard.step * 16));
    let boundary = keyboard.x;
    // Most sampled white-key rows stay bright until the start of the dark note grid.
    for (let x = keyboard.x; x < rightLimit; x++) {
        const bright = whiteRows.filter(y => lightness(x, y) >= WHITE_KEY_MIN).length;
        if (bright >= whiteRows.length * 0.7) boundary = x;
        if (x - boundary >= 4) return boundary + 1;
    }
    return null;
}

function rowNoteWidth(data, width, gridLeft, center, step) {
    const inset = Math.max(1, Math.round(step * 0.2));
    const sampleRows = [center - inset, center, center + inset];
    const minWidth = Math.max(3, Math.round(step * 0.25));
    let run = 0;
    let total = 0;
    for (let x = gridLeft; x <= width; x++) {
        let matches = 0;
        if (x < width) {
            for (const y of sampleRows) {
                const i = (y * width + x) * 4;
                const max = Math.max(data[i], data[i + 1], data[i + 2]);
                const min = Math.min(data[i], data[i + 1], data[i + 2]);
                if (data[i + 3] >= 180 && max >= 120 && max - min >= 27) matches++;
            }
        }
        if (matches >= 2) run++;
        else {
            if (run >= minWidth) total += run;
            run = 0;
        }
    }
    return total;
}

export function detectPianoRollNotes({ data, width, height }) {
    const lightness = (x, y) => {
        const i = (y * width + x) * 4;
        return (data[i] + data[i + 1] + data[i + 2]) / 3;
    };
    const keyboard = findKeyboard(lightness, width, height);
    const gridLeft = keyboard && findGridLeft(keyboard, lightness, width);
    if (!keyboard || gridLeft === null || gridLeft - keyboard.x < 8 || width - gridLeft < 32) {
        throw new Error('Could not find the piano keys. Crop to the FL Studio piano roll and include at least one octave of the keyboard on the left.');
    }

    const noteWeights = new Map();
    // An edge can have up to two additional white rows beyond the outermost black key.
    for (let row = -2; row <= keyboard.offset + 2; row++) {
        const center = Math.round(keyboard.origin + row * keyboard.step);
        const pitch = pitchClass(keyboard.firstPitch - row);
        if (center - keyboard.step * 0.25 < 0 || center + keyboard.step * 0.25 >= height) continue;
        const tone = lightness(keyboard.x, center);
        if (BLACK_PITCHES.has(pitch) ? tone >= BLACK_KEY_MAX : tone < WHITE_KEY_MIN) continue;

        const pixels = rowNoteWidth(data, width, gridLeft, center, keyboard.step);
        if (pixels > 0) noteWeights.set(pitch, (noteWeights.get(pitch) ?? 0) + pixels);
    }
    if (!noteWeights.size) {
        throw new Error('Could not find colored notes. Capture the note grid with active notes visible.');
    }
    return noteWeights;
}

export async function readPianoRollImage(file) {
    if (file.size > 20 * 1024 * 1024) throw new Error('Choose a screenshot under 20 MB.');
    let image;
    try {
        image = await createImageBitmap(file);
    } catch {
        throw new Error('Could not open the image. Try a PNG, JPEG, or WebP screenshot.');
    }
    try {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Image analysis is unavailable in this browser.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return detectPianoRollNotes(context.getImageData(0, 0, canvas.width, canvas.height));
    } finally {
        image.close();
    }
}
