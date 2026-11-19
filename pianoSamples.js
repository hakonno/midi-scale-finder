const FIRST_PIANO_NOTE = 21;
const LAST_PIANO_NOTE = 108;
const PITCH_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
const MAX_BUFFERS = 24;

export function createPianoSamples() {
    const buffers = new Map();
    const pending = new Map();
    const retryAfter = new Map();

    function load(context, root, layer) {
        const pitch = PITCH_NAMES[root % 12];
        const octave = Math.floor(root / 12) - 1;
        const name = `${pitch}${octave}-${layer}`;
        if (buffers.has(name)) {
            const buffer = buffers.get(name);
            buffers.delete(name);
            buffers.set(name, buffer);
            return buffer;
        }
        if (pending.has(name) || Date.now() < (retryAfter.get(name) ?? 0)) return null;

        const request = fetch(new URL(`./audio/${name}.mp3`, import.meta.url))
            .then(response => {
                if (!response.ok) throw new Error(`Piano sample unavailable: ${name}`);
                return response.arrayBuffer();
            })
            .then(data => context.decodeAudioData(data))
            .then(buffer => {
                retryAfter.delete(name);
                buffers.set(name, buffer);
                if (buffers.size > MAX_BUFFERS) buffers.delete(buffers.keys().next().value);
            })
            .catch(() => retryAfter.set(name, Date.now() + 15000))
            .finally(() => pending.delete(name));
        pending.set(name, request);
        return null;
    }

    function warmUp(context) {
        // On-screen piano, computer keyboard and scale previews share this range.
        for (let root = 60; root <= 90; root += 3) load(context, root, 9);
    }

    function play(context, destination, midi, velocity) {
        if (midi < FIRST_PIANO_NOTE || midi > LAST_PIANO_NOTE) return null;
        // The original recordings are spaced a minor third apart.
        const root = Math.round(midi / 3) * 3;
        const layer = velocity < 0.38 ? 4 : velocity > 0.82 ? 15 : 9;
        const buffer = load(context, root, layer) ?? load(context, root, 9);
        if (!buffer) return null;

        const source = context.createBufferSource();
        const gain = context.createGain();
        const now = context.currentTime;
        source.buffer = buffer;
        source.playbackRate.value = 2 ** ((midi - root) / 12);
        gain.gain.value = 0.75 * (0.55 + 0.45 * velocity);
        source.connect(gain);
        gain.connect(destination);
        let ended = false;
        source.onended = () => {
            ended = true;
            source.disconnect();
            gain.disconnect();
        };
        source.start(now);

        return () => {
            if (ended) return;
            const releaseAt = context.currentTime;
            // The highest acoustic piano strings have no dampers.
            const decay = midi >= 90 ? 0.22 : 0.045;
            gain.gain.setTargetAtTime(0.0001, releaseAt, decay);
            source.stop(releaseAt + decay * 6);
        };
    }

    return { warmUp, play };
}
