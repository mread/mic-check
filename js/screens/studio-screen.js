/**
 * Studio Monitor Screen Logic
 * 
 * Handles DAW-style monitoring, recording, and playback.
 */

import { checkPermission } from '../browser.js';

import {
    initStudio,
    startVisualization as startStudioVisualization,
    cleanupStudio,
    populateStudioDeviceDropdown,
    startRecording as startStudioRecording,
    stopRecording as stopStudioRecording,
    hasRecording,
    getRecordings,
    getRecording,
    deleteRecording,
    setRecordingProcessing,
    setRecordingProcessed,
    addRecordingToLibrary,
    isRecordingsFull,
    getMaxRecordings,
    isRecording as isStudioRecording,
    resetPeaks,
    getWaveformData,
    isRunning as isStudioRunning,
    getChannelCount
} from '../studio.js';

import {
    decodeRecordingBlob,
    measureBufferLufs,
    processForStreaming,
    audioBufferToWavUrl
} from '../mastering.js';

// ============================================
// Studio Monitor Screen (DAW-style)
// ============================================

let studioRecordingTimer = null;
let selectedStudioDeviceId = null;
let studioListenersAttached = false;

/**
 * Get all studio UI elements
 */
function getStudioElements() {
    return {
        // Transport
        deviceSelect: document.getElementById('studio-device-select'),
        btnRecord: document.getElementById('studio-btn-record'),
        btnStop: document.getElementById('studio-btn-stop'),
        btnPlay: document.getElementById('studio-btn-play'),
        timeDisplay: document.getElementById('studio-time'),
        statusDisplay: document.getElementById('studio-status'),
        
        // Permission prompt
        permissionPrompt: document.getElementById('studio-permission-prompt'),
        btnGrant: document.getElementById('studio-btn-grant'),
        
        // Visualization container
        vizContainer: document.getElementById('studio-viz-container'),
        spectrogramCanvas: document.getElementById('studio-spectrogram'),
        spectrumCanvas: document.getElementById('studio-spectrum'),
        oscilloscopeCanvas: document.getElementById('studio-oscilloscope'),
        
        // Vertical Meters
        levelsLabel: document.getElementById('studio-levels-label'),
        meterColL: document.getElementById('studio-meter-col-l'),
        meterColR: document.getElementById('studio-meter-col-r'),
        meterLabelL: document.getElementById('studio-meter-label-l'),
        meterLFill: document.getElementById('studio-meter-l-fill'),
        meterLPeak: document.getElementById('studio-meter-l-peak'),
        meterRFill: document.getElementById('studio-meter-r-fill'),
        meterRPeak: document.getElementById('studio-meter-r-peak'),
        meterDb: document.getElementById('studio-meter-db'),
        
        // Readouts
        peakValue: document.getElementById('studio-peak-value'),
        lufsValue: document.getElementById('studio-lufs-value'),
        balanceContainer: document.getElementById('studio-balance-container'),
        balanceValue: document.getElementById('studio-balance-value'),
        
        // Recordings library
        recordingsContainer: document.getElementById('studio-recordings-container'),
        recordingsCount: document.getElementById('studio-recordings-count'),
        recordingStatus: document.getElementById('studio-recording-status'),
        recTime: document.getElementById('studio-rec-time'),
        recordingsList: document.getElementById('studio-recordings-list')
    };
}

// Track active playback per recording
let activePlaybackId = null;
let activePlaybackAudio = null;

/**
 * Initialize the studio monitor screen
 */
async function initStudioScreen() {
    const els = getStudioElements();
    
    // Set up event listeners
    setupStudioEventListeners(els);
    
    // Check permission status
    const permStatus = await checkPermission();
    
    if (permStatus === 'granted') {
        // Already have permission - show visualizations
        await showStudioVisualizations(els);
    } else {
        // Show permission prompt
        els.permissionPrompt.style.display = 'block';
        els.vizContainer.style.display = 'none';
        els.recordingsContainer.style.display = 'none';
        
        // Disable transport controls
        els.btnRecord.disabled = true;
        els.btnStop.disabled = true;
        els.btnPlay.disabled = true;
    }
}

/**
 * Show studio visualizations after permission granted
 */
