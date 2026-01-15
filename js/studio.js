/**
 * Studio Monitor Module
 * 
 * DAW-inspired audio monitoring with:
 * - Transport bar controls
 * - Hero spectrogram visualization
 * - Stereo L/R level meters with peak hold
 * - Real-time LUFS metering
 * - Recording with waveform preview
 */

import { populateDeviceDropdown } from './utils.js';
import { isChromiumBased } from './browser.js';
import { linearToDb } from './standards.js';
import { PlaybackRecorder, getMediaRecorderSupport } from './playback.js';

/**
 * State for the studio monitor
 */
const studioState = {
    // Audio resources
    audioContext: null,
    stream: null,
    source: null,
    analyser: null,
    splitter: null,
    analyserL: null,
    analyserR: null,
    
    // Channel info (1 = mono, 2 = stereo)
    channelCount: 2,
    
    // Animation
    animationId: null,
    isRunning: false,
    
    // Device
    deviceId: null,
    
    // Spectrogram
    spectrogramCtx: null,
    frequencyData: null,
    
    // Oscilloscope
    oscilloscopeCtx: null,
    timeDomainData: null,
    
    // Meters
    peakL: -Infinity,
    peakR: -Infinity,
    peakHoldL: 0,
    peakHoldR: 0,
    peakHoldTimeL: 0,
    peakHoldTimeR: 0,
    overallPeak: -Infinity,
    
    // LUFS (simple short-term approximation)
    lufsBuffer: [],
    lufsWindowSize: 3000, // 3 second window for short-term
    lastLufsUpdate: 0,
    currentLufs: -Infinity,
    
    // Recording
    isRecording: false,
    recordingStartTime: 0,
    recorder: null,
    recordingBlob: null,
    recordingUrl: null,
    waveformData: [],
    
    // Playback
    isPlaying: false,
    audioElement: null,
    
    // Processing mode
    processingEnabled: true
};

// Peak hold duration in ms
const PEAK_HOLD_DURATION = 2000;

/**
 * Initialize the studio monitor with a device
 * @param {string} deviceId - The device ID to monitor
 * @returns {Promise<{success: boolean, error?: string, label?: string}>}
 */
export async function initStudio(deviceId) {
    await cleanupStudio();
    
    try {
        const constraints = deviceId 
            ? { 
                audio: { 
                    deviceId: { exact: deviceId },
                    // Start with processing based on toggle state
                    autoGainControl: studioState.processingEnabled,
                    noiseSuppression: studioState.processingEnabled,
                    echoCancellation: studioState.processingEnabled
                } 
            }
            : { 
                audio: {
                    autoGainControl: studioState.processingEnabled,
                    noiseSuppression: studioState.processingEnabled,
                    echoCancellation: studioState.processingEnabled
                } 
            };
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // Create AudioContext
        studioState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await studioState.audioContext.resume();
        
        // Create source
        studioState.source = studioState.audioContext.createMediaStreamSource(stream);
        
        // Main analyser for spectrogram
        studioState.analyser = studioState.audioContext.createAnalyser();
        studioState.analyser.fftSize = 2048;
        studioState.analyser.smoothingTimeConstant = 0.3;
        
        // Channel splitter for stereo meters
        studioState.splitter = studioState.audioContext.createChannelSplitter(2);
        
        // Per-channel analysers
        studioState.analyserL = studioState.audioContext.createAnalyser();
        studioState.analyserL.fftSize = 2048;
        studioState.analyserL.smoothingTimeConstant = 0.5;
        
        studioState.analyserR = studioState.audioContext.createAnalyser();
        studioState.analyserR.fftSize = 2048;
        studioState.analyserR.smoothingTimeConstant = 0.5;
        
        // Connect: source -> analyser (for spectrogram)
        studioState.source.connect(studioState.analyser);
        
        // Connect: source -> splitter -> L/R analysers
        studioState.source.connect(studioState.splitter);
        studioState.splitter.connect(studioState.analyserL, 0);
        studioState.splitter.connect(studioState.analyserR, 1);
        
        // Store state
        studioState.stream = stream;
        studioState.deviceId = deviceId;
        studioState.isRunning = true;
        
        // Reset meters
        studioState.peakL = -Infinity;
        studioState.peakR = -Infinity;
        studioState.peakHoldL = 0;
        studioState.peakHoldR = 0;
        studioState.overallPeak = -Infinity;
        studioState.lufsBuffer = [];
        studioState.currentLufs = -Infinity;
        
        const track = stream.getAudioTracks()[0];
        const label = track?.label || 'Unknown Microphone';
        
        // Detect channel count (mono vs stereo)
        const settings = track?.getSettings() || {};
        studioState.channelCount = settings.channelCount || 2;
        console.log(`Audio device "${label}" has ${studioState.channelCount} channel(s)`);
        
        return { success: true, label, channelCount: studioState.channelCount };
        
    } catch (error) {
        console.error('Failed to init studio:', error);
        await cleanupStudio();
        return { 
            success: false, 
            error: error.name === 'NotAllowedError' 
                ? 'Permission denied'
                : error.message
        };
    }
}

