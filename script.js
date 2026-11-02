// ---------- CONFIG ----------
const SAMPLE_RATE = 44100;
const FREQ = 650;      // tone pitch in Hz
const UNIT = 0.08;     // one Morse time unit in seconds (dot = 1, dash = 3)

const MORSE = {
    A: ".-",   B: "-...", C: "-.-.", D: "-..",  E: ".",    F: "..-.",
    G: "--.",  H: "....", I: "..",   J: ".---", K: "-.-",  L: ".-..",
    M: "--",   N: "-.",   O: "---",  P: ".--.", Q: "--.-", R: ".-.",
    S: "...",  T: "-",    U: "..-",  V: "...-", W: ".--",  X: "-..-",
    Y: "-.--", Z: "--..",
    0: "-----", 1: ".----", 2: "..---", 3: "...--", 4: "....-",
    5: ".....", 6: "-....", 7: "--...", 8: "---..", 9: "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--",
    "/": "-..-.", "(": "-.--.", ")": "-.--.-", "&": ".-...", ":": "---...",
    ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-", "_": "..--.-",
    '"': ".-..-.", "$": "...-..-", "@": ".--.-."
};
const REVERSE = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

const textInput = document.getElementById("textInput");
const statusEl = document.getElementById("status");
let audioCtx = null;
let currentSource = null;

function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function setStatus(msg) { statusEl.textContent = msg; }

// ---------- ENCODE ----------
// Returns { morse: "... --- ... / ...", samples: Float32Array } or { error }
function encode(text) {
    const words = text.toUpperCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { error: "Type some text first." };

    const bad = [...new Set([...words.join("")].filter(c => !MORSE[c]))];
    if (bad.length) return { error: "Unsupported character(s): " + bad.join(" ") };

    // Build list of [isOn, units]
    const segs = [];
    const gap = u => segs.push([0, u]);
    words.forEach((word, wi) => {
        if (wi > 0) gap(7);
        [...word].forEach((ch, ci) => {
            if (ci > 0) gap(3);
            [...MORSE[ch]].forEach((sym, si) => {
                if (si > 0) gap(1);
                segs.push([1, sym === "." ? 1 : 3]);
            });
        });
    });

    const pad = Math.round(0.2 * SAMPLE_RATE);
    const lens = segs.map(s => Math.round(s[1] * UNIT * SAMPLE_RATE));
    const total = lens.reduce((a, b) => a + b, 0) + pad * 2;
    const out = new Float32Array(total);
    const fade = Math.round(0.005 * SAMPLE_RATE); // 5 ms ramp, avoids clicks

    let pos = pad;
    segs.forEach((seg, i) => {
        const n = lens[i];
        if (seg[0]) {
            for (let k = 0; k < n; k++) {
                const env = Math.min(1, k / fade, (n - 1 - k) / fade);
                out[pos + k] = 0.8 * env * Math.sin(2 * Math.PI * FREQ * k / SAMPLE_RATE);
            }
        }
        pos += n;
    });

    const morse = words.map(w => [...w].map(c => MORSE[c]).join(" ")).join(" / ");
    return { morse, samples: out };
}

function toWav(samples) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true);
    str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(44 + i * 2, s * 32767, true);
    }
    return new Blob([buf], { type: "audio/wav" });
}

document.getElementById("playBtn").addEventListener("click", async () => {
    const r = encode(textInput.value);
    if (r.error) return setStatus(r.error);

    const ctx = getCtx();
    await ctx.resume();
    if (currentSource) { try { currentSource.stop(); } catch (e) {} }

    const buffer = ctx.createBuffer(1, r.samples.length, SAMPLE_RATE);
    buffer.copyToChannel(r.samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    currentSource = src;
    setStatus("Playing: " + r.morse);
});

document.getElementById("saveBtn").addEventListener("click", () => {
    const r = encode(textInput.value);
    if (r.error) return setStatus(r.error);

    const url = URL.createObjectURL(toWav(r.samples));
    const a = document.createElement("a");
    a.href = url;
    a.download = "morse.wav";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("Saved morse.wav: " + r.morse);
});

// ---------- DECODE ----------
const HOP_SEC = 0.005; // analysis window: 5 ms

function mergeRuns(runs) {
    const out = [];
    for (const r of runs) {
        if (out.length && out[out.length - 1].on === r.on) out[out.length - 1].len += r.len;
        else out.push({ on: r.on, len: r.len });
    }
    return out;
}

function decodeSamples(data, sr) {
    const hop = Math.max(1, Math.round(sr * HOP_SEC));
    const hopSec = hop / sr;
    const n = Math.floor(data.length / hop);

    // 1. RMS envelope
    const rms = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = i * hop; j < (i + 1) * hop; j++) sum += data[j] * data[j];
        rms[i] = Math.sqrt(sum / hop);
        if (rms[i] > peak) peak = rms[i];
    }
    if (peak < 0.005) return { error: "No signal found in this audio." };

    // 2. Threshold into on/off runs
    const thr = peak * 0.35;
    let runs = mergeRuns(Array.from(rms, v => ({ on: v > thr, len: 1 })));

    // 3. Remove glitches shorter than 15 ms
    const minLen = Math.ceil(0.015 / hopSec);
    let changed = true;
    while (changed && runs.length > 1) {
        changed = false;
        for (let i = 0; i < runs.length; i++) {
            if (runs[i].len < minLen) {
                runs[i].on = !runs[i].on;
                runs = mergeRuns(runs);
                changed = true;
                break;
            }
        }
    }

    // 4. Drop leading and trailing silence
    while (runs.length && !runs[0].on) runs.shift();
    while (runs.length && !runs[runs.length - 1].on) runs.pop();
    if (!runs.length) return { error: "No Morse beeps found." };

    const dur = runs.map(r => ({ on: r.on, t: r.len * hopSec }));

    // 5. Estimate the time unit (shortest element)
    let unit = Math.min(...dur.map(d => d.t));
    // Our own files: if shortest element is about 3 units, it's all dashes/letter gaps
    if (Math.abs(unit - 3 * UNIT) < 0.15 * 3 * UNIT) unit = UNIT;

    // 6. Classify and translate
    let morse = "", text = "", cur = "";
    const flush = () => {
        if (cur) { text += REVERSE[cur] || "?"; morse += cur; cur = ""; }
    };
    for (const d of dur) {
        if (d.on) {
            cur += d.t > 2 * unit ? "-" : ".";
        } else if (d.t > 5 * unit) {
            flush(); text += " "; morse += " / ";
        } else if (d.t > 2 * unit) {
            flush(); morse += " ";
        }
    }
    flush();
    return { text: text.trim(), morse: morse.trim() };
}

document.getElementById("decodeBtn").addEventListener("click", async () => {
    const file = document.getElementById("audioInput").files[0];
    if (!file) return setStatus("Choose a WAV file first.");

    try {
        const arr = await file.arrayBuffer();
        const audio = await getCtx().decodeAudioData(arr);
        const r = decodeSamples(audio.getChannelData(0), audio.sampleRate);
        if (r.error) return setStatus(r.error);
        setStatus("Decoded: " + r.text + "\nMorse: " + r.morse);
    } catch (e) {
        setStatus("Could not read that audio file.");
    }
});
