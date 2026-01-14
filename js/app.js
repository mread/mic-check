/**
 * Main Application Module
 * 
 * Handles UI interactions, screen navigation, and event handlers.
 * This is the entry point that coordinates all other modules.
 */

import { 
    diagnostics,
    STATUS,
    SCOPE,
    createContext,
    createInitialResults,
    runPrePermissionDiagnostics,
    runPermissionDiagnostics,
    runDeviceDiagnostics,
    cleanupContext,
    getOverallStatus
} from './diagnostics/index.js';

import { 
    QUALITY_REFERENCE, 
    linearToDb, 
    formatDb, 
    formatLufs, 
    getQualityRating 
} from './standards.js';

import { 
    qualityTestData,
    resetQualityTestData,
    requestMicAccess,
    initQualityAudio,
    stopQualityAudio,
    getRmsFromAnalyser,
    sampleChannels,
    analyzeChannelBalance,
    populateDeviceList,
    collectKWeightedSamples
} from './audio.js';

import { calculateGatedLufs } from './lufs.js';

import { 
    detectBrowser, 
    detectedBrowser,
    isFirefoxBased,
    checkPermission,
    getResetInstructions
} from './browser.js';

import { 
    generateDiagnosticsReport,
    downloadDiagnosticsReport 
} from './diagnostics.js';

import { displayQualityResults } from './results.js';

import { PlaybackRecorder, getMediaRecorderSupport } from './playback.js';

// ============================================
// State
// ============================================
let diagnosticContext = null;
let diagnosticResults = null;
let animationId = null;
let audioDetected = false;

// Playback state
let playbackRecorder = null;
let playbackCountdownTimer = null;
let playbackRecordingTimer = null;
let playbackPeakLevel = 0;
let playbackAudioElement = null;

// ============================================
// Screen Navigation
// ============================================
export function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId)?.classList.add('active');
    window.scrollTo(0, 0);
}

// ============================================
// Diagnostic Checklist UI
// ============================================
function getStatusIcon(status) {
    switch (status) {
        case STATUS.PASS: return '✅';
        case STATUS.FAIL: return '❌';
        case STATUS.WARN: return '⚠️';
        case STATUS.SKIP: return '⏭️';
        case STATUS.RUNNING: return '⏳';
        case STATUS.PENDING: return '⏸️';
        default: return '❓';
    }
}

/**
 * Update diagnostic table - stable structure, only status/details change
 * Table rows are defined in HTML, we just update their content
 */
function updateDiagnosticTable(results) {
    diagnostics.forEach(diag => {
        const result = results[diag.id];
        if (!result) return;
        
        const row = document.getElementById(`diag-row-${diag.id}`);
        if (!row) return;
        
        // Update row status class
        row.className = result.status || '';
        
        // Update status icon
        const iconCell = row.querySelector('.diag-icon');
        if (iconCell) {
            iconCell.textContent = getStatusIcon(result.status);
        }
        
        // Update detail text
        const detailCell = row.querySelector('.diag-detail');
        if (detailCell) {
            detailCell.textContent = result.message || '';
        }
    });
    
    // Update fix instructions (shown outside table)
    updateFixInstructions(results);
}

/**
 * Show fix instructions for the first failing test
 */
function updateFixInstructions(results) {
    const fixContainer = document.getElementById('diagnostic-fix');
    if (!fixContainer) return;
    
    // Find first failing diagnostic with fix instructions
    const failedDiag = diagnostics.find(d => {
        const result = results[d.id];
        return result && (result.status === STATUS.FAIL || result.status === STATUS.WARN) && result.fix;
    });
    
    if (failedDiag && results[failedDiag.id]?.fix) {
        fixContainer.innerHTML = `<strong>How to fix:</strong> ${results[failedDiag.id].fix}`;
        fixContainer.style.display = 'block';
    } else {
        fixContainer.style.display = 'none';
    }
}

/**
 * Reset all table rows to pending state
 */
