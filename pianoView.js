const PITCH_CLASS_TO_SHARP_NAME = [
    'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'
];

const WHITE_KEYS_TOP_TO_BOTTOM = [11, 9, 7, 5, 4, 2, 0];
const BLACK_KEYS = [
    { pc: 10, lowerWhiteIndex: 1 }, // A# between B(0) and A(1)
    { pc: 8, lowerWhiteIndex: 2 },  // G# between A(1) and G(2)
    { pc: 6, lowerWhiteIndex: 3 },  // F# between G(2) and F(3)
    { pc: 3, lowerWhiteIndex: 5 },  // D# between E(4) and D(5)
    { pc: 1, lowerWhiteIndex: 6 }   // C# between D(5) and C(6)
];

// Base frequency for C4 (used for pitch-class playback)
const C4_HZ = 261.63;

function clampPct(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return null;
    const rounded = Math.round(value);
    return Math.max(0, Math.min(100, rounded));
}

function noteNameForPc(pc) {
    return PITCH_CLASS_TO_SHARP_NAME[pc % 12];
}

export function createVerticalPiano({ mountEl, onSelectionChange }) {
    if (!mountEl) {
        throw new Error('createVerticalPiano: mountEl is required');
    }

    const WHITE_KEY_HEIGHT = 48;
    const WHITE_KEY_GAP = 0;
    const BLACK_KEY_HEIGHT = 32;

    let selected = new Set();
    let midiPctByPc = new Map();
    let suppressCallback = false;

    let audioContext = null;
    let shaperCurve = null;

    let previewToken = 0;

    function ensureAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }

        if (!shaperCurve) {
            // Soft clip curve (cached once per session)
            const curve = new Float32Array(44100);
            for (let i = 0; i < curve.length; i++) {
                const x = (i * 2) / curve.length - 1;
                curve[i] = Math.tanh(2.2 * x);
            }
            shaperCurve = curve;
        }
    }

    function playPc(pc, velocity = 1) {
        try {
            ensureAudioContext();
            if (!audioContext) return;

            const now = audioContext.currentTime;
            const freq = C4_HZ * Math.pow(2, (pc % 12) / 12);

            const vel = Math.max(0, Math.min(1, velocity));

            // Output chain: tone filter -> compressor -> soft clip -> envelope -> destination
            const out = audioContext.createGain();
            const compressor = audioContext.createDynamicsCompressor();
            const lp = audioContext.createBiquadFilter();
            const shaper = audioContext.createWaveShaper();

            // Brighter for higher notes; darker for lower
            const cutoff = 2600 + (pc % 12) * 140;
            lp.type = 'lowpass';
            lp.frequency.setValueAtTime(cutoff, now);
            lp.Q.setValueAtTime(0.85, now);

            compressor.threshold.setValueAtTime(-30, now);
            compressor.ratio.setValueAtTime(4, now);
            compressor.attack.setValueAtTime(0.003, now);
            compressor.release.setValueAtTime(0.18, now);

            shaper.curve = shaperCurve;
            shaper.oversample = '2x';

            // Main envelope: fast attack, longer decay/sustain
            out.gain.setValueAtTime(0.0001, now);
            out.gain.exponentialRampToValueAtTime(0.26 * vel, now + 0.01);
            out.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);

            // Harmonics (piano-like partials) with tiny detune
            const partials = [
                { ratio: 1.0, gain: 0.60 },
                { ratio: 2.0, gain: 0.30 },
                { ratio: 3.0, gain: 0.15 },
                { ratio: 4.0, gain: 0.08 }
            ];

            const sum = audioContext.createGain();
            sum.gain.setValueAtTime(1, now);

            const oscillators = [];
            for (const p of partials) {
                const osc = audioContext.createOscillator();
                const g = audioContext.createGain();

                // Low notes: triangle for body; high notes: sine for clarity
                osc.type = (pc % 12) <= 6 ? 'triangle' : 'sine';
                osc.frequency.setValueAtTime(freq * p.ratio, now);
                osc.detune.setValueAtTime((Math.random() - 0.5) * 3, now);
                g.gain.setValueAtTime(p.gain, now);
                osc.connect(g);
                g.connect(sum);
                oscillators.push(osc);
            }

            // Hammer transient: short noise burst
            const noiseBuf = audioContext.createBuffer(1, Math.floor(audioContext.sampleRate * 0.04), audioContext.sampleRate);
            const data = noiseBuf.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length / 3));
            }
            const noise = audioContext.createBufferSource();
            noise.buffer = noiseBuf;
            const bp = audioContext.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.setValueAtTime(2500, now);
            bp.Q.setValueAtTime(1.5, now);
            const ng = audioContext.createGain();
            ng.gain.setValueAtTime(0.08 * vel, now);
            ng.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
            noise.connect(bp);
            bp.connect(ng);
            ng.connect(sum);

            sum.connect(lp);
            lp.connect(compressor);
            compressor.connect(shaper);
            shaper.connect(out);
            out.connect(audioContext.destination);

            for (const osc of oscillators) {
                osc.start(now);
                osc.stop(now + 2.6);
            }
            noise.start(now);
            noise.stop(now + 0.03);
        } catch {
            // Ignore audio failures (e.g. blocked by browser policy)
        }
    }

    function previewPitchClasses(pcs, { velocity = 0.85, intervalMs = 190 } = {}) {
        const token = ++previewToken;
        const ordered = [...new Set((pcs || []).map(Number))].sort((a, b) => a - b);
        if (ordered.length === 0) return;

        ordered.forEach((pc, idx) => {
            window.setTimeout(() => {
                if (token !== previewToken) return;
                playPc(pc, velocity);
            }, idx * intervalMs);
        });
    }

    function render() {
        mountEl.innerHTML = `
            <div class="vpiano" style="--white-h:${WHITE_KEY_HEIGHT}px; --white-gap:${WHITE_KEY_GAP}px; --black-h:${BLACK_KEY_HEIGHT}px;">
                <div class="vpiano-white" id="vpianoWhite"></div>
                <div class="vpiano-black" id="vpianoBlack" aria-hidden="false"></div>
            </div>
        `;

        const whiteEl = mountEl.querySelector('#vpianoWhite');
        const blackEl = mountEl.querySelector('#vpianoBlack');

        for (const pc of WHITE_KEYS_TOP_TO_BOTTOM) {
            const key = document.createElement('button');
            key.type = 'button';
            key.className = 'vpiano-key vpiano-white-key';
            key.dataset.pc = String(pc);
            key.innerHTML = `
                <div class="vpiano-label">
                    <div class="vpiano-note">${noteNameForPc(pc)}</div>
                    <div class="vpiano-pct"></div>
                </div>
            `;
            key.addEventListener('mouseenter', () => playPc(pc, 0.8));
            key.addEventListener('click', () => togglePc(pc, { play: true }));
            key.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                deselectPc(pc);
            });
            whiteEl.appendChild(key);
        }

        for (const { pc, lowerWhiteIndex } of BLACK_KEYS) {
            const key = document.createElement('button');
            key.type = 'button';
            key.className = 'vpiano-key vpiano-black-key';
            key.dataset.pc = String(pc);

            const step = WHITE_KEY_HEIGHT + WHITE_KEY_GAP;
            const borderPx = (lowerWhiteIndex * step);
            const topPx = borderPx - (BLACK_KEY_HEIGHT / 2);
            key.style.top = `${Math.round(topPx)}px`;

            key.innerHTML = `
                <div class="vpiano-label">
                    <div class="vpiano-note">${noteNameForPc(pc)}</div>
                    <div class="vpiano-pct"></div>
                </div>
            `;
            key.addEventListener('mouseenter', () => playPc(pc, 0.8));
            key.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePc(pc, { play: true });
            });
            key.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                deselectPc(pc);
            });
            blackEl.appendChild(key);
        }

        syncAllKeyStates();
        syncAllKeyPercentages();
    }

    function syncAllKeyStates() {
        const keys = mountEl.querySelectorAll('.vpiano-key');
        keys.forEach((key) => {
            const pc = Number(key.dataset.pc);
            key.classList.toggle('selected', selected.has(pc));
            key.setAttribute('aria-pressed', selected.has(pc) ? 'true' : 'false');
        });
    }

    function syncAllKeyPercentages() {
        const keys = mountEl.querySelectorAll('.vpiano-key');
        keys.forEach((key) => {
            const pc = Number(key.dataset.pc);
            const pctEl = key.querySelector('.vpiano-pct');
            if (!pctEl) return;

            const pct = midiPctByPc.has(pc) ? clampPct(midiPctByPc.get(pc)) : null;
            pctEl.textContent = pct == null ? '' : `${pct}%`;
            key.classList.toggle('has-midi-pct', pct != null);
        });
    }

    function emitChange() {
        if (suppressCallback) return;
        if (typeof onSelectionChange === 'function') {
            onSelectionChange(new Set(selected));
        }
    }

    function togglePc(pc, { play = false } = {}) {
        if (selected.has(pc)) {
            selected.delete(pc);
        } else {
            selected.add(pc);
            if (play) playPc(pc, 1);
        }
        syncAllKeyStates();
        emitChange();
    }

    function deselectPc(pc) {
        if (!selected.has(pc)) return;
        selected.delete(pc);
        syncAllKeyStates();
        emitChange();
    }

    function setSelectedPitchClasses(pcs, { silent = false } = {}) {
        const next = new Set((pcs || []).map((v) => Number(v)));
        suppressCallback = silent;
        selected = next;
        syncAllKeyStates();
        suppressCallback = false;
        if (!silent) emitChange();
    }

    function setMidiPercentages(pctMap) {
        midiPctByPc = new Map();

        if (pctMap instanceof Map) {
            for (const [pc, pct] of pctMap.entries()) {
                midiPctByPc.set(Number(pc), pct);
            }
        } else if (pctMap && typeof pctMap === 'object') {
            for (const [pc, pct] of Object.entries(pctMap)) {
                midiPctByPc.set(Number(pc), pct);
            }
        }

        syncAllKeyPercentages();
    }

    function clearMidiPercentages() {
        midiPctByPc = new Map();
        syncAllKeyPercentages();
    }

    function getSelectedPitchClasses() {
        return [...selected];
    }

    render();

    return {
        setSelectedPitchClasses,
        setMidiPercentages,
        clearMidiPercentages,
        getSelectedPitchClasses,
        toggleNote: (noteName) => {
            const idx = PITCH_CLASS_TO_SHARP_NAME.indexOf(noteName);
            if (idx >= 0) togglePc(idx, { play: false });
        },
        selectNote: (noteName) => {
            const idx = PITCH_CLASS_TO_SHARP_NAME.indexOf(noteName);
            if (idx >= 0 && !selected.has(idx)) togglePc(idx, { play: false });
        },
        deselectNote: (noteName) => {
            const idx = PITCH_CLASS_TO_SHARP_NAME.indexOf(noteName);
            if (idx >= 0 && selected.has(idx)) togglePc(idx, { play: false });
        },
        clearSelection: () => setSelectedPitchClasses([], { silent: false }),
        selectNotes: (noteNames) => {
            const pcs = (noteNames || [])
                .map((n) => PITCH_CLASS_TO_SHARP_NAME.indexOf(n))
                .filter((pc) => pc >= 0);
            setSelectedPitchClasses(pcs, { silent: false });
        },
        previewPitchClasses
    };
}
