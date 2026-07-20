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
    let pressed = new Set();
    let midiPctByPc = new Map();
    let suppressCallback = false;

    let audioContext = null;
    let masterBus = null;
    let hammerBuffer = null;
    let audioUnlocked = false;

    let previewToken = 0;
    const previewTimeouts = new Set();

    function cancelPreviews() {
        previewToken++;
        for (const id of previewTimeouts) {
            window.clearTimeout(id);
        }
        previewTimeouts.clear();
    }

    function stopAllAudio() {
        cancelPreviews();

        if (audioContext) {
            try {
                audioContext.close();
            } catch {
                // ignore
            }
        }
        audioContext = null;
        masterBus = null;
        hammerBuffer = null;
        audioUnlocked = false;
    }

    function schedulePreview(fn, delayMs) {
        const id = window.setTimeout(() => {
            previewTimeouts.delete(id);
            fn();
        }, delayMs);
        previewTimeouts.add(id);
        return id;
    }

    function ensureAudioContext() {
        // WebAudio autoplay policy: only create/resume audio from a user gesture.
        // Also avoid work while hidden to prevent delayed "bursts" on restore.
        if (!audioUnlocked) return;
        if (typeof document !== 'undefined' && document.hidden) return;

        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            // If resume is blocked, we keep the context suspended and avoid starting voices.
            audioContext.resume().catch(() => {});
        }

        if (!masterBus) {
            masterBus = buildMasterBus(audioContext);
        }
        if (!hammerBuffer) {
            hammerBuffer = buildHammerBuffer(audioContext);
        }
    }

    // Shared output chain: voices -> gain -> compressor -> destination,
    // with a subtle parallel room reverb (generated impulse response).
    function buildMasterBus(ctx) {
        const input = ctx.createGain();
        input.gain.value = 0.9;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 18;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.22;

        const convolver = ctx.createConvolver();
        convolver.buffer = buildImpulseResponse(ctx, 1.6, 2.8);
        const reverbGain = ctx.createGain();
        reverbGain.gain.value = 0.14;

        input.connect(compressor);
        input.connect(convolver);
        convolver.connect(reverbGain);
        reverbGain.connect(compressor);
        compressor.connect(ctx.destination);

        return { input };
    }

    function buildImpulseResponse(ctx, seconds, decayPower) {
        const rate = ctx.sampleRate;
        const length = Math.floor(rate * seconds);
        const buf = ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = buf.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decayPower);
            }
        }
        return buf;
    }

    function buildHammerBuffer(ctx) {
        const length = Math.floor(ctx.sampleRate * 0.03);
        const buf = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length / 4));
        }
        return buf;
    }

    function isAudioRunning() {
        return !!(audioContext && audioContext.state === 'running');
    }

    function unlockAudioFromGesture() {
        audioUnlocked = true;
        ensureAudioContext();
        return isAudioRunning();
    }

    function playVoice({ freq, velocity = 1 }) {
        try {
            if (typeof document !== 'undefined' && document.hidden) return;
            ensureAudioContext();
            if (!audioContext || audioContext.state !== 'running' || !masterBus) return;

            const ctx = audioContext;
            const now = ctx.currentTime;
            const f0 = typeof freq === 'number' && Number.isFinite(freq) && freq > 0 ? freq : C4_HZ;
            const vel = Math.max(0, Math.min(1, velocity));

            // Register position 0..1 across the piano range (A0..C8)
            const midi = 69 + 12 * Math.log2(f0 / 440);
            const reg = Math.max(0, Math.min(1, (midi - 21) / 87));

            // Bass rings long, treble dies fast
            const duration = 4.5 - reg * 3.2;

            // Two-stage envelope: sharp strike decay, then slow sing-out
            const strikeLevel = 0.35 * (0.3 + 0.7 * vel);
            const out = ctx.createGain();
            out.gain.setValueAtTime(0.0001, now);
            out.gain.exponentialRampToValueAtTime(strikeLevel, now + 0.004);
            out.gain.exponentialRampToValueAtTime(strikeLevel * 0.4, now + 0.28);
            out.gain.exponentialRampToValueAtTime(0.0001, now + duration);

            // Body filter: opens with pitch and velocity, darkens as the note rings out
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.setValueAtTime(Math.min(f0 * (5 + vel * 5), 11000), now);
            lp.frequency.exponentialRampToValueAtTime(Math.max(f0 * 2.5, 400), now + duration);
            lp.Q.setValueAtTime(0.6, now);

            lp.connect(out);
            out.connect(masterBus.input);

            // Stretched (inharmonic) partials; stiffness grows toward the treble
            const inharmonicity = 0.0001 * Math.pow(2, reg * 4);
            const rolloff = 0.4 + 0.3 * vel; // velocity opens up the upper partials
            const nyquist = ctx.sampleRate / 2;

            const partials = [];
            let ampTotal = 0;
            for (let n = 1; n <= 8; n++) {
                const pf = f0 * n * Math.sqrt(1 + inharmonicity * n * n);
                if (n > 1 && pf > nyquist * 0.45) break;
                const amp = Math.pow(rolloff, n - 1);
                partials.push({ n, pf, amp });
                ampTotal += amp;
            }

            const sources = [];
            for (const { n, pf, amp } of partials) {
                const g = ctx.createGain();
                const level = amp / ampTotal;
                // Higher partials decay faster, so the tone darkens over time
                const partialDecay = Math.max(duration / (1 + 0.9 * (n - 1)), 0.15);
                g.gain.setValueAtTime(level, now);
                g.gain.exponentialRampToValueAtTime(level * 0.001, now + partialDecay);
                g.connect(lp);

                // Fundamental gets a detuned unison pair (slow beating, like multi-string notes)
                const detunes = n === 1 ? [-1.6, 1.6] : [(Math.random() - 0.5) * 2.4];
                for (const cents of detunes) {
                    const osc = ctx.createOscillator();
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(pf, now);
                    osc.detune.setValueAtTime(cents, now);
                    const og = ctx.createGain();
                    og.gain.value = 1 / detunes.length;
                    osc.connect(og);
                    og.connect(g);
                    sources.push(osc);
                }
            }

            // Hammer strike: short filtered noise burst, brighter and louder when hit harder
            const noise = ctx.createBufferSource();
            noise.buffer = hammerBuffer;
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.setValueAtTime(Math.max(1200, Math.min(f0 * 9, 7500)), now);
            bp.Q.setValueAtTime(0.9, now);
            const ng = ctx.createGain();
            ng.gain.setValueAtTime(0.01 + 0.1 * vel * vel, now);
            ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
            noise.connect(bp);
            bp.connect(ng);
            ng.connect(lp);

            const stopAt = now + duration + 0.05;
            for (const src of sources) {
                src.start(now);
                src.stop(stopAt);
            }
            noise.start(now);
            noise.stop(now + 0.035);

            // Free the voice graph once the sources end
            if (sources.length > 0) {
                sources[0].onended = () => {
                    try { out.disconnect(); } catch { /* already gone */ }
                };
            }
        } catch {
            // Ignore audio failures (e.g. blocked by browser policy)
        }
    }

    function playPc(pc, velocity = 1) {
        const freq = C4_HZ * Math.pow(2, (pc % 12) / 12);
        playVoice({ freq, velocity });
    }

    function playMidiNote(midi, velocity = 1) {
        const midiNum = Number(midi);
        if (!Number.isFinite(midiNum)) return;
        const freq = 440 * Math.pow(2, (midiNum - 69) / 12);
        playVoice({ freq, velocity });
    }

    function previewPitchClasses(pcs, { velocity = 0.85, intervalMs = 190 } = {}) {
        ensureAudioContext();
        if (!isAudioRunning()) return;
        cancelPreviews();
        const token = ++previewToken;
        const ordered = [...new Set((pcs || []).map(Number))].sort((a, b) => a - b);
        if (ordered.length === 0) return;

        ordered.forEach((pc, idx) => {
            schedulePreview(() => {
                if (token !== previewToken) return;
                playPc(pc, velocity);
            }, idx * intervalMs);
        });
    }

    function previewPitchClassSequence(sequence, {
        velocity = 0.85,
        intervalMs = 190,
        endPauseMs = 140,
        endVelocity = 1
    } = {}) {
        ensureAudioContext();
        if (!isAudioRunning()) return;
        cancelPreviews();
        const token = ++previewToken;
        const seq = (sequence || []).map(Number).filter((v) => Number.isFinite(v));
        if (seq.length === 0) return;

        let t = 0;
        seq.forEach((pc, idx) => {
            const isLast = idx === seq.length - 1;
            const v = isLast ? endVelocity : velocity;

            schedulePreview(() => {
                if (token !== previewToken) return;
                playPc(pc, v);
            }, t);

            t += intervalMs;
            if (!isLast && idx === seq.length - 2) {
                t += endPauseMs;
            }
        });
    }

    function previewMidiSequence(sequence, {
        velocity = 0.85,
        intervalMs = 190,
        endPauseMs = 160,
        endVelocity = 1
    } = {}) {
        ensureAudioContext();
        if (!isAudioRunning()) return;
        cancelPreviews();
        const token = ++previewToken;
        const seq = (sequence || []).map(Number).filter((v) => Number.isFinite(v));
        if (seq.length === 0) return;

        let t = 0;
        seq.forEach((midi, idx) => {
            const isLast = idx === seq.length - 1;
            const v = isLast ? endVelocity : velocity;

            schedulePreview(() => {
                if (token !== previewToken) return;
                playMidiNote(midi, v);
            }, t);

            t += intervalMs;
            if (!isLast && idx === seq.length - 2) {
                t += endPauseMs;
            }
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
            key.addEventListener('mouseenter', () => {
                // Hover should never attempt to unlock audio (autoplay policy).
                if (!isAudioRunning()) return;
                playPc(pc, 0.8);
            });
            key.addEventListener('click', () => {
                unlockAudioFromGesture();
                togglePc(pc, { play: true });
            });
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
            key.addEventListener('mouseenter', () => {
                if (!isAudioRunning()) return;
                playPc(pc, 0.8);
            });
            key.addEventListener('click', (e) => {
                e.stopPropagation();
                unlockAudioFromGesture();
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
            key.classList.toggle('pressed', pressed.has(pc));
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

    function setPressedPitchClasses(pcs) {
        pressed = new Set((pcs || []).map((v) => Number(v)));
        syncAllKeyStates();
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
        setPressedPitchClasses,
        setMidiPercentages,
        clearMidiPercentages,
        getSelectedPitchClasses,
        playMidiNote,
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
        previewPitchClasses,
        previewPitchClassSequence,
        previewMidiSequence,
        cancelPreviews,
        stopAllAudio,
        unlockAudioFromGesture
    };
}