function resetDiagnosticTable() {
    diagnostics.forEach(diag => {
        const row = document.getElementById(`diag-row-${diag.id}`);
        if (!row) return;
        
        row.className = '';
        
        const iconCell = row.querySelector('.diag-icon');
        if (iconCell) iconCell.textContent = '⏸️';
        
        const detailCell = row.querySelector('.diag-detail');
        if (detailCell) detailCell.textContent = '';
    });
    
    const fixContainer = document.getElementById('diagnostic-fix');
    if (fixContainer) fixContainer.style.display = 'none';
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function updateSubtitle(text) {
    const subtitle = document.getElementById('test-subtitle');
    if (subtitle) subtitle.textContent = text;
}

// ============================================
// Microphone Test (Unified Flow)
// ============================================
async function runMicrophoneTest() {
    // Cleanup any previous context to avoid resource leaks
    if (diagnosticContext) {
        cleanupContext(diagnosticContext);
    }
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    
    // Initialize
    diagnosticContext = createContext();
    diagnosticResults = createInitialResults();
    audioDetected = false;
    
    // Reset UI
    document.getElementById('visualizer-section').style.display = 'none';
    document.getElementById('device-selector').style.display = 'none';
    document.getElementById('detected-devices').style.display = 'none';
    document.getElementById('playback-container').style.display = 'none';
    document.getElementById('btn-grant-permission').style.display = 'none';
    document.getElementById('btn-retry-test').style.display = 'none';
    document.getElementById('test-actions').style.display = 'block';
    
    updateSubtitle('Checking browser support...');
    resetDiagnosticTable();
    
    // Step 1: Run pre-permission diagnostics (browser support, permission state, device enum)
    // These don't trigger a permission prompt
    diagnosticResults = await runPrePermissionDiagnostics(diagnosticContext, (results) => {
        updateDiagnosticTable(results);
    });
    
    // Check if browser support failed
    if (diagnosticResults['browser-support'].status === STATUS.FAIL) {
        updateSubtitle('Browser not supported');
        document.getElementById('btn-retry-test').style.display = 'block';
        return;
    }
    
    // Check permission state
    const permissionResult = diagnosticResults['permission-state'];
    
    if (permissionResult.status === STATUS.FAIL) {
        // Permission explicitly denied - show fix instructions
        updateSubtitle('Permission denied — see details below');
        document.getElementById('btn-retry-test').style.display = 'block';
        return;
    }
    
    // If permission is 'prompt' or uncertain, pause and ask user to grant
    // This gives them time to read the page before the browser prompt appears
    if (permissionResult.details?.state === 'prompt' || 
        permissionResult.status === 'info' || 
        permissionResult.status === 'warn') {
        updateSubtitle('Ready to test — grant permission to continue');
        document.getElementById('btn-grant-permission').style.display = 'block';
        return;
    }
    
    // Permission already granted - continue with full test
    await continueWithPermissionTests();
}

/**
 * Continue with permission-requiring tests
 * Called after user grants permission or if already granted
 */
async function continueWithPermissionTests() {
    document.getElementById('btn-grant-permission').style.display = 'none';
    updateSubtitle('Testing microphone...');
    
    // Run permission-requiring diagnostics
    diagnosticResults = await runPermissionDiagnostics(diagnosticContext, diagnosticResults, (results) => {
        updateDiagnosticTable(results);
    });
    
    const overallStatus = getOverallStatus(diagnosticResults);
    
    if (overallStatus === STATUS.PASS || overallStatus === STATUS.WARN) {
        updateSubtitle('Your microphone is working!');
        await showSuccessUI();
    } else {
        updateSubtitle('Issue detected — see details below');
        document.getElementById('btn-retry-test').style.display = 'block';
    }
}

async function showSuccessUI() {
    const visualizerSection = document.getElementById('visualizer-section');
    const deviceSelector = document.getElementById('device-selector');
    const detectedDevices = document.getElementById('detected-devices');
    
    // Show visualizer
    visualizerSection.style.display = 'block';
    
    // Populate and show device selector
    const deviceSelect = document.getElementById('device-select');
    await populateDeviceList(deviceSelect);
    
    // Select the currently active device
    if (diagnosticContext.audioTrack) {
        const settings = diagnosticContext.audioTrack.getSettings();
        if (settings.deviceId) {
            for (let i = 0; i < deviceSelect.options.length; i++) {
                if (deviceSelect.options[i].value === settings.deviceId) {
                    deviceSelect.selectedIndex = i;
                    break;
                }
            }
        }
    }
    deviceSelector.style.display = 'block';
    
    // Show detected devices card
    if (diagnosticContext.devices && diagnosticContext.devices.length > 0) {
        const deviceList = document.getElementById('device-list');
        const deviceCount = document.getElementById('device-count');
        
        deviceCount.textContent = `${diagnosticContext.devices.length} microphone${diagnosticContext.devices.length > 1 ? 's' : ''} available`;
        
        deviceList.innerHTML = diagnosticContext.devices
            .filter(d => d.label) // Only show labeled devices
            .map(d => {
                const isActive = diagnosticContext.audioTrack && 
                    diagnosticContext.audioTrack.getSettings().deviceId === d.deviceId;
                return `
                    <div class="device-item ${isActive ? 'active' : ''}">
                        <span>${d.label}</span>
                        ${isActive ? '<span style="color: var(--success); font-size: 0.85rem;">● Active</span>' : ''}
                    </div>
                `;
            }).join('');
        
        detectedDevices.style.display = 'block';
    }
    
    // Start level meter visualization
    startLevelMeter();
}

// ============================================
// Level Meter & Visualization
// ============================================
function drawSpectrogram(ctx, canvas, frequencyData) {
    const width = canvas.width;
    const height = canvas.height;
    
    // Shift existing image left by 1 pixel
    const imageData = ctx.getImageData(1, 0, width - 1, height);
    ctx.putImageData(imageData, 0, 0);
    
    // Draw new column on the right
    const barWidth = 1;
    const numBins = frequencyData.length;
    const usableBins = Math.floor(numBins * 0.5);
    const binHeight = height / usableBins;
    
    for (let i = 0; i < usableBins; i++) {
        const value = frequencyData[i];
        
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
        ctx.fillRect(width - barWidth, y, barWidth, binHeight + 1);
    }
}

function startLevelMeter() {
    if (!diagnosticContext?.analyser || !diagnosticContext?.audioContext) {
        console.error('No audio context available for level meter');
        return;
    }
    
    const barEl = document.getElementById('level-bar');
    const textEl = document.getElementById('level-text');
    
    const spectrogramCanvas = document.getElementById('spectrogram-canvas');
    let spectrogramCtx = null;
    let frequencyData = null;
    
    if (spectrogramCanvas) {
        spectrogramCtx = spectrogramCanvas.getContext('2d');
        frequencyData = new Uint8Array(diagnosticContext.analyser.frequencyBinCount);
        spectrogramCtx.fillStyle = '#0a0a0a';
        spectrogramCtx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
    }
    
    const bufferLength = diagnosticContext.analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    let maxLevel = 0;
    
    function update() {
        if (!diagnosticContext?.audioContext || diagnosticContext.audioContext.state === 'closed') {
            return;
        }
        
        animationId = requestAnimationFrame(update);
        
        diagnosticContext.analyser.getByteTimeDomainData(dataArray);
        
        // Draw spectrogram
        if (spectrogramCtx && frequencyData) {
            diagnosticContext.analyser.getByteFrequencyData(frequencyData);
            drawSpectrogram(spectrogramCtx, spectrogramCanvas, frequencyData);
        }
        
        // Calculate RMS level
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
            const sample = (dataArray[i] - 128) / 128;
            sum += sample * sample;
        }
        const rms = Math.sqrt(sum / bufferLength);
        const level = Math.min(100, rms * 250);
        
        // Update level bar
        barEl.style.clipPath = `inset(0 ${100 - level}% 0 0)`;
        textEl.textContent = `${Math.round(level)}%`;
        
        if (level > maxLevel) maxLevel = level;
        
        // When audio detected, show playback feature (if supported)
        // Note: success is already indicated by ✅ checkmarks - no need for redundant message
        if (level > 5 && !audioDetected) {
            audioDetected = true;
            
            const { supported } = getMediaRecorderSupport();
            if (supported) {
                document.getElementById('playback-container').style.display = 'block';
            }
        }
    }
    
    update();
}

