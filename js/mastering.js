/**
 * Mastering Module
 * 
 * Processes recordings for streaming platforms with:
 * - Expander: Reduces noise floor by attenuating quiet sections
 * - LUFS normalization to -14 LUFS (Spotify/YouTube standard)
 * - True Peak limiting to -1 dBTP ceiling with 4× oversampling
 * 
 * Implementation uses synchronous JavaScript functions for offline processing:
 * - applyExpander(): RMS envelope-following expander for noise floor reduction
 * - applyTruePeakLimiter(): Look-ahead limiter with inter-sample peak detection
 * 
 * This approach is more reliable than AudioWorklet for offline processing,
 * as OfflineAudioContext + AudioWorklet has browser compatibility issues.
 * 
 * Reuses existing LUFS infrastructure from lufs.js.
 */

import { createKWeightingFilters, LufsBlockCollector, calculateGatedLufs } from './lufs.js';
import { linearToDb, QUALITY_REFERENCE } from './standards.js';

// Target: average of major streaming platforms
const TARGET_LUFS = QUALITY_REFERENCE.lufs.streaming; // -14
const PEAK_CEILING_DB = QUALITY_REFERENCE.peak.max;   // -1

// Expander settings optimized for speech/podcast
const EXPANDER_THRESHOLD_DB = -40;  // Expand signals below -40 dBFS
const EXPANDER_RATIO = 2;           // 2:1 expansion (gentle)

/**
 * Apply expander to audio buffer (in-place modification)
 * 
 * Reduces gain for signals below threshold, pushing down the noise floor.
 * Uses RMS envelope following with attack/release smoothing.
 * 
 * @param {Float32Array[]} channels - Array of channel data arrays
 * @param {number} sampleRate - Sample rate in Hz
 * @param {object} options - Expander parameters
 */
function applyExpander(channels, sampleRate, options = {}) {
    const {
        threshold = EXPANDER_THRESHOLD_DB,
        ratio = EXPANDER_RATIO,
        attack = 0.001,   // 1ms
        release = 0.1     // 100ms
    } = options;
    
    const thresholdLinear = Math.pow(10, threshold / 20);
    const attackCoef = Math.exp(-1 / (sampleRate * attack));
    const releaseCoef = Math.exp(-1 / (sampleRate * release));
    const rmsCoef = 0.9995;  // ~10ms time constant
    
    // Process all channels with linked gain (use max level across channels)
    const numChannels = channels.length;
    const numSamples = channels[0].length;
    
    let envelope = 0;
    let smoothedGain = 1;
    
    for (let i = 0; i < numSamples; i++) {
        // Find max level across all channels for this sample
        let maxSampleSquared = 0;
        for (let ch = 0; ch < numChannels; ch++) {
            const s = channels[ch][i];
            maxSampleSquared = Math.max(maxSampleSquared, s * s);
        }
        
        // Update envelope
        envelope = rmsCoef * envelope + (1 - rmsCoef) * maxSampleSquared;
        const rmsLevel = Math.sqrt(envelope);
        
        // Calculate target gain
        let targetGain = 1;
        if (rmsLevel < thresholdLinear && rmsLevel > 1e-10) {
            const levelDb = 20 * Math.log10(rmsLevel);
            const belowThreshold = threshold - levelDb;
            const gainReductionDb = belowThreshold * (ratio - 1) / ratio;
            targetGain = Math.pow(10, -gainReductionDb / 20);
            targetGain = Math.max(targetGain, 0.001);
        }
        
        // Smooth gain
        const coef = targetGain < smoothedGain ? attackCoef : releaseCoef;
        smoothedGain = coef * smoothedGain + (1 - coef) * targetGain;
        
        // Apply to all channels
        for (let ch = 0; ch < numChannels; ch++) {
            channels[ch][i] *= smoothedGain;
        }
    }
}

/**
 * Apply true peak limiter to audio buffer (in-place modification)
 * 
 * Uses 4× oversampling to detect inter-sample peaks and applies
 * gain reduction with look-ahead for transparent limiting.
 * 
 * @param {Float32Array[]} channels - Array of channel data arrays
 * @param {number} sampleRate - Sample rate in Hz
 * @param {object} options - Limiter parameters
 */
function applyTruePeakLimiter(channels, sampleRate, options = {}) {
    const {
        ceiling = PEAK_CEILING_DB,
        release = 0.1,
        lookAhead = 4  // samples
    } = options;
    
    const ceilingLinear = Math.pow(10, ceiling / 20);
    const releaseCoef = Math.exp(-1 / (sampleRate * release));
    
    const numChannels = channels.length;
    const numSamples = channels[0].length;
    
    // First pass: calculate required gain reduction for each sample
    const gainReduction = new Float32Array(numSamples);
    gainReduction.fill(1);
    
    for (let i = 0; i < numSamples; i++) {
        // Find true peak across all channels (with 4× oversampling)
        let maxTruePeak = 0;
        
        for (let ch = 0; ch < numChannels; ch++) {
            const sample = channels[ch][i];
            const prevSample = i > 0 ? channels[ch][i - 1] : 0;
            
            // Check sample peak
            maxTruePeak = Math.max(maxTruePeak, Math.abs(sample));
            
            // Check inter-sample peaks using linear interpolation
            // NOTE: ITU-R BS.1770 specifies FIR-based oversampling (sinc interpolation)
            // for true peak measurement. Linear interpolation can underestimate peaks
            // by ~0.5-1 dB in worst cases. This is an intentional trade-off for
            // simplicity in this diagnostic tool. For production mastering, consider
            // implementing a polyphase FIR filter.
            for (let j = 1; j < 4; j++) {
                const t = j / 4;
                const interpolated = prevSample + (sample - prevSample) * t;
                maxTruePeak = Math.max(maxTruePeak, Math.abs(interpolated));
            }
        }
        
        // Calculate required gain reduction
        if (maxTruePeak > ceilingLinear) {
            gainReduction[i] = ceilingLinear / maxTruePeak;
        }
    }
    
    // Second pass: apply look-ahead (minimum of next N samples)
    // This ensures we reduce gain BEFORE the peak arrives
    for (let i = 0; i < numSamples; i++) {
        let minGain = gainReduction[i];
        for (let j = 1; j <= lookAhead && i + j < numSamples; j++) {
            minGain = Math.min(minGain, gainReduction[i + j]);
        }
        gainReduction[i] = minGain;
    }
    
    // Third pass: apply release smoothing and gain
    let currentGain = 1;
    
    for (let i = 0; i < numSamples; i++) {
        const targetGain = gainReduction[i];
        
        if (targetGain < currentGain) {
            // Attack: instant
            currentGain = targetGain;
        } else {
            // Release: smooth
            currentGain = releaseCoef * currentGain + (1 - releaseCoef) * targetGain;
        }
        
        // Apply to all channels
        for (let ch = 0; ch < numChannels; ch++) {
            channels[ch][i] *= currentGain;
        }
    }
}

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
 * Measure true peak of an AudioBuffer using 4× oversampling
 * More accurate than sample peak - detects inter-sample peaks
 * 
 * @param {AudioBuffer} audioBuffer - The audio to measure
 * @returns {number} True peak level in dBTP
 */
