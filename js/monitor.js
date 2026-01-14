/**
 * Monitor Module
 * 
 * Handles the Audio Monitor screen with detailed visualizations.
 * - Spectrogram
 * - Level meter with dB display
 * - Extensible for future visualizations
 */

import { getRmsFromAnalyser, cleanupAudioResources, populateDeviceDropdown } from './utils.js';
import { isChromiumBased } from './browser.js';
import { linearToDb } from './standards.js';

/**
 * State for the monitor screen
 */
const monitorScreenState = {
    audioContext: null,
    stream: null,
    source: null,
    analyser: null,
    animationId: null,
    deviceId: null,
    spectrogramCtx: null,
    frequencyData: null,
    isRunning: false
};

/**
 * Initialize the monitor with a specific device
 * @param {string} deviceId - The device ID to monitor
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function initMonitor(deviceId) {
    // Clean up any existing monitor
    await cleanupMonitor();
    
    try {
        // Get stream for this device
        const constraints = deviceId 
            ? { audio: { deviceId: { exact: deviceId } } }
            : { audio: true };
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // Create AudioContext
        monitorScreenState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await monitorScreenState.audioContext.resume();
        
        // Create source and analyser
        monitorScreenState.source = monitorScreenState.audioContext.createMediaStreamSource(stream);
        monitorScreenState.analyser = monitorScreenState.audioContext.createAnalyser();
        monitorScreenState.analyser.fftSize = 2048;
        monitorScreenState.analyser.smoothingTimeConstant = 0.3;
        monitorScreenState.source.connect(monitorScreenState.analyser);
        
        // Store state
        monitorScreenState.stream = stream;
        monitorScreenState.deviceId = deviceId;
        monitorScreenState.isRunning = true;
        
        // Get track info
        const track = stream.getAudioTracks()[0];
        const label = track?.label || 'Unknown Microphone';
        
        return { success: true, label };
        
    } catch (error) {
        console.error('Failed to init monitor:', error);
        await cleanupMonitor();
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
 * @param {string} deviceId - The new device ID
 * @returns {Promise<{success: boolean, error?: string, label?: string}>}
 */
export async function switchDevice(deviceId) {
    return initMonitor(deviceId);
}

/**
 * Start the visualization loop
 * @param {HTMLCanvasElement} spectrogramCanvas - Canvas for spectrogram
 * @param {HTMLElement} levelBar - Level bar fill element
 * @param {HTMLElement} levelText - Level text element
 */
export function startVisualization(spectrogramCanvas, levelBar, levelText) {
    if (!monitorScreenState.analyser || !monitorScreenState.isRunning) {
        console.error('Monitor not initialized');
        return;
    }
    
    // Cancel any existing animation loop to prevent duplicates
    if (monitorScreenState.animationId) {
        cancelAnimationFrame(monitorScreenState.animationId);
        monitorScreenState.animationId = null;
    }
    
    // Set up spectrogram canvas
    if (spectrogramCanvas) {
        monitorScreenState.spectrogramCtx = spectrogramCanvas.getContext('2d');
        monitorScreenState.frequencyData = new Uint8Array(monitorScreenState.analyser.frequencyBinCount);
        
        // Clear canvas with dark background
        monitorScreenState.spectrogramCtx.fillStyle = '#0a0a0a';
        monitorScreenState.spectrogramCtx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
    }
    
    function update() {
        if (!monitorScreenState.isRunning || !monitorScreenState.audioContext || 
            monitorScreenState.audioContext.state === 'closed') {
            monitorScreenState.animationId = null;
            return;
        }
        
        monitorScreenState.animationId = requestAnimationFrame(update);
        
        // Update spectrogram
        if (monitorScreenState.spectrogramCtx && monitorScreenState.frequencyData && spectrogramCanvas) {
            monitorScreenState.analyser.getByteFrequencyData(monitorScreenState.frequencyData);
            drawSpectrogram(
                monitorScreenState.spectrogramCtx, 
                spectrogramCanvas, 
                monitorScreenState.frequencyData
            );
        }
        
        // Update level meter
        if (levelBar && levelText) {
            const rms = getRmsFromAnalyser(monitorScreenState.analyser);
            const level = Math.min(100, rms * 250);
            
            // Calculate dB using shared utility
            const db = linearToDb(rms);
            const dbDisplay = db <= -60 ? '-∞ dB' : `${Math.round(db)} dB`;
            
            // Update UI
            levelBar.style.clipPath = `inset(0 ${100 - level}% 0 0)`;
            levelText.textContent = dbDisplay;
        }
    }
    
    update();
}

/**
 * Draw spectrogram (scrolling frequency display)
 * @param {CanvasRenderingContext2D} ctx 
 * @param {HTMLCanvasElement} canvas 
 * @param {Uint8Array} frequencyData 
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
 * Get the current monitor stream (for playback recording)
 * @returns {MediaStream|null}
 */
export function getMonitorStream() {
    return monitorScreenState.stream;
}

/**
 * Get the current monitor analyser (for peak level tracking during recording)
 * @returns {AnalyserNode|null}
 */
export function getMonitorAnalyser() {
    return monitorScreenState.analyser;
}

/**
 * Stop visualization and clean up
 */
export async function cleanupMonitor() {
    // Stop animation
    if (monitorScreenState.animationId) {
        cancelAnimationFrame(monitorScreenState.animationId);
        monitorScreenState.animationId = null;
    }
    
    // Clean up audio resources using shared utility
    const cleaned = await cleanupAudioResources({
        stream: monitorScreenState.stream,
        audioContext: monitorScreenState.audioContext,
        source: monitorScreenState.source,
        analyser: monitorScreenState.analyser
    });
    
    monitorScreenState.stream = cleaned.stream;
    monitorScreenState.audioContext = cleaned.audioContext;
    monitorScreenState.source = cleaned.source;
    monitorScreenState.analyser = cleaned.analyser;
    
    // Reset monitor-specific state
    monitorScreenState.deviceId = null;
    monitorScreenState.spectrogramCtx = null;
    monitorScreenState.frequencyData = null;
    monitorScreenState.isRunning = false;
}

/**
 * Check if monitor is running
 * @returns {boolean}
 */
export function isRunning() {
    return monitorScreenState.isRunning;
}

/**
 * Get current device ID
 * @returns {string|null}
 */
export function getCurrentDeviceId() {
    return monitorScreenState.deviceId;
}

/**
 * Populate the device dropdown for the monitor screen
 * @param {HTMLSelectElement} selectElement 
 * @param {string} selectedDeviceId - Device to pre-select
 */
export async function populateMonitorDeviceDropdown(selectElement, selectedDeviceId) {
    await populateDeviceDropdown(selectElement, {
        selectedDeviceId,
        skipCommunications: true,
        isChromiumBased: isChromiumBased()
    });
}
