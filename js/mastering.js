/**
 * Mastering Module (Phase 1)
 * 
 * Processes recordings for streaming platforms with:
 * - LUFS normalization to -14 LUFS (Spotify/YouTube standard)
 * - Peak limiting to -1 dBTP ceiling
 * 
 * Uses built-in Web Audio nodes (DynamicsCompressorNode as soft limiter).
 * True peak limiting via AudioWorklet deferred to Phase 2.
 * 
 * Reuses existing LUFS infrastructure from lufs.js.
 */

import { createKWeightingFilters, LufsBlockCollector, calculateGatedLufs } from './lufs.js';
import { linearToDb, QUALITY_REFERENCE } from './standards.js';

// Target: average of major streaming platforms
const TARGET_LUFS = QUALITY_REFERENCE.lufs.streaming; // -14
const PEAK_CEILING_DB = QUALITY_REFERENCE.peak.max;   // -1

/**
 * Decode a recording blob URL to an AudioBuffer
 * @param {string} blobUrl - URL from URL.createObjectURL()
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeRecordingBlob(blobUrl) {
    const response = await fetch(blobUrl);
    const arrayBuffer = await response.arrayBuffer();
    
    // Create a temporary context for decoding
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    await tempCtx.close();
    
    return audioBuffer;
}

/**
 * Measure integrated LUFS of an AudioBuffer
 * Reuses existing K-weighting and block collection from lufs.js
 * 
 * @param {AudioBuffer} audioBuffer - The audio to measure
 * @returns {Promise<{lufs: number, error: string|null, blockStats: object}>}
 */
export async function measureBufferLufs(audioBuffer) {
    const { sampleRate, length, numberOfChannels } = audioBuffer;
    
    // Create offline context for K-weighted rendering
    const offlineCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
    
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    
    // Reuse existing K-weighting filters from lufs.js
    const { preFilter, rlbFilter } = createKWeightingFilters(offlineCtx);
    
    source.connect(preFilter);
    rlbFilter.connect(offlineCtx.destination);
    source.start();
    
    const kWeightedBuffer = await offlineCtx.startRendering();
    
    // Reuse existing block collector from lufs.js
    const collector = new LufsBlockCollector(sampleRate);
    
    // For stereo, sum channels (ITU-R BS.1770 uses channel weighting, 
    // but for simplicity we average - close enough for Phase 1)
    if (numberOfChannels === 1) {
        collector.addSamples(kWeightedBuffer.getChannelData(0));
    } else {
        // Mix to mono for LUFS measurement
        const left = kWeightedBuffer.getChannelData(0);
        const right = kWeightedBuffer.getChannelData(1);
        const mono = new Float32Array(left.length);
        for (let i = 0; i < left.length; i++) {
            mono[i] = (left[i] + right[i]) / 2;
        }
        collector.addSamples(mono);
    }
    
    // Reuse existing gated LUFS calculation from lufs.js
    return calculateGatedLufs(collector.getBlocks());
}

/**
 * Measure sample peak of an AudioBuffer in dB
 * @param {AudioBuffer} audioBuffer - The audio to measure
 * @returns {number} Peak level in dB (0 = full scale)
 */
export function measureBufferPeak(audioBuffer) {
    let peak = 0;
    
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
            const abs = Math.abs(data[i]);
            if (abs > peak) peak = abs;
        }
    }
    
    return linearToDb(peak);
}

/**
 * Process an AudioBuffer for streaming
 * Applies gain normalization and limiting to meet platform specs
 * 
 * @param {AudioBuffer} inputBuffer - Raw recording
 * @returns {Promise<{
 *   buffer: AudioBuffer,
 *   inputLufs: number,
 *   outputLufs: number,
 *   inputPeak: number,
 *   outputPeak: number,
 *   gainApplied: number
 * }>}
 */
