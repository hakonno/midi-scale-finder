import { createPianoSamples } from './pianoSamples.js';

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

// Default frequency for the fallback synth
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
    let audioReady = null;
    let warmedSamples = false;
    const samples = createPianoSamples();
    const previewReleases = new Set();
    const volume = document.getElementById('pianoVolume');
    volume.addEventListener('input', () => {
        if (masterBus) {
            masterBus.input.gain.setTargetAtTime(Number(volume.value), audioContext.currentTime, 0.015);
        }
    });

    let previewToken = 0;
    const previewTimeouts = new Set();

    function cancelPreviews() {
        previewToken++;
        for (const id of previewTimeouts) {
            window.clearTimeout(id);
        }
        previewTimeouts.clear();
        for (const release of previewReleases) release();
        previewReleases.clear();
    }

    function stopAllAudio() {
        cancelPreviews();

        if (audioContext) {
            try {
                audioContext.close().catch(() => {});
            } catch {
                // ignore
            }
        }
        audioContext = null;
        masterBus = null;
        hammerBuffer = null;
        audioUnlocked = false;
        audioReady = null;
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

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        if (!audioContext) {
            audioContext = new AudioContext({ latencyHint: 'interactive' });
            masterBus = buildMasterBus(audioContext);
        }
        if (!warmedSamples) {
            warmedSamples = true;
            samples.warmUp(audioContext);
        }
        const context = audioContext;
        if (context.state !== 'running' && !audioReady) {
            audioReady = context.resume().catch(() => {}).finally(() => {
                if (audioContext === context) audioReady = null;
            });
        }
    }

    // Shared output chain: voices -> gain -> compressor -> destination,
    // with a subtle parallel room reverb (generated impulse response).
    function buildMasterBus(ctx) {
        const input = ctx.createGain();
        input.gain.value = Number(volume.value);

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 18;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.22;

        const convolver = ctx.createConvolver();
        convolver.buffer = buildImpulseResponse(ctx, 1.6, 2.8);
        const reverbGain = ctx.createGain();
        reverbGain.gain.value = 0.065;

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

    function playSynth({ freq, velocity }) {
        try {
            if (typeof document !== 'undefined' && document.hidden) return;
            ensureAudioContext();
            if (!audioContext || audioContext.state !== 'running' || !masterBus) return;

            const ctx = audioContext;
            hammerBuffer ??= buildHammerBuffer(ctx);
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
            const releaseGain = ctx.createGain();
            out.connect(releaseGain);
            releaseGain.connect(masterBus.input);

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
                    releaseGain.disconnect();
                };
            }
            return () => {
                const releaseAt = ctx.currentTime;
                releaseGain.gain.setTargetAtTime(0.0001, releaseAt, 0.04);
                for (const source of sources) source.stop(Math.min(stopAt, releaseAt + 0.25));
            };
        } catch {
            // Ignore audio failures (e.g. blocked by browser policy)
        }
    }

    function playPc(pc, velocity = 0.72) {
        return playMidiNote(60 + pc % 12, velocity);
    }

    function playMidiNote(midi, velocity = 0.72) {
        if (!Number.isFinite(midi)) return;
        ensureAudioContext();
        const context = audioContext;
        let cancelled = false;
        let release;

        const start = () => {
            if (cancelled || context !== audioContext || !isAudioRunning() || document.hidden) return;
            release = samples.play(context, masterBus.input, midi, velocity)
                ?? playSynth({ freq: 440 * 2 ** ((midi - 69) / 12), velocity });
        };
        if (audioReady) audioReady.then(start);
        else start();

        return () => {
            if (cancelled) return;
            cancelled = true;
            if (context === audioContext) release?.();
        };
    }

    function previewMidiSequence(sequence, { intervalMs = 190 } = {}) {
        cancelPreviews();
        const token = previewToken;
        ensureAudioContext();

        const schedule = () => {
            if (token !== previewToken || !isAudioRunning() || document.hidden) return;
            sequence.forEach((midi, index) => {
                const last = index === sequence.length - 1;
                schedulePreview(() => {
                    const release = playMidiNote(midi, last ? 0.78 : 0.68);
                    if (!release) return;
                    previewReleases.add(release);
                    schedulePreview(() => {
                        release();
                        previewReleases.delete(release);
                    }, last ? 650 : intervalMs + 35);
                }, index * intervalMs + (last ? 80 : 0));
            });
        };
        if (audioReady) audioReady.then(schedule);
        else schedule();
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
            bindKey(key, pc);
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
            bindKey(key, pc);
            blackEl.appendChild(key);
        }

        syncAllKeyStates();
        syncAllKeyPercentages();
    }

    function bindKey(key, pc) {
        let releaseHover;

        key.addEventListener('pointerenter', event => {
            if (event.pointerType === 'mouse' && isAudioRunning()) {
                releaseHover = playPc(pc);
            }
        });
        key.addEventListener('pointerleave', () => {
            releaseHover?.();
            releaseHover = undefined;
        });
        key.addEventListener('click', event => {
            unlockAudioFromGesture();
            if (!releaseHover || event.detail === 0) {
                const release = playPc(pc);
                window.setTimeout(release, 420);
            }
            togglePc(pc);
        });
        key.addEventListener('contextmenu', event => {
            event.preventDefault();
            deselectPc(pc);
        });
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

    function togglePc(pc) {
        if (selected.has(pc)) {
            selected.delete(pc);
        } else {
            selected.add(pc);
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
            if (idx >= 0) togglePc(idx);
        },
        selectNote: (noteName) => {
            const idx = PITCH_CLASS_TO_SHARP_NAME.indexOf(noteName);
            if (idx >= 0 && !selected.has(idx)) togglePc(idx);
        },
        deselectNote: (noteName) => {
            const idx = PITCH_CLASS_TO_SHARP_NAME.indexOf(noteName);
            if (idx >= 0 && selected.has(idx)) togglePc(idx);
        },
        clearSelection: () => setSelectedPitchClasses([], { silent: false }),
        selectNotes: (noteNames) => {
            const pcs = (noteNames || [])
                .map((n) => PITCH_CLASS_TO_SHARP_NAME.indexOf(n))
                .filter((pc) => pc >= 0);
            setSelectedPitchClasses(pcs, { silent: false });
        },
        previewMidiSequence,
        cancelPreviews,
        stopAllAudio,
        unlockAudioFromGesture
    };
}
