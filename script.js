// ---------- CONFIG ----------
const SR = 44100;
const FREQ = 650;    // beep pitch (Hz)
const UNIT = 0.1;    // dot length in seconds. Dash = 3x. This never changes.
const PAD = 0.2;     // silence at start/end

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

const $ = id => document.getElementById(id);
const setStatus = m => { $("status").textContent = m; };
let ctx = null, src = null, timers = [], stretch = 2;
const getCtx = () => ctx || (ctx = new (window.AudioContext || window.webkitAudioContext)());

// ---------- TABS ----------
document.querySelectorAll(".tab").forEach(b => b.onclick = () => {
    stopAll();
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t === b));
    $("encodePane").hidden = b.dataset.tab !== "encode";
    $("decodePane").hidden = b.dataset.tab !== "decode";
    setStatus("");
});

// ---------- PAUSE LENGTH ----------
function setGap(v) {
    stretch = +v;
    $("gap").value = v;
    $("gapVal").textContent = v + "x";
    document.querySelectorAll(".preset").forEach(p => p.classList.toggle("on", +p.dataset.v === stretch));
}
$("gap").oninput = () => setGap($("gap").value);
document.querySelectorAll(".preset").forEach(p => p.onclick = () => setGap(p.dataset.v));
setGap(2);

// ---------- SHARED ----------
function render(words, el) {
    let i = 0;
    el.innerHTML = words.map(w => '<div class="word">' + w.map(l =>
        '<div class="ch" data-i="' + (i++) + '"><div class="sym">' +
        [...l.code].map(c => '<span class="' + (c === "." ? "d" : "l") + '"></span>').join("") +
        "</div><b>" + (l.ch === "&" ? "&amp;" : l.ch) + "</b></div>").join("") + "</div>").join("");
}

// ---------- ENCODE ----------
function parseText(text) {
    const words = text.toUpperCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { error: "Type some text first." };
    const bad = [...new Set([...words.join("")].filter(c => !MORSE[c]))];
    if (bad.length) return { error: "Can't encode: " + bad.join(" ") };
    return { words: words.map(w => [...w].map(c => ({ ch: c, code: MORSE[c] }))) };
}

// Gaps: between dots/dashes = 1 unit (fixed), letters = 3 units x s, words = 7 units x s
function synth(words, s) {
    const segs = [], times = [];
    let t = 0;
    const add = (on, sec) => { segs.push([on, sec]); t += sec; };

    words.forEach((w, wi) => {
        if (wi) add(0, 7 * UNIT * s);
        w.forEach((l, li) => {
            if (li) add(0, 3 * UNIT * s);
            const start = t;
            [...l.code].forEach((c, ci) => {
                if (ci) add(0, UNIT);
                add(1, c === "." ? UNIT : 3 * UNIT);
            });
            times.push([start + PAD, t + PAD]);
        });
    });

    const pad = Math.round(PAD * SR);
    const lens = segs.map(g => Math.round(g[1] * SR));
    const out = new Float32Array(lens.reduce((a, b) => a + b, 0) + pad * 2);
    const fade = Math.round(0.005 * SR);
    let pos = pad;
    segs.forEach((g, i) => {
        const n = lens[i];
        if (g[0]) {
            for (let k = 0; k < n; k++) {
                const env = Math.min(1, k / fade, (n - 1 - k) / fade);
                out[pos + k] = 0.8 * env * Math.sin(2 * Math.PI * FREQ * k / SR);
            }
        }
        pos += n;
    });
    return { samples: out, times };
}

// WAV file. Extra tiny chunk "mrsX" stores dot length + pause length so decoding is exact.
function toWav(samples, s) {
    const dataLen = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataLen + 16);
    const v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + dataLen + 16, true);
    str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, dataLen, true);
    for (let i = 0; i < samples.length; i++) {
        v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    }
    const m = 44 + dataLen;
    str(m, "mrsX"); v.setUint32(m + 4, 8, true);
    v.setFloat32(m + 8, UNIT, true); v.setFloat32(m + 12, s, true);
    return new Blob([buf], { type: "audio/wav" });
}

function fname() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
        p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + "-" +
        Math.random().toString(36).slice(2, 6) + ".wav";
}

function stopAll() {
    timers.forEach(clearTimeout);
    timers = [];
    if (src) { try { src.stop(); } catch (e) {} src = null; }
    document.querySelectorAll("#preview .ch.active").forEach(e => e.classList.remove("active"));
}

$("text").oninput = () => {
    const p = parseText($("text").value);
    if (p.error) {
        $("preview").innerHTML = "";
        setStatus($("text").value.trim() ? p.error : "");
    } else {
        render(p.words, $("preview"));
        setStatus("");
    }
};