async function showStudioVisualizations(els) {
    // Hide permission prompt, show viz
    els.permissionPrompt.style.display = 'none';
    els.vizContainer.style.display = 'block';
    els.recordingsContainer.style.display = 'block';
    
    // Populate device dropdown
    await populateStudioDeviceDropdown(els.deviceSelect, selectedStudioDeviceId);
    
    // Get device to use
    const deviceId = els.deviceSelect.value || selectedStudioDeviceId;
    
    if (deviceId) {
        await startStudioMonitor(deviceId, els);
    }
    
    // Render initial recordings list
    renderRecordingsList(els);
}

/**
 * Start the studio monitor with a device
 */
async function startStudioMonitor(deviceId, els) {
    const result = await initStudio(deviceId);
    
    if (result.success) {
        selectedStudioDeviceId = deviceId;
        
        // Enable transport controls
        els.btnRecord.disabled = false;
        els.btnStop.disabled = true;
        els.btnPlay.disabled = !hasRecording();
        els.statusDisplay.textContent = 'Monitoring';
        els.statusDisplay.className = 'transport-status';
        
        // Update meter display for mono vs stereo
        updateMeterDisplay(els);
        
        // Start visualization
        startStudioVisualization(els);
        
    } else {
        els.statusDisplay.textContent = result.error || 'Error';
        els.statusDisplay.className = 'transport-status';
        console.warn('Failed to start studio:', result.error);
    }
}

/**
 * Update meter display for mono vs stereo devices
 */
function updateMeterDisplay(els) {
    const channelCount = getChannelCount();
    const isMono = channelCount === 1;
    
    if (isMono) {
        // Hide R meter column for mono devices
        if (els.meterColR) {
            els.meterColR.style.display = 'none';
        }
        // Update L label to indicate it's the only channel
        if (els.meterLabelL) {
            els.meterLabelL.textContent = '●';  // Single dot for mono
        }
        // Update label text while preserving help icon
        if (els.levelsLabel) {
            updateLabelText(els.levelsLabel, 'Level (Mono)');
        }
        // Hide Balance panel - meaningless for mono
        if (els.balanceContainer) {
            els.balanceContainer.style.display = 'none';
        }
    } else {
        // Show R meter column for stereo devices
        if (els.meterColR) {
            els.meterColR.style.display = '';
        }
        // Reset L label
        if (els.meterLabelL) {
            els.meterLabelL.textContent = 'L';
        }
        // Update label text while preserving help icon
        if (els.levelsLabel) {
            updateLabelText(els.levelsLabel, 'Levels');
        }
        // Show Balance panel for stereo
        if (els.balanceContainer) {
            els.balanceContainer.style.display = '';
        }
    }
}

/**
 * Update only the text content of a label, preserving child elements (like help icons)
 */
function updateLabelText(element, newText) {
    // Find the first text node and update it
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            node.textContent = newText + ' ';  // Add space before help icon
            return;
        }
    }
    // If no text node found, prepend one
    element.insertBefore(document.createTextNode(newText + ' '), element.firstChild);
}

/**
 * Set up event listeners for studio screen
 */