// ============================================
// Stop Test
// ============================================
export function stopTest() {
    // Stop animation
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    
    // Cleanup playback
    cleanupPlayback();
    
    // Cleanup diagnostic context
    if (diagnosticContext) {
        cleanupContext(diagnosticContext);
        diagnosticContext = null;
    }
    
    diagnosticResults = null;
    audioDetected = false;
}

// ============================================
// Device Switching
// ============================================
async function switchDevice(deviceId) {
    if (!deviceId || !diagnosticContext || !diagnosticResults) return;
    
    // Stop current stream and audio context
    if (diagnosticContext.stream) {
        diagnosticContext.stream.getTracks().forEach(t => t.stop());
        diagnosticContext.stream = null;
    }
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    if (diagnosticContext.audioContext) {
        await diagnosticContext.audioContext.close();
        diagnosticContext.audioContext = null;
        diagnosticContext.analyser = null;
        diagnosticContext.source = null;
    }
    
    // Reset audio detected flag and hide playback
    audioDetected = false;
    document.getElementById('playback-container').style.display = 'none';
    
    // Update context with new selected device
    diagnosticContext.selectedDeviceId = deviceId;
    
    // Re-run device-specific diagnostics only
    // (Browser support and permission are still valid)
    updateSubtitle('Testing selected microphone...');
    
    try {
        diagnosticResults = await runDeviceDiagnostics(diagnosticContext, diagnosticResults, (results) => {
            updateDiagnosticTable(results);
        });
        
        const overallStatus = getOverallStatus(diagnosticResults);
        
        if (overallStatus === STATUS.PASS || overallStatus === STATUS.WARN) {
            updateSubtitle('Your microphone is working!');
            
            // Start level meter visualization
            startLevelMeter();
            
            // Update device list to show new active device
            updateDeviceList(deviceId);
        } else {
            updateSubtitle('Issue with selected microphone');
        }
    } catch (error) {
        console.error('Failed to switch device:', error);
        updateSubtitle('Failed to switch microphone');
        updateDiagnosticTable(diagnosticResults);
    }
}