$("play").onclick = async () => {
    const p = parseText($("text").value);
    if (p.error) return setStatus(p.error);
    render(p.words, $("preview"));
    stopAll();

    const c = getCtx();
    await c.resume();
    const r = synth(p.words, stretch);
    const buf = c.createBuffer(1, r.samples.length, SR);
    buf.copyToChannel(r.samples, 0);
    src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start();

    const boxes = $("preview").querySelectorAll(".ch");
    r.times.forEach((t, i) => {
        timers.push(setTimeout(() => boxes[i].classList.add("active"), t[0] * 1000));
        timers.push(setTimeout(() => boxes[i].classList.remove("active"), t[1] * 1000));
    });
    setStatus("Playing...");
    timers.push(setTimeout(() => setStatus("Done."), (r.samples.length / SR) * 1000));
};

$("stop").onclick = () => { stopAll(); setStatus("Stopped."); };

$("save").onclick = () => {
    const p = parseText($("text").value);
    if (p.error) return setStatus(p.error);
    const r = synth(p.words, stretch);
    const name = fname();
    const url = URL.createObjectURL(toWav(r.samples, stretch));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    setStatus("Saved " + name);
};

// ---------- DECODE ----------
const HOP = 0.005;

function readMeta(arr) {
    try {
        const v = new DataView(arr);
        const id = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
        if (id(0) !== "RIFF" || id(8) !== "WAVE") return null;
        let o = 12;
        while (o + 8 <= arr.byteLength) {
            const size = v.getUint32(o + 4, true);
            if (id(o) === "mrsX" && size >= 8) {
                const unit = v.getFloat32(o + 8, true), s = v.getFloat32(o + 12, true);
                if (unit > 0.01 && unit < 1 && s >= 1 && s <= 20) return { unit, s };
                return null;
            }
            o += 8 + size + (size & 1);
        }
    } catch (e) {}
    return null;
}

function mergeRuns(runs) {
    const out = [];
    for (const r of runs) {
        if (out.length && out[out.length - 1].on === r.on) out[out.length - 1].len += r.len;
        else out.push({ on: r.on, len: r.len });
    }
    return out;
}

function decodeSamples(data, sr, meta) {
    const hop = Math.max(1, Math.round(sr * HOP));
    const hopSec = hop / sr;
    const n = Math.floor(data.length / hop);

    // loudness per 5 ms window
    const rms = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = i * hop; j < (i + 1) * hop; j++) sum += data[j] * data[j];
        rms[i] = Math.sqrt(sum / hop);
        if (rms[i] > peak) peak = rms[i];
    }
    if (peak < 0.005) return { error: "No signal found in this audio." };

    // beep on/off runs, glitches under 15 ms removed
    let runs = mergeRuns(Array.from(rms, v => ({ on: v > peak * 0.35, len: 1 })));
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
    while (runs.length && !runs[0].on) runs.shift();
    while (runs.length && !runs[runs.length - 1].on) runs.pop();
    if (!runs.length) return { error: "No Morse beeps found." };

    const dur = runs.map(r => ({ on: r.on, t: r.len * hopSec }));
    const ons = dur.filter(d => d.on).map(d => d.t);

    // dot length
    let unit, s = null;
    if (meta) {
        unit = meta.unit; s = meta.s;
    } else {
        const m = Math.min(...ons), M = Math.max(...ons);
        unit = (M / m > 1.8 || m <= 0.2) ? m : m / 3;
    }

    // where letter gap ends and word gap begins
    let wordCut = 5 * unit * (s || 1);
    if (!s) {
        const longs = dur.filter(d => !d.on && d.t >= 2 * unit).map(d => d.t);
        if (longs.length && Math.max(...longs) / Math.min(...longs) > 1.8) wordCut = Math.min(...longs) * 5 / 3;
    }

    const words = [];
    let word = [], cur = "";
    const flushLetter = () => { if (cur) { word.push({ code: cur, ch: REVERSE[cur] || "?" }); cur = ""; } };
    const flushWord = () => { flushLetter(); if (word.length) words.push(word); word = []; };

    for (const d of dur) {
        if (d.on) cur += d.t > 2 * unit ? "-" : ".";
        else if (d.t >= 2 * unit) { if (d.t > wordCut) flushWord(); else flushLetter(); }
    }
    flushWord();
    return { words };
}

$("decode").onclick = async () => {
    const file = $("audio").files[0];
    if (!file) return setStatus("Choose an audio file first.");
    $("decoded").textContent = "";
    $("decMorse").innerHTML = "";
    try {
        const arr = await file.arrayBuffer();
        const meta = readMeta(arr);
        const audio = await getCtx().decodeAudioData(arr.slice(0));
        const r = decodeSamples(audio.getChannelData(0), audio.sampleRate, meta);
        if (r.error) return setStatus(r.error);
        $("decoded").textContent = r.words.map(w => w.map(l => l.ch).join("")).join(" ");
        render(r.words, $("decMorse"));
        setStatus("Decoded.");
    } catch (e) {
        setStatus("Could not read that audio file.");
    }
};