function setupStudioEventListeners(els) {
    // Guard against duplicate listeners on re-navigation
    if (studioListenersAttached) return;
    studioListenersAttached = true;
    
    // Grant permission button
    els.btnGrant?.addEventListener('click', async () => {
        try {
            // Request mic access
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop()); // Release immediately
            
            // Now show visualizations
            await showStudioVisualizations(els);
        } catch (err) {
            console.error('Permission denied:', err);
            els.btnGrant.textContent = 'Permission Denied';
            els.btnGrant.disabled = true;
        }
    });
    
    // Device select
    els.deviceSelect?.addEventListener('change', async (e) => {
        const deviceId = e.target.value;
        if (deviceId) {
            // Stop any recording in progress
            if (isStudioRecording()) {
                stopStudioRecording();
                hideRecordingStatus(els);
            }
            await startStudioMonitor(deviceId, els);
        }
    });
    
    // Record button
    els.btnRecord?.addEventListener('click', async () => {
        if (isStudioRecording()) return;
        
        // Check if at capacity
        if (isRecordingsFull()) {
            els.statusDisplay.textContent = `Max ${getMaxRecordings()} recordings`;
            els.statusDisplay.className = 'transport-status';
            return;
        }
        
        els.btnRecord.classList.add('recording');
        els.btnRecord.disabled = true;
        els.btnStop.disabled = false;
        els.btnPlay.disabled = true;
        
        // Show pre-roll state
        els.statusDisplay.textContent = 'Starting...';
        els.statusDisplay.className = 'transport-status';
        
        // Reset peaks when starting new recording
        resetPeaks();
        
        // Start recording (includes 250ms pre-roll delay)
        const recordingPromise = startStudioRecording();
        
        // Wait a tick for pre-roll to begin, then show recording state
        setTimeout(() => {
            if (isStudioRecording()) {
                showRecordingStatus(els);
                els.statusDisplay.textContent = 'Recording';
                els.statusDisplay.className = 'transport-status recording';
            }
        }, 260);
        
        // Start timer after pre-roll completes
        setTimeout(() => {
            if (isStudioRecording()) {
                const startTime = Date.now();
                studioRecordingTimer = setInterval(() => {
                    const elapsed = (Date.now() - startTime) / 1000;
                    els.recTime.textContent = formatTime(elapsed);
                    els.timeDisplay.textContent = formatTime(elapsed);
                }, 100);
            }
        }, 250);
        
        const recordingUrl = await recordingPromise;
        
        // Recording ended (either completed or stopped)
        clearInterval(studioRecordingTimer);
        await handleRecordingComplete(els, recordingUrl);
    });
    
    // Stop button
    els.btnStop?.addEventListener('click', () => {
        if (isStudioRecording()) {
            // Clear the recording timer
            if (studioRecordingTimer) {
                clearInterval(studioRecordingTimer);
                studioRecordingTimer = null;
            }
            stopStudioRecording();
        }
        // Stop any active playback
        stopActivePlayback(els);
    });
    
    // Play button (transport) - plays most recent recording
    els.btnPlay?.addEventListener('click', () => {
        const recordings = getRecordings();
        if (recordings.length > 0) {
            const latest = recordings[recordings.length - 1];
            // Prefer processed if available, otherwise raw
            const url = latest.processedUrl || latest.rawUrl;
            const type = latest.processedUrl ? 'processed' : 'raw';
            toggleRecordingPlayback(els, latest.id, type, url);
        }
    });
}

// ============================================
// Recording Status UI
// ============================================

/**
 * Show recording status indicator
 */
function showRecordingStatus(els) {
    if (els.recordingStatus) {
        els.recordingStatus.style.display = 'flex';
    }
    // Hide empty state while recording
    const emptyState = els.recordingsList?.querySelector('.studio-recordings-empty');
    if (emptyState) {
        emptyState.style.display = 'none';
    }
}

/**
 * Hide recording status indicator
 */
function hideRecordingStatus(els) {
    if (els.recordingStatus) {
        els.recordingStatus.style.display = 'none';
    }
    els.recTime.textContent = '00:00';
    
    // Restore empty state if no recordings exist
    const recordings = getRecordings();
    if (recordings.length === 0) {
        const emptyState = els.recordingsList?.querySelector('.studio-recordings-empty');
        if (emptyState) {
            emptyState.style.display = 'flex';
        }
    }
}

/**
 * Handle recording completion - measure and add to library
 */
async function handleRecordingComplete(els, recordingUrl) {
    els.btnRecord.classList.remove('recording');
    els.btnRecord.disabled = false;
    els.btnStop.disabled = true;
    hideRecordingStatus(els);
    els.statusDisplay.textContent = 'Monitoring';
    els.statusDisplay.className = 'transport-status';
    
    if (!recordingUrl) return;
    
    // Get duration from timer
    const duration = parseFloat(els.timeDisplay.textContent.split(':').reduce((acc, t) => acc * 60 + parseFloat(t), 0)) || 0;
    
    // Measure LUFS and peak
    try {
        const inputBuffer = await decodeRecordingBlob(recordingUrl);
        const { lufs } = await measureBufferLufs(inputBuffer);
        const peak = measureBufferPeak(inputBuffer);
        
        // Get waveform data
        const waveformData = getWaveformData().slice(); // Copy
        
        // Add to library
        const recording = addRecordingToLibrary({
            rawUrl: recordingUrl,
            rawLufs: lufs,
            rawPeak: peak,
            rawWaveformData: waveformData,
            duration: duration
        });
        
        if (recording) {
            // Enable transport play button
            els.btnPlay.disabled = false;
            
            // Re-render the list
            renderRecordingsList(els);
        }
    } catch (err) {
        console.error('Failed to measure recording:', err);
        // Still add it without measurements
        addRecordingToLibrary({
            rawUrl: recordingUrl,
            rawLufs: null,
            rawPeak: null,
            rawWaveformData: getWaveformData().slice(),
            duration: duration
        });
        renderRecordingsList(els);
    }
}