/**
 * Switch to a different device
 */
export async function switchDevice(deviceId) {
    return initStudio(deviceId);
}

/**
 * Start the visualization loop
 */
export function startVisualization(elements) {
    if (!studioState.analyser || !studioState.isRunning) {
        console.error('Studio not initialized');
        return;
    }
    
    // Cancel any existing animation
    if (studioState.animationId) {
        cancelAnimationFrame(studioState.animationId);
        studioState.animationId = null;
    }
    
    // Set up spectrogram canvas
    if (elements.spectrogramCanvas) {
        studioState.spectrogramCtx = elements.spectrogramCanvas.getContext('2d');
        studioState.frequencyData = new Uint8Array(studioState.analyser.frequencyBinCount);
        
        // Clear with dark background
        studioState.spectrogramCtx.fillStyle = '#0a0a0a';
        studioState.spectrogramCtx.fillRect(0, 0, elements.spectrogramCanvas.width, elements.spectrogramCanvas.height);
    }
    
    // Set up oscilloscope canvas
    if (elements.oscilloscopeCanvas) {
        studioState.oscilloscopeCtx = elements.oscilloscopeCanvas.getContext('2d');
        studioState.timeDomainData = new Uint8Array(studioState.analyser.fftSize);
        
        // Clear with dark background
        studioState.oscilloscopeCtx.fillStyle = '#0a0a0a';
        studioState.oscilloscopeCtx.fillRect(0, 0, elements.oscilloscopeCanvas.width, elements.oscilloscopeCanvas.height);
    }
    
    // Time domain data for stereo channels
    const timeDomainL = new Float32Array(studioState.analyserL.fftSize);
    const timeDomainR = new Float32Array(studioState.analyserR.fftSize);
    
    function update() {
        if (!studioState.isRunning || !studioState.audioContext || 
            studioState.audioContext.state === 'closed') {
            studioState.animationId = null;
            return;
        }
        
        studioState.animationId = requestAnimationFrame(update);
        const now = performance.now();
        
        // Update spectrogram
        if (studioState.spectrogramCtx && studioState.frequencyData && elements.spectrogramCanvas) {
            studioState.analyser.getByteFrequencyData(studioState.frequencyData);
            drawSpectrogram(
                studioState.spectrogramCtx,
                elements.spectrogramCanvas,
                studioState.frequencyData
            );
        }
        
        // Update oscilloscope
        if (studioState.oscilloscopeCtx && studioState.timeDomainData && elements.oscilloscopeCanvas) {
            studioState.analyser.getByteTimeDomainData(studioState.timeDomainData);
            drawOscilloscope(
                studioState.oscilloscopeCtx,
                elements.oscilloscopeCanvas,
                studioState.timeDomainData
            );
        }
        
        // Get stereo levels
        studioState.analyserL.getFloatTimeDomainData(timeDomainL);
        studioState.analyserR.getFloatTimeDomainData(timeDomainR);
        
        const rmsL = calculateRms(timeDomainL);
        const rmsR = calculateRms(timeDomainR);
        const dbL = linearToDb(rmsL);
        const dbR = linearToDb(rmsR);
        
        // Update peak hold
        if (dbL > studioState.peakHoldL || now - studioState.peakHoldTimeL > PEAK_HOLD_DURATION) {
            studioState.peakHoldL = dbL;
            studioState.peakHoldTimeL = now;
        }
        if (dbR > studioState.peakHoldR || now - studioState.peakHoldTimeR > PEAK_HOLD_DURATION) {
            studioState.peakHoldR = dbR;
            studioState.peakHoldTimeR = now;
        }
        
        // Track overall peak (for display)
        const maxDb = Math.max(dbL, dbR);
        if (maxDb > studioState.overallPeak) {
            studioState.overallPeak = maxDb;
        }
        
        // Update LUFS buffer (simplified - using RMS as approximation)
        const combinedRms = Math.sqrt((rmsL * rmsL + rmsR * rmsR) / 2);
        studioState.lufsBuffer.push({ time: now, value: combinedRms });
        
        // Trim old samples
        while (studioState.lufsBuffer.length > 0 && 
               now - studioState.lufsBuffer[0].time > studioState.lufsWindowSize) {
            studioState.lufsBuffer.shift();
        }
        
        // Calculate short-term LUFS (every 100ms)
        if (now - studioState.lastLufsUpdate > 100) {
            studioState.currentLufs = calculateShortTermLufs();
            studioState.lastLufsUpdate = now;
        }
        
        // Update L meter
        updateMeter(
            dbL,
            studioState.peakHoldL,
            elements.meterLFill,
            elements.meterLPeak,
            elements.meterLValue
        );
        
        // Update R meter
        updateMeter(
            dbR,
            studioState.peakHoldR,
            elements.meterRFill,
            elements.meterRPeak,
            elements.meterRValue
        );
        
        // Update readouts
        if (elements.peakValue) {
            const peakDisplay = studioState.overallPeak <= -60 ? '-∞' : `${Math.round(studioState.overallPeak)}`;
            elements.peakValue.textContent = peakDisplay;
            updateReadoutColor(elements.peakValue, studioState.overallPeak);
        }
        
        if (elements.lufsValue) {
            const lufsDisplay = studioState.currentLufs <= -60 ? '-∞' : studioState.currentLufs.toFixed(1);
            elements.lufsValue.textContent = lufsDisplay;
            updateLufsColor(elements.lufsValue, studioState.currentLufs);
        }
        
        // Update balance indicator
        if (elements.balanceValue) {
            const balance = calculateBalance(rmsL, rmsR);
            elements.balanceValue.textContent = balance;
        }
        
        // Update waveform if recording
        if (studioState.isRecording) {
            studioState.waveformData.push(Math.max(rmsL, rmsR));
        }
    }
    
    update();
}