export async function processForStreaming(inputBuffer) {
    // 1. Measure input loudness
    const inputAnalysis = await measureBufferLufs(inputBuffer);
    const inputLufs = inputAnalysis.lufs;
    const inputPeak = measureBufferPeak(inputBuffer);
    
    // Handle edge cases
    if (inputLufs === null || inputLufs === -Infinity) {
        throw new Error('Recording too quiet to measure - try speaking louder');
    }
    
    // 2. Calculate required gain
    const gainDb = TARGET_LUFS - inputLufs;
    const gainLinear = Math.pow(10, gainDb / 20);
    
    // 3. Create offline processing context
    const { numberOfChannels, length, sampleRate } = inputBuffer;
    const offlineCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
    
    const source = offlineCtx.createBufferSource();
    source.buffer = inputBuffer;
    
    // Pre-limiter: catch existing peaks before applying gain
    // Using DynamicsCompressorNode as a soft limiter (ratio 20:1 ≈ brickwall)
    const preLimiter = offlineCtx.createDynamicsCompressor();
    preLimiter.threshold.value = PEAK_CEILING_DB;
    preLimiter.ratio.value = 20;
    preLimiter.attack.value = 0.003;  // 3ms - fast enough for transients
    preLimiter.release.value = 0.1;   // 100ms - smooth release
    preLimiter.knee.value = 0;        // Hard knee for limiting
    
    // Makeup gain to reach target LUFS
    const gain = offlineCtx.createGain();
    gain.gain.value = gainLinear;
    
    // Post-limiter: catch any peaks created by gain increase
    const postLimiter = offlineCtx.createDynamicsCompressor();
    postLimiter.threshold.value = PEAK_CEILING_DB;
    postLimiter.ratio.value = 20;
    postLimiter.attack.value = 0.003;
    postLimiter.release.value = 0.1;
    postLimiter.knee.value = 0;
    
    // Connect the chain: source → preLimiter → gain → postLimiter → output
    source.connect(preLimiter);
    preLimiter.connect(gain);
    gain.connect(postLimiter);
    postLimiter.connect(offlineCtx.destination);
    
    source.start();
    const outputBuffer = await offlineCtx.startRendering();
    
    // 4. Measure output
    const outputAnalysis = await measureBufferLufs(outputBuffer);
    const outputLufs = outputAnalysis.lufs;
    const outputPeak = measureBufferPeak(outputBuffer);
    
    return {
        buffer: outputBuffer,
        inputLufs,
        outputLufs,
        inputPeak,
        outputPeak,
        gainApplied: gainDb
    };
}

/**
 * Convert an AudioBuffer to a playable blob URL (WAV format)
 * @param {AudioBuffer} buffer - The audio buffer to encode
 * @returns {string} Blob URL for use in <audio> element
 */
export function audioBufferToWavUrl(buffer) {
    const wavBlob = encodeWav(buffer);
    return URL.createObjectURL(wavBlob);
}

/**
 * Encode AudioBuffer as WAV file
 * @param {AudioBuffer} buffer - Audio to encode
 * @returns {Blob} WAV file blob
 */
function encodeWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitsPerSample = 16;
    
    // Interleave channels
    const length = buffer.length;
    const outputLength = length * numChannels;
    const output = new Float32Array(outputLength);
    
    for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            output[i * numChannels + ch] = buffer.getChannelData(ch)[i];
        }
    }
    
    // Create WAV file
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = outputLength * (bitsPerSample / 8);
    const headerSize = 44;
    const totalSize = headerSize + dataSize;
    
    const arrayBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(arrayBuffer);
    
    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(view, 8, 'WAVE');
    
    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    
    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    
    // Write samples as 16-bit PCM
    let offset = 44;
    for (let i = 0; i < outputLength; i++) {
        // Clamp and convert to 16-bit
        const sample = Math.max(-1, Math.min(1, output[i]));
        const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, int16, true);
        offset += 2;
    }
    
    return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/**
 * Write string to DataView
 */
function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

/**
 * Check if mastering is possible (recording exists and is long enough)
 * @param {string} recordingUrl - Blob URL of recording
 * @returns {Promise<{canProcess: boolean, reason?: string}>}
 */
export async function canProcessRecording(recordingUrl) {
    if (!recordingUrl) {
        return { canProcess: false, reason: 'No recording available' };
    }
    
    try {
        const buffer = await decodeRecordingBlob(recordingUrl);
        const durationSec = buffer.length / buffer.sampleRate;
        
        // Need at least 1 second for meaningful LUFS measurement
        // (400ms block + some margin)
        if (durationSec < 1) {
            return { canProcess: false, reason: 'Recording too short (need at least 1 second)' };
        }
        
        return { canProcess: true };
    } catch (err) {
        return { canProcess: false, reason: `Cannot decode recording: ${err.message}` };
    }
}