// ============================================
// Recordings List Rendering
// ============================================

/**
 * Render the recordings list UI
 */
function renderRecordingsList(els) {
    const recordings = getRecordings();
    const list = els.recordingsList;
    if (!list) return;
    
    // Update count
    if (els.recordingsCount) {
        const max = getMaxRecordings();
        els.recordingsCount.textContent = recordings.length > 0 
            ? `${recordings.length}/${max}` 
            : '';
    }
    
    // Empty state
    if (recordings.length === 0) {
        list.innerHTML = '<div class="studio-recordings-empty">Press ⏺ to record</div>';
        return;
    }
    
    // Build HTML for all recordings
    let html = '';
    recordings.forEach((rec, idx) => {
        html += renderRecordingGroup(rec, idx);
    });
    
    list.innerHTML = html;
    
    // Draw waveforms after DOM is updated
    recordings.forEach(rec => {
        drawRecordingWaveform(`waveform-raw-${rec.id}`, rec.rawWaveformData);
        if (rec.processedWaveformData) {
            drawRecordingWaveform(`waveform-processed-${rec.id}`, rec.processedWaveformData);
        }
    });
    
    // Attach event listeners
    attachRecordingListeners(els);
}

/**
 * Render a single recording group (raw + optional processed)
 */
function renderRecordingGroup(rec, idx) {
    const rawLufsDisplay = rec.rawLufs != null ? rec.rawLufs.toFixed(1) : '—';
    const rawPeakDisplay = rec.rawPeak != null ? rec.rawPeak.toFixed(1) : '—';
    const durationDisplay = formatTime(rec.duration || 0);
    
    let html = `<div class="recording-group" data-recording-id="${rec.id}">`;
    
    // Raw row
    html += `
        <div class="recording-row raw">
            <span class="recording-type raw">Raw</span>
            <div class="recording-waveform">
                <canvas id="waveform-raw-${rec.id}" width="300" height="36"></canvas>
            </div>
            <span class="recording-duration">${durationDisplay}</span>
            <div class="recording-metrics">
                <div class="recording-metric">
                    <span class="recording-metric-label">LUFS</span>
                    <span class="recording-metric-value ${getLufsClass(rec.rawLufs)}">${rawLufsDisplay}</span>
                </div>
                <div class="recording-metric">
                    <span class="recording-metric-label">Peak</span>
                    <span class="recording-metric-value ${getPeakClass(rec.rawPeak)}">${rawPeakDisplay}</span>
                </div>
            </div>
            <div class="recording-actions">
                <button class="recording-btn" data-action="play" data-id="${rec.id}" data-type="raw">▶</button>
                ${!rec.processedUrl && !rec.isProcessing ? `<button class="recording-btn process" data-action="process" data-id="${rec.id}">Process</button>` : ''}
                ${rec.isProcessing ? `<button class="recording-btn processing" disabled>Processing...</button>` : ''}
                <button class="recording-btn" data-action="delete" data-id="${rec.id}">🗑</button>
            </div>
        </div>
    `;
    
    // Processed row (if exists)
    if (rec.processedUrl) {
        const procLufsDisplay = rec.processedLufs != null ? rec.processedLufs.toFixed(1) : '—';
        const procPeakDisplay = rec.processedPeak != null ? rec.processedPeak.toFixed(1) : '—';
        
        html += `
            <div class="recording-row processed">
                <span class="recording-type processed">↳ Processed</span>
                <div class="recording-waveform">
                    <canvas id="waveform-processed-${rec.id}" width="300" height="36"></canvas>
                </div>
                <span class="recording-duration">${durationDisplay}</span>
                <div class="recording-metrics">
                    <div class="recording-metric">
                        <span class="recording-metric-label">LUFS</span>
                        <span class="recording-metric-value ${getLufsClass(rec.processedLufs, true)}">${procLufsDisplay}</span>
                    </div>
                    <div class="recording-metric">
                        <span class="recording-metric-label">Peak</span>
                        <span class="recording-metric-value ${getPeakClass(rec.processedPeak, true)}">${procPeakDisplay}</span>
                    </div>
                </div>
                <div class="recording-actions">
                    <button class="recording-btn" data-action="play" data-id="${rec.id}" data-type="processed">▶</button>
                    <button class="recording-btn" data-action="delete-processed" data-id="${rec.id}">🗑</button>
                </div>
            </div>
        `;
    }
    
    html += '</div>';
    return html;
}