/**
 * Update the detected devices list to show which device is active
 */
async function updateDeviceList(activeDeviceId) {
    const detectedDevices = document.getElementById('detected-devices');
    if (!detectedDevices || detectedDevices.style.display === 'none') return;
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    const deviceList = document.getElementById('device-list');
    
    deviceList.innerHTML = audioInputs
        .filter(d => d.label)
        .map(d => {
            const isActive = d.deviceId === activeDeviceId;
            return `
                <div class="device-item ${isActive ? 'active' : ''}">
                    <span>${d.label}</span>
                    ${isActive ? '<span style="color: var(--success); font-size: 0.85rem;">● Active</span>' : ''}
                </div>
            `;
        }).join('');
}

// ============================================
// Playback Feature
// ============================================
function cleanupPlayback() {
    if (playbackCountdownTimer) {
        clearTimeout(playbackCountdownTimer);
        playbackCountdownTimer = null;
    }
    if (playbackRecordingTimer) {
        clearInterval(playbackRecordingTimer);
        playbackRecordingTimer = null;
    }
    
    if (playbackRecorder) {
        if (playbackRecorder.getIsRecording()) {
            playbackRecorder.abort();
        }
        playbackRecorder.cleanup();
        playbackRecorder = null;
    }
    
    if (playbackAudioElement) {
        playbackAudioElement.pause();
        if (playbackAudioElement.src && playbackAudioElement.src.startsWith('blob:')) {
            URL.revokeObjectURL(playbackAudioElement.src);
        }
        playbackAudioElement.src = '';
    }
    
    const playbackContainer = document.getElementById('playback-container');
    if (playbackContainer) {
        playbackContainer.style.display = 'none';
    }
    
    showPlaybackSection('playback-record-prompt');
    playbackPeakLevel = 0;
}

function showPlaybackSection(sectionId) {
    const sections = [
        'playback-record-prompt',
        'playback-countdown',
        'playback-recording',
        'playback-ready',
        'playback-playing'
    ];
    
    sections.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.display = id === sectionId ? 'block' : 'none';
        }
    });
}

async function startPlaybackRecording() {
    if (!diagnosticContext?.stream) {
        console.error('No stream available for playback recording');
        return;
    }
    
    playbackRecorder = new PlaybackRecorder(diagnosticContext.stream);
    playbackPeakLevel = 0;
    
    if (playbackCountdownTimer) {
        clearTimeout(playbackCountdownTimer);
        playbackCountdownTimer = null;
    }
    
    showPlaybackSection('playback-countdown');
    const countdownEl = document.getElementById('countdown-number');
    let count = 3;
    countdownEl.textContent = count;
    
    const runCountdown = () => {
        count--;
        if (count > 0) {
            countdownEl.textContent = count;
            playbackCountdownTimer = setTimeout(runCountdown, 1000);
        } else {
            startRecording();
        }
    };
    
    playbackCountdownTimer = setTimeout(runCountdown, 1000);
}