/**
 * Calculate RMS from time domain data
 */
function calculateRms(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
}

/**
 * Calculate simplified short-term LUFS from buffer
 */
function calculateShortTermLufs() {
    if (studioState.lufsBuffer.length === 0) return -Infinity;
    
    let sum = 0;
    for (const sample of studioState.lufsBuffer) {
        sum += sample.value * sample.value;
    }
    const meanSquare = sum / studioState.lufsBuffer.length;
    const rms = Math.sqrt(meanSquare);
    
    // Convert to LUFS-like value (simplified, not true ITU-R BS.1770)
    // True LUFS requires K-weighting and gating, but this gives a reasonable approximation
    const lufs = 20 * Math.log10(rms) - 0.691;
    return isFinite(lufs) ? lufs : -Infinity;
}

/**
 * Calculate stereo balance string
 */
function calculateBalance(rmsL, rmsR) {
    const total = rmsL + rmsR;
    if (total < 0.001) return 'C';
    
    const ratio = (rmsR - rmsL) / total;
    
    if (Math.abs(ratio) < 0.1) return 'C';
    if (ratio > 0.5) return 'R';
    if (ratio > 0.2) return 'R↗';
    if (ratio < -0.5) return 'L';
    if (ratio < -0.2) return 'L↖';
    return ratio > 0 ? 'R↗' : 'L↖';
}

/**
 * Update a single meter
 */
function updateMeter(db, peakHold, fillEl, peakEl, valueEl) {
    // Convert dB to percentage (-60dB to 0dB range)
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    const peakPct = Math.max(0, Math.min(100, ((peakHold + 60) / 60) * 100));
    
    if (fillEl) {
        fillEl.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    }
    
    if (peakEl) {
        peakEl.style.left = `${peakPct}%`;
    }
    
    if (valueEl) {
        valueEl.textContent = db <= -60 ? '-∞ dB' : `${Math.round(db)} dB`;
    }
}

/**
 * Update readout color based on peak level
 */
function updateReadoutColor(el, db) {
    el.classList.remove('good', 'warn', 'bad');
    if (db > -6) {
        el.classList.add('bad');
    } else if (db > -12) {
        el.classList.add('warn');
    } else if (db > -40) {
        el.classList.add('good');
    }
}

/**
 * Update LUFS color based on broadcast standards
 */
function updateLufsColor(el, lufs) {
    el.classList.remove('good', 'warn', 'bad');
    if (lufs > -10) {
        el.classList.add('bad');
    } else if (lufs > -12 || lufs < -20) {
        el.classList.add('warn');
    } else if (lufs >= -18 && lufs <= -14) {
        el.classList.add('good');
    }
}