/**
 * Get CSS class for LUFS value
 */
function getLufsClass(lufs, isProcessed = false) {
    if (lufs == null) return '';
    if (isProcessed) {
        // For processed, we want it close to -14
        return Math.abs(lufs - (-14)) <= 1.5 ? 'good' : 'warn';
    }
    // For raw, show guidance
    if (lufs > -10) return 'bad';
    if (lufs < -24) return 'warn';
    return '';
}

/**
 * Get CSS class for peak value
 */
function getPeakClass(peak, isProcessed = false) {
    if (peak == null) return '';
    if (isProcessed) {
        // For processed, we want it close to -1
        return peak <= -0.5 && peak >= -2 ? 'good' : '';
    }
    // For raw
    if (peak > -3) return 'bad';
    if (peak > -6) return 'warn';
    return '';
}

/**
 * Draw waveform on a canvas
 */
function drawRecordingWaveform(canvasId, waveformData) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !waveformData || waveformData.length === 0) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-muted').trim() || '#1a1a2e';
    ctx.fillRect(0, 0, width, height);
    
    // Draw waveform
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    for (let i = 0; i < width; i++) {
        const idx = Math.min(Math.floor(i * waveformData.length / width), waveformData.length - 1);
        const value = waveformData[idx] || 0;
        const y = height / 2 - (value * height * 2);
        
        if (i === 0) {
            ctx.moveTo(i, y);
        } else {
            ctx.lineTo(i, y);
        }
    }
    
    // Mirror for symmetry
    for (let i = width - 1; i >= 0; i--) {
        const idx = Math.min(Math.floor(i * waveformData.length / width), waveformData.length - 1);
        const value = waveformData[idx] || 0;
        const y = height / 2 + (value * height * 2);
        ctx.lineTo(i, y);
    }
    
    ctx.closePath();
    ctx.fillStyle = 'rgba(26, 115, 232, 0.3)';
    ctx.fill();
    ctx.stroke();
}

/**
 * Attach event listeners to recording list buttons
 */
function attachRecordingListeners(els) {
    const list = els.recordingsList;
    if (!list) return;
    
    // Use event delegation
    list.onclick = async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        
        const action = btn.dataset.action;
        const id = parseInt(btn.dataset.id, 10);
        const type = btn.dataset.type;
        
        switch (action) {
            case 'play':
                const rec = getRecording(id);
                if (rec) {
                    const url = type === 'processed' ? rec.processedUrl : rec.rawUrl;
                    toggleRecordingPlayback(els, id, type, url);
                }
                break;
                
            case 'process':
                await processRecording(els, id);
                break;
                
            case 'delete':
                deleteRecording(id);
                stopActivePlayback(els);
                renderRecordingsList(els);
                // Update transport play button
                els.btnPlay.disabled = !hasRecording();
                break;
                
            case 'delete-processed':
                const recording = getRecording(id);
                if (recording && recording.processedUrl) {
                    URL.revokeObjectURL(recording.processedUrl);
                    recording.processedUrl = null;
                    recording.processedLufs = null;
                    recording.processedPeak = null;
                    recording.processedWaveformData = null;
                    renderRecordingsList(els);
                }
                break;
        }
    };
}

// ============================================
// Playback Functions
// ============================================

/**
 * Toggle playback for a specific recording
 */
function toggleRecordingPlayback(els, id, type, url) {
    const playingKey = `${id}-${type}`;
    
    // If this recording is already playing, stop it
    if (activePlaybackId === playingKey && activePlaybackAudio && !activePlaybackAudio.paused) {
        activePlaybackAudio.pause();
        activePlaybackAudio.currentTime = 0;
        updatePlaybackButton(id, type, false);
        els.btnPlay.classList.remove('playing');
        els.statusDisplay.textContent = 'Monitoring';
        els.statusDisplay.className = 'transport-status';
        activePlaybackId = null;
        return;
    }
    
    // Stop any other playback
    stopActivePlayback(els);
    
    // Start new playback
    if (!activePlaybackAudio) {
        activePlaybackAudio = new Audio();
    }
    
    activePlaybackAudio.src = url;
    activePlaybackAudio.onended = () => {
        updatePlaybackButton(id, type, false);
        els.btnPlay.classList.remove('playing');
        els.statusDisplay.textContent = 'Monitoring';
        els.statusDisplay.className = 'transport-status';
        activePlaybackId = null;
    };
    
    activePlaybackAudio.play().catch(err => {
        console.warn('Playback failed:', err);
        // Reset UI on failure (e.g., browser autoplay policy)
        updatePlaybackButton(id, type, false);
        els.btnPlay.classList.remove('playing');
        els.statusDisplay.textContent = 'Monitoring';
        els.statusDisplay.className = 'transport-status';
        activePlaybackId = null;
    });
    
    activePlaybackId = playingKey;
    updatePlaybackButton(id, type, true);
    els.btnPlay.classList.add('playing');
    els.statusDisplay.textContent = 'Playing';
    els.statusDisplay.className = 'transport-status playing';
}