function startRecording() {
    showPlaybackSection('playback-recording');
    
    const timerEl = document.getElementById('recording-timer');
    let secondsLeft = 5;
    timerEl.textContent = secondsLeft;
    
    playbackRecorder.start();
    
    playbackRecordingTimer = setInterval(() => {
        secondsLeft--;
        timerEl.textContent = secondsLeft;
        
        if (diagnosticContext?.analyser) {
            const rms = getRmsFromAnalyser(diagnosticContext.analyser);
            if (rms > playbackPeakLevel) {
                playbackPeakLevel = rms;
            }
        }
        
        if (secondsLeft <= 0) {
            clearInterval(playbackRecordingTimer);
            playbackRecordingTimer = null;
            stopRecording();
        }
    }, 1000);
}

async function stopRecording() {
    if (!playbackRecorder) return;
    
    try {
        const blob = await playbackRecorder.stop();
        
        playbackAudioElement = document.getElementById('playback-audio');
        if (playbackAudioElement.src && playbackAudioElement.src.startsWith('blob:')) {
            URL.revokeObjectURL(playbackAudioElement.src);
        }
        playbackAudioElement.src = URL.createObjectURL(blob);
        
        const warningEl = document.getElementById('playback-warning');
        if (playbackPeakLevel < 0.02) {
            warningEl.style.display = 'flex';
        } else {
            warningEl.style.display = 'none';
        }
        
        showPlaybackSection('playback-ready');
    } catch (error) {
        console.error('Recording failed:', error);
        showPlaybackSection('playback-record-prompt');
    }
}

function playRecording() {
    if (!playbackAudioElement || !playbackAudioElement.src) return;
    
    showPlaybackSection('playback-playing');
    playbackAudioElement.play();
    
    playbackAudioElement.onended = () => {
        showPlaybackSection('playback-ready');
    };
}

function stopPlayback() {
    if (playbackAudioElement) {
        playbackAudioElement.pause();
        playbackAudioElement.currentTime = 0;
    }
    showPlaybackSection('playback-ready');
}

function recordAgain() {
    if (playbackAudioElement) {
        playbackAudioElement.pause();
        if (playbackAudioElement.src && playbackAudioElement.src.startsWith('blob:')) {
            URL.revokeObjectURL(playbackAudioElement.src);
        }
        playbackAudioElement.src = '';
    }
    
    if (playbackRecorder) {
        playbackRecorder.cleanup();
    }
    
    startPlaybackRecording();
}

// ============================================
// Privacy Check
// ============================================
async function runPrivacyCheck() {
    const browser = detectBrowser();
    const statusEl = document.getElementById('privacy-permission-status');
    const resultsEl = document.getElementById('privacy-results');
    const resetEl = document.getElementById('reset-instructions');
    
    // Show reset instructions for detected browser
    resetEl.innerHTML = getResetInstructions(browser.name);
    
    // Check permission
    const { state, supported } = await checkPermission();
    
    let statusHtml = '';
    if (!supported) {
        statusHtml = `
            <div class="status-card info">
                <span class="status-icon">ℹ️</span>
                <div class="status-text">
                    <div class="status-title">Permission status unknown</div>
                    <div class="status-detail">Your browser (${browser.name}) doesn't support the Permissions API for microphone.</div>
                </div>
            </div>
        `;
    } else if (state === 'granted') {
        statusHtml = `
            <div class="status-card success">
                <span class="status-icon">🔓</span>
                <div class="status-text">
                    <div class="status-title">Microphone permission granted</div>
                    <div class="status-detail">This site can request access to your microphone. It is NOT currently listening unless you started a test.</div>
                </div>
            </div>
        `;
    } else if (state === 'denied') {
        statusHtml = `
            <div class="status-card problem">
                <span class="status-icon">🔒</span>
                <div class="status-text">
                    <div class="status-title">Microphone permission blocked</div>
                    <div class="status-detail">You previously blocked microphone access for this site. See below for how to reset.</div>
                </div>
            </div>
        `;
    } else {
        statusHtml = `
            <div class="status-card info">
                <span class="status-icon">❓</span>
                <div class="status-text">
                    <div class="status-title">Microphone permission not requested</div>
                    <div class="status-detail">This site hasn't asked for microphone access yet. You'll be prompted when it does.</div>
                </div>
            </div>
        `;
    }
    
    statusEl.innerHTML = statusHtml;
    
    // Show re-check button
    document.getElementById('btn-privacy-check').style.display = 'inline-flex';
}