/**
 * Draw spectrogram visualization
 */
function drawSpectrogram(ctx, canvas, frequencyData) {
    const width = canvas.width;
    const height = canvas.height;
    
    // Shift existing image left by 1 pixel
    const imageData = ctx.getImageData(1, 0, width - 1, height);
    ctx.putImageData(imageData, 0, 0);
    
    // Draw new column on the right
    const numBins = frequencyData.length;
    const usableBins = Math.floor(numBins * 0.5); // Focus on lower frequencies
    const binHeight = height / usableBins;
    
    for (let i = 0; i < usableBins; i++) {
        const value = frequencyData[i];
        
        // Color mapping: dark blue -> cyan -> green -> yellow -> white
        let r, g, b;
        if (value < 50) {
            r = 0; g = 0; b = Math.floor(value * 1.5);
        } else if (value < 100) {
            const t = (value - 50) / 50;
            r = 0; g = Math.floor(t * 150); b = 80 + Math.floor(t * 100);
        } else if (value < 180) {
            const t = (value - 100) / 80;
            r = Math.floor(t * 255); g = 150 + Math.floor(t * 105); b = Math.floor(180 - t * 180);
        } else {
            const t = (value - 180) / 75;
            r = 255; g = 255; b = Math.floor(t * 255);
        }
        
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        const y = height - (i + 1) * binHeight;
        ctx.fillRect(width - 1, y, 1, binHeight + 1);
    }
}

/**
 * Draw oscilloscope (waveform) visualization
 * Classic scope display showing time-domain audio signal
 */
function drawOscilloscope(ctx, canvas, timeDomainData) {
    const width = canvas.width;
    const height = canvas.height;
    const centerY = height / 2;
    
    // Clear background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, width, height);
    
    // Draw center line (zero crossing reference)
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    
    // Draw waveform
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    // Map time domain data to canvas
    // getByteTimeDomainData returns values 0-255, with 128 being center (silence)
    const bufferLength = timeDomainData.length;
    const sliceWidth = width / bufferLength;
    
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
        // Convert 0-255 to normalized value (-1 to +1)
        const v = (timeDomainData[i] - 128) / 128;
        const y = centerY - (v * centerY * 0.9); // 0.9 adds slight padding
        
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
        
        x += sliceWidth;
    }
    
    ctx.stroke();
}

/**
 * Start recording - returns a promise that resolves when recording completes
 * @returns {Promise<boolean>} Resolves to true if recording completed successfully
 */
export function startRecording() {
    if (!studioState.stream || studioState.isRecording) {
        return Promise.resolve(false);
    }
    
    const { supported } = getMediaRecorderSupport();
    if (!supported) {
        console.error('MediaRecorder not supported');
        return Promise.resolve(false);
    }
    
    studioState.recorder = new PlaybackRecorder(studioState.stream);
    studioState.isRecording = true;
    studioState.recordingStartTime = performance.now();
    studioState.waveformData = [];
    
    // Clean up old recording
    if (studioState.recordingUrl) {
        URL.revokeObjectURL(studioState.recordingUrl);
        studioState.recordingUrl = null;
    }
    
    // Start recording (max 30 seconds) - returns promise that resolves when complete
    return studioState.recorder.start(30000)
        .then(blobUrl => {
            studioState.recordingUrl = blobUrl;
            studioState.isRecording = false;
            return true;
        })
        .catch(error => {
            console.error('Recording failed:', error);
            studioState.isRecording = false;
            return false;
        });
}

/**
 * Stop recording gracefully (keeps the recording)
 */
export function stopRecording() {
    if (studioState.recorder) {
        studioState.recorder.stop();
        // Note: isRecording will be set to false when the promise resolves
    }
}

/**
 * Get current recording time in seconds
 */
export function getRecordingTime() {
    if (!studioState.isRecording) return 0;
    return (performance.now() - studioState.recordingStartTime) / 1000;
}

/**
 * Check if recording exists
 */
export function hasRecording() {
    return studioState.recordingUrl !== null;
}

/**
 * Get recording URL for playback
 */
export function getRecordingUrl() {
    return studioState.recordingUrl;
}

/**
 * Get waveform data for visualization
 */
export function getWaveformData() {
    return studioState.waveformData;
}

/**
 * Delete current recording
 */
export function deleteRecording() {
    if (studioState.recordingUrl) {
        URL.revokeObjectURL(studioState.recordingUrl);
        studioState.recordingUrl = null;
    }
    studioState.waveformData = [];
    if (studioState.recorder) {
        studioState.recorder.cleanup();
    }
}