/**
 * Stop any active playback
 */
function stopActivePlayback(els) {
    if (activePlaybackAudio) {
        activePlaybackAudio.pause();
        activePlaybackAudio.currentTime = 0;
    }
    
    // Reset all play buttons
    document.querySelectorAll('[data-action="play"]').forEach(btn => {
        btn.textContent = '▶';
        btn.classList.remove('playing');
    });
    
    els.btnPlay.classList.remove('playing');
    els.statusDisplay.textContent = 'Monitoring';
    els.statusDisplay.className = 'transport-status';
    activePlaybackId = null;
}

/**
 * Update a specific play button
 */
function updatePlaybackButton(id, type, isPlaying) {
    const btn = document.querySelector(`[data-action="play"][data-id="${id}"][data-type="${type}"]`);
    if (btn) {
        btn.textContent = isPlaying ? '⏹' : '▶';
        btn.classList.toggle('playing', isPlaying);
    }
}

// ============================================
// Processing Functions
// ============================================

/**
 * Process a specific recording
 */
async function processRecording(els, id) {
    const rec = getRecording(id);
    if (!rec || !rec.rawUrl) return;
    
    // Mark as processing
    setRecordingProcessing(id, true);
    renderRecordingsList(els);
    
    try {
        // Decode and process
        const inputBuffer = await decodeRecordingBlob(rec.rawUrl);
        const result = await processForStreaming(inputBuffer);
        
        // Create URL and get waveform
        const processedUrl = audioBufferToWavUrl(result.buffer);
        
        // Generate waveform data from processed buffer
        const processedWaveformData = extractWaveformFromBuffer(result.buffer);
        
        // Update recording
        setRecordingProcessed(id, {
            processedUrl,
            processedLufs: result.outputLufs,
            processedPeak: result.outputPeak,
            processedWaveformData
        });
        
        // Re-render
        renderRecordingsList(els);
        
    } catch (err) {
        console.error('Processing failed:', err);
        setRecordingProcessing(id, false);
        renderRecordingsList(els);
    }
}

/**
 * Extract waveform data from an AudioBuffer for visualization
 */
function extractWaveformFromBuffer(buffer) {
    const data = buffer.getChannelData(0);
    const samples = 300; // Enough points for the small canvas
    const blockSize = Math.floor(data.length / samples);
    const waveform = [];
    
    for (let i = 0; i < samples; i++) {
        let sum = 0;
        const start = i * blockSize;
        for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(data[start + j]);
        }
        waveform.push(sum / blockSize);
    }
    
    return waveform;
}

/**
 * Measure peak level of an AudioBuffer in dBFS
 * Returns a finite value (clamped to -100 dB for silent audio)
 */
function measureBufferPeak(buffer) {
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
            const abs = Math.abs(data[i]);
            if (abs > peak) peak = abs;
        }
    }
    // Convert to dB, clamp to -100 for display (avoids -Infinity)
    if (peak === 0) return -100;
    const db = 20 * Math.log10(peak);
    return Math.max(db, -100);
}

/**
 * Format seconds to MM:SS
 */
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Stop the studio monitor
 */
function stopStudioScreen() {
    // Stop any recording
    if (isStudioRecording()) {
        stopStudioRecording();
    }
    
    // Stop any playback
    if (activePlaybackAudio) {
        activePlaybackAudio.pause();
        activePlaybackAudio = null;
    }
    activePlaybackId = null;
    
    // Clear timers
    if (studioRecordingTimer) {
        clearInterval(studioRecordingTimer);
        studioRecordingTimer = null;
    }
    
    // Cleanup studio (also clears recordings library)
    cleanupStudio();
}

export {
    initStudioScreen,
    stopStudioScreen
};