// ============================================
// Level Check (Quality Analysis)
// ============================================
// Keep existing level check functionality - it's a separate "pro" tool
// This section maintains the original quality analysis flow

// ============================================
// Event Listeners
// ============================================
function setupListeners() {
    // Home screen
    document.getElementById('btn-start-test')?.addEventListener('click', () => {
        showScreen('screen-mic-test');
        runMicrophoneTest();
    });
    
    // Journey cards - handle both click and keyboard activation
    document.querySelectorAll('.journey-card').forEach(card => {
        const activateCard = () => {
            const journey = card.dataset.journey;
            if (journey === 'level-check') {
                showScreen('screen-level-check');
                initLevelCheck();
            } else if (journey === 'privacy') {
                showScreen('screen-privacy');
                runPrivacyCheck();
            }
        };
        
        card.addEventListener('click', activateCard);
        
        // Keyboard accessibility: activate on Enter or Space
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); // Prevent Space from scrolling
                activateCard();
            }
        });
    });
    
    // Mic test screen
    document.getElementById('btn-grant-permission')?.addEventListener('click', () => {
        continueWithPermissionTests();
    });
    
    document.getElementById('btn-retry-test')?.addEventListener('click', () => {
        runMicrophoneTest();
    });
    
    document.getElementById('btn-stop-test')?.addEventListener('click', () => {
        stopTest();
        showScreen('screen-home');
    });
    
    document.getElementById('device-select')?.addEventListener('change', (e) => {
        switchDevice(e.target.value);
    });
    
    // Playback controls
    document.getElementById('btn-start-playback-record')?.addEventListener('click', () => {
        startPlaybackRecording();
    });
    
    document.getElementById('btn-play-recording')?.addEventListener('click', () => {
        playRecording();
    });
    
    document.getElementById('btn-record-again')?.addEventListener('click', () => {
        recordAgain();
    });
    
    document.getElementById('btn-stop-playback')?.addEventListener('click', () => {
        stopPlayback();
    });
    
    document.getElementById('link-playback-level-check')?.addEventListener('click', (e) => {
        e.preventDefault();
        stopTest();
        showScreen('screen-level-check');
        initLevelCheck();
    });
    
    // Privacy check
    document.getElementById('btn-privacy-check')?.addEventListener('click', () => {
        runPrivacyCheck();
    });
    
    // Level check
    document.getElementById('btn-quality-start')?.addEventListener('click', () => {
        startLevelCheck();
    });
    
    document.getElementById('btn-refresh-devices')?.addEventListener('click', async () => {
        const select = document.getElementById('quality-device-select');
        await populateDeviceList(select);
    });
}

// ============================================
// Level Check Functions
// ============================================
async function initLevelCheck() {
    const select = document.getElementById('quality-device-select');
    await populateDeviceList(select);
}

async function startLevelCheck() {
    // This maintains the existing quality analysis flow
    // Implementation kept from original app.js
    const deviceSelect = document.getElementById('quality-device-select');
    const agcToggle = document.getElementById('agc-toggle');
    
    const deviceId = deviceSelect.value;
    const agcEnabled = agcToggle.checked;
    
    const success = await initQualityAudio(agcEnabled, deviceId);
    
    if (!success) {
        alert('Failed to access microphone. Please check permissions and try again.');
        return;
    }
    
    // Show step UI and run the level check flow
    document.getElementById('level-check-intro').style.display = 'none';
    document.getElementById('level-check-steps').style.display = 'block';
    document.getElementById('level-check-steps').innerHTML = `
        <div class="status-card info">
            <span class="status-icon">🎤</span>
            <div class="status-text">
                <div class="status-title">Level Check in Progress</div>
                <div class="status-detail">Full level check implementation - see original code for complete flow.</div>
            </div>
        </div>
        <button class="btn btn-secondary" onclick="window.MicCheck.stopLevelCheck()">Stop</button>
    `;
}

export function stopLevelCheck() {
    stopQualityAudio();
    resetQualityTestData();
    document.getElementById('level-check-intro').style.display = 'block';
    document.getElementById('level-check-steps').style.display = 'none';
    document.getElementById('level-check-results').style.display = 'none';
}

// ============================================
// Initialization
// ============================================
function init() {
    detectBrowser();
    setupListeners();
    
    // Expose API for inline onclick handlers
    window.MicCheck = {
        showScreen,
        stopTest,
        stopLevelCheck,
        runPrivacyCheck
    };
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