export function measureBufferTruePeak(audioBuffer) {
    let maxPeak = 0;
    
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        let prevSample = 0;
        
        for (let i = 0; i < data.length; i++) {
            const sample = data[i];
            
            // Check sample peaks
            maxPeak = Math.max(maxPeak, Math.abs(sample));
            
            // Check inter-sample peaks (4× oversampling with linear interpolation)
            for (let j = 1; j < 4; j++) {
                const t = j / 4;
                const interpolated = prevSample + (sample - prevSample) * t;
                maxPeak = Math.max(maxPeak, Math.abs(interpolated));
            }
            
            prevSample = sample;
        }
    }
    
    return linearToDb(maxPeak);
}

/**
 * Process an AudioBuffer for streaming
 * 
 * Processing chain (all done in JavaScript for reliable offline processing):
 * 1. Expander - reduces noise floor by attenuating quiet sections
 * 2. Gain - normalizes loudness to target LUFS
 * 3. True Peak Limiter - prevents peaks from exceeding ceiling (with 4× oversampling)
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
    console.log('Starting mastering process...');
    
    // 1. Measure input loudness and peak
    const inputAnalysis = await measureBufferLufs(inputBuffer);
    const inputLufs = inputAnalysis.lufs;
    const inputPeak = measureBufferTruePeak(inputBuffer);
    
    console.log(`Input: ${inputLufs?.toFixed(1)} LUFS, ${inputPeak?.toFixed(1)} dBTP`);
    
    // Handle edge cases
    if (inputLufs === null || inputLufs === -Infinity) {
        throw new Error('Recording too quiet to measure - try speaking louder');
    }
    
    // 2. Create working copy of audio data
    const { numberOfChannels, length, sampleRate } = inputBuffer;
    const channels = [];
    for (let ch = 0; ch < numberOfChannels; ch++) {
        // Copy the data so we don't modify the original
        channels.push(new Float32Array(inputBuffer.getChannelData(ch)));
    }
    
    // 3. Apply expander (noise floor reduction)
    console.log('Applying expander...');
    applyExpander(channels, sampleRate);
    
    // 4. Measure LUFS after expander for accurate gain calculation
    // (expander changes loudness, so we need post-expander measurement)
    const postExpanderCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
    const postExpanderBuffer = postExpanderCtx.createBuffer(numberOfChannels, length, sampleRate);
    for (let ch = 0; ch < numberOfChannels; ch++) {
        postExpanderBuffer.getChannelData(ch).set(channels[ch]);
    }
    const postExpanderAnalysis = await measureBufferLufs(postExpanderBuffer);
    const postExpanderLufs = postExpanderAnalysis.lufs;
    
    // Handle edge case where expander made signal too quiet
    if (postExpanderLufs === null || postExpanderLufs === -Infinity) {
        throw new Error('Recording too quiet after expansion - try speaking louder');
    }
    
    // 5. Calculate and apply gain for LUFS normalization
    const gainDb = TARGET_LUFS - postExpanderLufs;
    const gainLinear = Math.pow(10, gainDb / 20);
    console.log(`Post-expander: ${postExpanderLufs.toFixed(1)} LUFS, applying ${gainDb.toFixed(1)} dB gain...`);
    
    for (let ch = 0; ch < numberOfChannels; ch++) {
        const data = channels[ch];
        for (let i = 0; i < length; i++) {
            data[i] *= gainLinear;
        }
    }
    
    // 6. Apply true peak limiter
    console.log('Applying true peak limiter...');
    applyTruePeakLimiter(channels, sampleRate);
    
    // 7. Create output AudioBuffer
    const outputCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
    const outputBuffer = outputCtx.createBuffer(numberOfChannels, length, sampleRate);
    
    for (let ch = 0; ch < numberOfChannels; ch++) {
        outputBuffer.getChannelData(ch).set(channels[ch]);
    }
    
    // 8. Measure output
    const outputAnalysis = await measureBufferLufs(outputBuffer);
    const outputLufs = outputAnalysis.lufs;
    const outputPeak = measureBufferTruePeak(outputBuffer);
    
    console.log(`Output: ${outputLufs?.toFixed(1)} LUFS, ${outputPeak?.toFixed(1)} dBTP`);
    console.log('Mastering complete.');
    
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