/**
 * Check if currently recording
 */
export function isRecording() {
    return studioState.isRecording;
}

/**
 * Reset peak meters
 */
export function resetPeaks() {
    studioState.overallPeak = -Infinity;
    studioState.peakHoldL = -Infinity;
    studioState.peakHoldR = -Infinity;
}

/**
 * Set processing mode (AGC on/off)
 */
export function setProcessingEnabled(enabled) {
    studioState.processingEnabled = enabled;
    // Will take effect on next device switch
}

/**
 * Get current processing mode
 */
export function isProcessingEnabled() {
    return studioState.processingEnabled;
}

/**
 * Clean up all resources
 */
export async function cleanupStudio() {
    // Stop animation
    if (studioState.animationId) {
        cancelAnimationFrame(studioState.animationId);
        studioState.animationId = null;
    }
    
    // Stop recording if active and clean up recorder
    if (studioState.recorder) {
        if (studioState.isRecording) {
            studioState.recorder.abort();
        }
        studioState.recorder.cleanup();
        studioState.recorder = null;
    }
    studioState.isRecording = false;
    
    // Clean up recording URL
    if (studioState.recordingUrl) {
        URL.revokeObjectURL(studioState.recordingUrl);
        studioState.recordingUrl = null;
    }
    
    // Stop stream tracks
    if (studioState.stream) {
        studioState.stream.getTracks().forEach(track => track.stop());
        studioState.stream = null;
    }
    
    // Disconnect audio nodes
    if (studioState.source) {
        try { studioState.source.disconnect(); } catch (e) {}
        studioState.source = null;
    }
    if (studioState.splitter) {
        try { studioState.splitter.disconnect(); } catch (e) {}
        studioState.splitter = null;
    }
    
    // Close audio context
    if (studioState.audioContext && studioState.audioContext.state !== 'closed') {
        try { await studioState.audioContext.close(); } catch (e) {}
        studioState.audioContext = null;
    }
    
    // Reset state
    studioState.analyser = null;
    studioState.analyserL = null;
    studioState.analyserR = null;
    studioState.deviceId = null;
    studioState.spectrogramCtx = null;
    studioState.frequencyData = null;
    studioState.oscilloscopeCtx = null;
    studioState.timeDomainData = null;
    studioState.isRunning = false;
    studioState.isRecording = false;
    studioState.waveformData = [];
    studioState.lufsBuffer = [];
    studioState.currentLufs = -Infinity;
    studioState.overallPeak = -Infinity;
}

/**
 * Populate device dropdown for studio
 */
export async function populateStudioDeviceDropdown(selectElement, selectedDeviceId) {
    await populateDeviceDropdown(selectElement, {
        selectedDeviceId,
        skipCommunications: true,
        isChromiumBased: isChromiumBased()
    });
}

/**
 * Check if studio is running
 */
export function isRunning() {
    return studioState.isRunning;
}

/**
 * Get channel count (1 = mono, 2 = stereo)
 */
export function getChannelCount() {
    return studioState.channelCount;
}

/**
 * Check if current device is mono
 */
export function isMono() {
    return studioState.channelCount === 1;
}

/**
 * Get current device ID
 */
export function getCurrentDeviceId() {
    return studioState.deviceId;
}

/**
 * Draw waveform preview on canvas
 */
export function drawWaveformPreview(canvas) {
    if (!canvas || studioState.waveformData.length === 0) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear (CSS variables don't work in canvas, use computed style or fallback)
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-muted').trim() || '#1a1a2e';
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);
    
    // Draw waveform
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    const data = studioState.waveformData;
    const step = Math.max(1, Math.floor(data.length / width));
    
    for (let i = 0; i < width; i++) {
        const idx = Math.min(Math.floor(i * data.length / width), data.length - 1);
        const value = data[idx] || 0;
        const y = height / 2 - (value * height * 2);
        
        if (i === 0) {
            ctx.moveTo(i, y);
        } else {
            ctx.lineTo(i, y);
        }
    }
    
    // Mirror for symmetry
    for (let i = width - 1; i >= 0; i--) {
        const idx = Math.min(Math.floor(i * data.length / width), data.length - 1);
        const value = data[idx] || 0;
        const y = height / 2 + (value * height * 2);
        ctx.lineTo(i, y);
    }
    
    ctx.closePath();
    ctx.fillStyle = 'rgba(26, 115, 232, 0.3)';
    ctx.fill();
    ctx.stroke();
}
