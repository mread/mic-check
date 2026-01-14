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
    sampleChannels,
    analyzeChannelBalance,
    populateDeviceList,
    collectKWeightedSamples,
    getRmsFromAnalyser
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

import {
    initMultiMeter,
    getDeduplicatedDevices,
    enableMonitoring,
    disableMonitoring,
    isMonitoring,
    getPrimaryDeviceId,
    setPrimaryDevice,
    findDefaultDeviceId,
    cleanupAllMonitoring,
    getStream,
    getAnalyser
} from './multi-device-meter.js';

import {
    initMonitor,
    startVisualization,
    cleanupMonitor,
    populateMonitorDeviceDropdown,
    getMonitorStream,
    getMonitorAnalyser
} from './monitor.js';

import { escapeHtml, getRmsFromAnalyser as getRmsUtil } from './utils.js';

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

// Monitor state (for passing device between screens)
let selectedMonitorDeviceId = null;

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
 * Fix instructions and actions are shown INLINE within each row
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
        
        // Update inline action/fix area
        const actionCell = row.querySelector('.diag-action');
        if (actionCell) {
            updateRowAction(diag.id, result, actionCell);
        }
    });
}

/**
 * Update inline action/fix for a specific row
 */
function updateRowAction(diagId, result, actionCell) {
    // Permission button goes inline in permission-state row
    if (diagId === 'permission-state' && result.status === STATUS.PENDING) {
        actionCell.innerHTML = `
            <button class="btn btn-primary btn-small" onclick="window.MicCheck.continueWithPermissionTests()">
                🔓 Request Audio Access
            </button>
            <div class="diag-action-hint">Your browser will ask you to allow access.</div>
        `;
        actionCell.style.display = 'block';
        return;
    }
    
    // Fix instructions go inline for failed/warn tests
    if ((result.status === STATUS.FAIL || result.status === STATUS.WARN) && result.fix) {
        actionCell.innerHTML = `<strong>How to fix:</strong> ${result.fix}`;
        actionCell.style.display = 'block';
        return;
    }
    
    // Otherwise hide action area
    actionCell.style.display = 'none';
    actionCell.innerHTML = '';
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
        
        const actionCell = row.querySelector('.diag-action');
        if (actionCell) {
            actionCell.style.display = 'none';
            actionCell.innerHTML = '';
        }
    });
}


function updateSubtitle(text) {
    const subtitle = document.getElementById('test-subtitle');
    if (subtitle) subtitle.textContent = text;
}

// ============================================
// Multi-Mic Monitor Panel
// ============================================

/**
 * Reset mic monitor panel to placeholder state
 */
function resetMicMonitorPanel() {
    const list = document.getElementById('mic-monitor-list');
    const badge = document.getElementById('device-count-badge');
    
    if (list) {
        list.innerHTML = `
            <div class="mic-monitor-row placeholder">
                <span class="device-icon">⏳</span>
                <span class="device-label">Detecting microphones...</span>
            </div>
        `;
    }
    if (badge) {
        badge.textContent = 'Checking...';
    }
}

/**
 * Populate mic monitor panel with toggle switches and level meters
 * @param {Array} devices - Deduplicated device array from multi-device-meter
 * @param {string} primaryDeviceId - The primary device for diagnostics
 */
function populateMicMonitorPanel(devices, primaryDeviceId) {
    const list = document.getElementById('mic-monitor-list');
    const badge = document.getElementById('device-count-badge');
    
    if (!list) return;
    
    if (devices.length === 0) {
        list.innerHTML = `
            <div class="mic-monitor-row placeholder">
                <span class="device-icon">❓</span>
                <span class="device-label">No microphones detected</span>
            </div>
        `;
        if (badge) badge.textContent = 'None found';
        return;
    }
    
    // Update count badge
    if (badge) {
        badge.textContent = `${devices.length} found`;
    }
    
    // Build device list HTML with toggles and level meters
    list.innerHTML = devices.map(device => {
        const isPrimary = device.deviceId === primaryDeviceId;
        const monitoring = isMonitoring(device.deviceId);
        
        // Determine icon
        let icon = '🎤';
        if (device.isDefault) icon = '🔊';
        if (device.isCommunications) icon = '📞';
        
        // Build aliases badge
        let aliasHtml = '';
        if (device.aliases && device.aliases.length > 0) {
            // Escape aliases to prevent XSS
            const escapedAliases = device.aliases.map(a => escapeHtml(a)).join(', ');
            aliasHtml = `<span class="device-aliases">(${escapedAliases})</span>`;
        }
        
        const rowClasses = [
            'mic-monitor-row',
            monitoring ? 'monitoring' : '',
            isPrimary ? 'primary' : ''
        ].filter(Boolean).join(' ');
        
        return `
            <div class="${rowClasses}" data-device-id="${escapeHtml(device.deviceId)}">
                <label class="toggle-switch mic-monitor-toggle">
                    <input type="checkbox" class="mic-monitor-checkbox"
                           ${monitoring ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
                <span class="device-icon">${icon}</span>
                <span class="mic-monitor-label">
                    ${escapeHtml(device.label)}${aliasHtml}
                </span>
                <div class="mic-level-meter ${monitoring ? '' : 'inactive'}" data-device-id="${escapeHtml(device.deviceId)}">
                    <div class="mic-level-meter-fill"></div>
                    <span class="mic-level-meter-text">${monitoring ? '0%' : '--'}</span>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Update level meter for a specific device
 * @param {string} deviceId 
 * @param {number} level - 0-100 
 */
function updateDeviceLevelMeter(deviceId, level) {
    const meter = document.querySelector(`.mic-level-meter[data-device-id="${CSS.escape(deviceId)}"]`);
    if (!meter) return;
    
    const fill = meter.querySelector('.mic-level-meter-fill');
    const text = meter.querySelector('.mic-level-meter-text');
    
    if (fill) {
        fill.style.clipPath = `inset(0 ${100 - level}% 0 0)`;
    }
    if (text) {
        text.textContent = `${Math.round(level)}%`;
    }
    
    // Track audio detection on primary device (for diagnostics)
    if (deviceId === getPrimaryDeviceId() && level > 5 && !audioDetected) {
        audioDetected = true;
    }
}

/**
 * Toggle monitoring for a device
 * Called from toggle switch onclick
 */
async function toggleMonitoring(deviceId, enabled) {
    const row = document.querySelector(`.mic-monitor-row[data-device-id="${CSS.escape(deviceId)}"]`);
    const meter = document.querySelector(`.mic-level-meter[data-device-id="${CSS.escape(deviceId)}"]`);
    
    if (enabled) {
        const result = await enableMonitoring(deviceId);
        if (result.success) {
            row?.classList.add('monitoring');
            meter?.classList.remove('inactive');
            
            // If no primary set, make this the primary
            if (!getPrimaryDeviceId()) {
                setPrimaryDevice(deviceId);
                row?.classList.add('primary');
                // Re-run diagnostics for new primary
                await runDiagnosticsForDevice(deviceId);
            }
        } else {
            // Failed to enable - revert checkbox and show error with What/Why/How
            const checkbox = row?.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = false;
            row?.classList.add('error');
            
            // Show detailed error message inline (Principle #6: What/Why/How)
            const meterText = meter?.querySelector('.mic-level-meter-text');
            if (meterText) {
                // Determine user-friendly error message
                if (result.error === 'Device is busy or unavailable') {
                    meterText.textContent = 'In use';
                    meterText.dataset.tooltip = 'This microphone may be in use by another application. Try closing other apps that use the mic.';
                } else {
                    meterText.textContent = 'Failed';
                    meterText.dataset.tooltip = result.error || 'Could not access this microphone';
                }
            }
            
            // Remove error state after 5 seconds to allow retry
            setTimeout(() => {
                row?.classList.remove('error');
                if (meterText) {
                    meterText.textContent = '--';
                    delete meterText.dataset.tooltip;
                }
            }, 5000);
        }
    } else {
        disableMonitoring(deviceId);
        row?.classList.remove('monitoring', 'primary');
        meter?.classList.add('inactive');
        const meterText = meter?.querySelector('.mic-level-meter-text');
        if (meterText) meterText.textContent = '--';
        const meterFill = meter?.querySelector('.mic-level-meter-fill');
        if (meterFill) meterFill.style.clipPath = 'inset(0 100% 0 0)';
        
        // If this was the primary, pick a new one
        if (getPrimaryDeviceId() === deviceId) {
            const monitoredIds = Array.from(document.querySelectorAll('.mic-monitor-row.monitoring'))
                .map(r => r.dataset.deviceId);
            if (monitoredIds.length > 0) {
                setPrimaryDevice(monitoredIds[0]);
                document.querySelector(`.mic-monitor-row[data-device-id="${CSS.escape(monitoredIds[0])}"]`)?.classList.add('primary');
                await runDiagnosticsForDevice(monitoredIds[0]);
            }
        }
    }
}

/**
 * Run diagnostics for a specific device (when it becomes primary)
 */
async function runDiagnosticsForDevice(deviceId) {
    if (!diagnosticContext || !diagnosticResults) return;
    
    // Update context with the stream from multi-meter
    diagnosticContext.stream = getStream(deviceId);
    diagnosticContext.analyser = getAnalyser(deviceId);
    diagnosticContext.selectedDeviceId = deviceId;
    
    if (diagnosticContext.stream) {
        diagnosticContext.audioTrack = diagnosticContext.stream.getAudioTracks()[0];
    }
    
    updateSubtitle('Testing selected microphone...');
    
    try {
        diagnosticResults = await runDeviceDiagnostics(diagnosticContext, diagnosticResults, (results) => {
            updateDiagnosticTable(results);
        });
        
        const overallStatus = getOverallStatus(diagnosticResults);
        
        if (overallStatus === STATUS.PASS || overallStatus === STATUS.WARN) {
            updateSubtitle('Your microphone is working!');
        } else {
            updateSubtitle('Issue with selected microphone');
        }
    } catch (error) {
        console.error('Failed to run diagnostics:', error);
        updateSubtitle('Diagnostics failed');
    }
}

// ============================================
// Microphone Test (Unified Flow)
// ============================================
async function runMicrophoneTest() {
    // Cleanup any previous context to avoid resource leaks
    if (diagnosticContext) {
        cleanupContext(diagnosticContext);
    }
    cleanupAllMonitoring();
    
    // Initialize
    diagnosticContext = createContext();
    diagnosticResults = createInitialResults();
    audioDetected = false;
    
    // Reset UI
    document.getElementById('visualizer-section').style.display = 'none';
    const detectedDevices = document.getElementById('detected-devices');
    if (detectedDevices) detectedDevices.style.display = 'none';
    document.getElementById('btn-retry-test').style.display = 'none';
    document.getElementById('test-actions').style.display = 'block';
    
    // Reset mic monitor panel to placeholder state
    resetMicMonitorPanel();
    
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
    // The inline "Request Audio Access" button is shown by updateRowAction()
    // 
    // EXCEPTION: Firefox's Permissions API is unreliable - it often returns 'prompt'
    // even when permission was previously granted. For Firefox, we proceed directly
    // with getUserMedia (which will silently succeed if already granted, or show
    // the browser dialog if truly needed).
    const shouldPauseForPermission = (
        permissionResult.details?.state === 'prompt' || 
        permissionResult.status === STATUS.PENDING || 
        permissionResult.status === STATUS.WARN
    ) && !isFirefoxBased(); // Firefox: skip pause, just try getUserMedia
    
    if (shouldPauseForPermission) {
        updateSubtitle('See permission status below');
        return; // Pause - user will click inline button
    }
    
    // Permission already granted - continue with full test
    await continueWithPermissionTests();
}

/**
 * Continue with permission-requiring tests
 * Called after user grants permission or if already granted
 */
async function continueWithPermissionTests() {
    updateSubtitle('Testing audio devices...');
    
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
    
    // Show visualizer section (contains Monitor link and playback)
    visualizerSection.style.display = 'block';
    
    // Hide the old detected devices card
    const detectedDevices = document.getElementById('detected-devices');
    if (detectedDevices) {
        detectedDevices.style.display = 'none';
    }
    
    // Initialize multi-device meter system
    const deduplicatedDevices = initMultiMeter(diagnosticContext.devices, updateDeviceLevelMeter);
    
    // Find and enable the default device
    const defaultDeviceId = findDefaultDeviceId() || 
        (deduplicatedDevices.length > 0 ? deduplicatedDevices[0].deviceId : null);
    
    if (defaultDeviceId) {
        setPrimaryDevice(defaultDeviceId);
        await enableMonitoring(defaultDeviceId);
        
        // Store for monitor screen handoff
        selectedMonitorDeviceId = defaultDeviceId;
    }
    
    // Populate the mic monitor panel
    populateMicMonitorPanel(deduplicatedDevices, defaultDeviceId);
}

// ============================================
// Stop Test
// ============================================
export function stopTest() {
    // Cleanup all multi-device monitoring
    cleanupAllMonitoring();
    
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
// Monitor Screen
// ============================================

/**
 * Open the monitor screen with a specific device
 * @param {string} deviceId - Optional device ID to pre-select
 */
async function openMonitor(deviceId) {
    // Store the device ID for monitor screen
    selectedMonitorDeviceId = deviceId || getPrimaryDeviceId();
    
    // Stop mic test monitoring (monitor screen has its own stream)
    stopTest();
    
    // Show monitor screen
    showScreen('screen-monitor');
    
    // Initialize monitor
    await initMonitorScreen();
}

/**
 * Initialize the monitor screen
 */
async function initMonitorScreen() {
    const dropdown = document.getElementById('monitor-device-select');
    
    // Populate device dropdown
    await populateMonitorDeviceDropdown(dropdown, selectedMonitorDeviceId);
    
    // Get the device ID to use
    const deviceId = dropdown.value || selectedMonitorDeviceId;
    
    if (deviceId) {
        const result = await initMonitor(deviceId);
        if (result.success) {
            // Start visualization
            const spectrogramCanvas = document.getElementById('monitor-spectrogram-canvas');
            const levelBar = document.getElementById('monitor-level-bar');
            const levelText = document.getElementById('monitor-level-text');
            
            startVisualization(spectrogramCanvas, levelBar, levelText);
        } else {
            // Show error in level display
            const levelText = document.getElementById('monitor-level-text');
            if (levelText) {
                levelText.textContent = result.error || 'Failed to start';
            }
            console.warn('Failed to initialize monitor:', result.error);
        }
    }
}

/**
 * Stop the monitor and cleanup
 */
export function stopMonitor() {
    cleanupMonitor();
}

/**
 * Handle device change in monitor dropdown
 */
async function onMonitorDeviceChange(deviceId) {
    if (!deviceId) return;
    
    selectedMonitorDeviceId = deviceId;
    
    const result = await initMonitor(deviceId);
    if (result.success) {
        const spectrogramCanvas = document.getElementById('monitor-spectrogram-canvas');
        const levelBar = document.getElementById('monitor-level-bar');
        const levelText = document.getElementById('monitor-level-text');
        
        startVisualization(spectrogramCanvas, levelBar, levelText);
    } else {
        // Show error in level display
        const levelText = document.getElementById('monitor-level-text');
        if (levelText) {
            levelText.textContent = result.error || 'Failed to start';
        }
        console.warn('Failed to switch monitor device:', result.error);
    }
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
    
    // Reset to initial prompt state (container is always visible on Monitor screen)
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
    // Get stream from monitor (primary source) or fall back to diagnostic context
    const stream = getMonitorStream() || diagnosticContext?.stream;
    
    if (!stream) {
        console.error('No stream available for playback recording');
        return;
    }
    
    playbackRecorder = new PlaybackRecorder(stream);
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

async function startRecording() {
    showPlaybackSection('playback-recording');
    
    const timerEl = document.getElementById('recording-timer');
    let secondsLeft = 5;
    timerEl.textContent = secondsLeft;
    
    // Start the visual countdown timer
    playbackRecordingTimer = setInterval(() => {
        secondsLeft--;
        timerEl.textContent = Math.max(0, secondsLeft);
        
        // Track peak level using monitor stream or diagnostic context
        const analyser = getMonitorAnalyser();
        if (analyser) {
            const rms = getRmsUtil(analyser);
            if (rms > playbackPeakLevel) {
                playbackPeakLevel = rms;
            }
        }
        
        if (secondsLeft <= 0) {
            clearInterval(playbackRecordingTimer);
            playbackRecordingTimer = null;
        }
    }, 1000);
    
    // Start recording - this returns a Promise that resolves with blob URL after 5 seconds
    try {
        const blobUrl = await playbackRecorder.start(5000);
        
        // Recording complete - set up playback
        playbackAudioElement = document.getElementById('playback-audio');
        if (playbackAudioElement.src && playbackAudioElement.src.startsWith('blob:')) {
            URL.revokeObjectURL(playbackAudioElement.src);
        }
        playbackAudioElement.src = blobUrl;
        
        const warningEl = document.getElementById('playback-warning');
        if (playbackPeakLevel < 0.02) {
            warningEl.style.display = 'flex';
        } else {
            warningEl.style.display = 'none';
        }
        
        showPlaybackSection('playback-ready');
    } catch (error) {
        console.error('Recording failed:', error);
        if (playbackRecordingTimer) {
            clearInterval(playbackRecordingTimer);
            playbackRecordingTimer = null;
        }
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
            } else if (journey === 'monitor') {
                openMonitor();
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
    
    // Mic monitor panel - event delegation for toggle checkboxes
    // Uses delegation to avoid XSS from inline onclick handlers
    document.getElementById('mic-monitor-list')?.addEventListener('change', (e) => {
        if (e.target.classList.contains('mic-monitor-checkbox')) {
            const row = e.target.closest('.mic-monitor-row');
            const deviceId = row?.dataset.deviceId;
            if (deviceId) {
                toggleMonitoring(deviceId, e.target.checked);
            }
        }
    });
    
    // Note: window.MicCheck is set up in init() after all functions are defined
    
    document.getElementById('btn-retry-test')?.addEventListener('click', () => {
        runMicrophoneTest();
    });
    
    // Open Monitor link from mic test screen
    document.getElementById('link-open-monitor')?.addEventListener('click', (e) => {
        e.preventDefault();
        openMonitor(getPrimaryDeviceId());
    });
    
    // Monitor device dropdown change
    document.getElementById('monitor-device-select')?.addEventListener('change', (e) => {
        onMonitorDeviceChange(e.target.value);
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

let levelCheckAnimationId = null;

async function startLevelCheck() {
    const deviceSelect = document.getElementById('quality-device-select');
    const agcToggle = document.getElementById('agc-toggle');
    
    const deviceId = deviceSelect.value;
    const userAgcPreference = agcToggle.checked;
    
    // Store user's AGC preference for voice phase
    qualityTestData.userAgcPreference = userAgcPreference;
    qualityTestData.selectedDeviceId = deviceId;
    
    // Always measure noise floor with AGC OFF for accurate reading
    const success = await initQualityAudio(false, deviceId);
    
    if (!success) {
        alert('Failed to access microphone. Please check permissions and try again.');
        return;
    }
    
    // Show silence step
    document.getElementById('level-check-intro').style.display = 'none';
    document.getElementById('level-check-steps').style.display = 'block';
    document.getElementById('level-check-steps').innerHTML = renderSilenceStep();
    
    // Start silence measurement
    startSilenceMeasurement();
}

function renderSilenceStep() {
    return `
        <div class="level-check-step" id="silence-step">
            <div class="status-card info">
                <span class="status-icon">🤫</span>
                <div class="status-text">
                    <div class="status-title">Step 1: Measuring Background Noise</div>
                    <div class="status-detail">Stay quiet for 5 seconds...</div>
                </div>
            </div>
            
            <div class="level-meter-container" style="margin: 1.5rem 0;">
                <div class="level-bar-container">
                    <div id="silence-level-bar" class="level-bar"></div>
                    <span id="silence-level-text" class="level-text">--</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-top: 0.5rem;">
                    <span id="silence-db-reading" style="font-size: 0.85rem; color: var(--text-muted);">-- dB</span>
                    <span id="silence-countdown" style="font-size: 0.85rem; color: var(--text-muted);">5s</span>
                </div>
            </div>
            
            <div id="silence-result" style="display: none; margin-top: 1rem; padding: 1rem; background: var(--bg-muted); border-radius: 8px;">
                <strong>Noise Floor:</strong> <span id="silence-final-reading">--</span>
            </div>
            
            <div style="margin-top: 1rem;">
                <button id="btn-next-to-voice" class="btn btn-primary" style="display: none;" onclick="window.MicCheck.goToVoiceStep()">
                    Continue to Voice Test →
                </button>
                <button class="btn btn-secondary" onclick="window.MicCheck.stopLevelCheck()">Stop</button>
            </div>
        </div>
    `;
}

function startSilenceMeasurement() {
    qualityTestData.noiseFloorSamples = [];
    qualityTestData.isRunning = true;
    
    const duration = 5000;
    const startTime = Date.now();
    
    function measure() {
        if (!qualityTestData.isRunning) return;
        
        const elapsed = Date.now() - startTime;
        const rms = getRmsFromAnalyser(qualityTestData.analyser);
        const db = linearToDb(rms);
        
        qualityTestData.noiseFloorSamples.push(rms);
        
        const percent = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        const levelBar = document.getElementById('silence-level-bar');
        const levelText = document.getElementById('silence-level-text');
        const dbReading = document.getElementById('silence-db-reading');
        const countdown = document.getElementById('silence-countdown');
        
        if (levelBar) levelBar.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
        if (levelText) levelText.textContent = `${Math.round(percent)}%`;
        if (dbReading) dbReading.textContent = formatDb(db);
        
        const remaining = Math.ceil((duration - elapsed) / 1000);
        if (countdown) countdown.textContent = remaining > 0 ? `${remaining}s` : '';
        
        if (elapsed >= duration) {
            finishSilenceMeasurement();
        } else {
            levelCheckAnimationId = requestAnimationFrame(measure);
        }
    }
    
    measure();
}

function finishSilenceMeasurement() {
    // Calculate noise floor from quietest half of samples
    const sorted = [...qualityTestData.noiseFloorSamples].sort((a, b) => a - b);
    const quietHalf = sorted.slice(0, Math.floor(sorted.length / 2));
    const avgNoise = quietHalf.length > 0 ? quietHalf.reduce((a, b) => a + b, 0) / quietHalf.length : 0;
    qualityTestData.noiseFloorDb = linearToDb(avgNoise);
    
    const countdown = document.getElementById('silence-countdown');
    const result = document.getElementById('silence-result');
    const finalReading = document.getElementById('silence-final-reading');
    const nextBtn = document.getElementById('btn-next-to-voice');
    
    if (countdown) countdown.textContent = '✓ Complete';
    if (result) result.style.display = 'block';
    if (finalReading) finalReading.textContent = formatDb(qualityTestData.noiseFloorDb);
    if (nextBtn) nextBtn.style.display = 'inline-flex';
}

function goToVoiceStep() {
    document.getElementById('level-check-steps').innerHTML = renderVoiceStep();
}

function renderVoiceStep() {
    const agcText = qualityTestData.userAgcPreference ? 'AGC On' : 'AGC Off';
    return `
        <div class="level-check-step" id="voice-step">
            <div class="status-card info">
                <span class="status-icon">🗣️</span>
                <div class="status-text">
                    <div class="status-title">Step 2: Voice Recording</div>
                    <div class="status-detail">Speak normally for 12 seconds (${agcText})</div>
                </div>
            </div>
            
            <div id="voice-pre-start" style="margin: 1.5rem 0;">
                <p style="color: var(--text-secondary); margin-bottom: 1rem;">
                    Read this paragraph aloud, or talk about anything at your normal speaking volume:
                </p>
                <blockquote style="padding: 1rem; background: var(--bg-muted); border-left: 3px solid var(--accent); border-radius: 4px; font-style: italic; color: var(--text-secondary);">
                    "The quick brown fox jumps over the lazy dog. One, two, three, four, five, six, seven, eight, nine, ten. Testing, testing, one, two, three..."
                </blockquote>
                <button class="btn btn-primary" style="margin-top: 1rem;" onclick="window.MicCheck.startVoiceRecording()">
                    🎤 Start Recording
                </button>
            </div>
            
            <div id="voice-visualizer" style="display: none; margin: 1.5rem 0;">
                <div class="level-bar-container">
                    <div id="voice-level-bar" class="level-bar"></div>
                    <span id="voice-level-text" class="level-text">--</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-top: 0.5rem;">
                    <span id="voice-db-reading" style="font-size: 0.85rem; color: var(--text-muted);">-- dB</span>
                    <span id="voice-countdown" style="font-size: 0.85rem; color: var(--text-muted);">12s remaining</span>
                </div>
            </div>
            
            <div id="voice-result" style="display: none; margin-top: 1rem; padding: 1rem; background: var(--bg-muted); border-radius: 8px;">
                <div><strong>Voice Level:</strong> <span id="voice-lufs-final">--</span></div>
                <div><strong>Peak:</strong> <span id="voice-peak-final">--</span></div>
            </div>
            
            <div style="margin-top: 1rem;">
                <button id="btn-show-results" class="btn btn-primary" style="display: none;" onclick="window.MicCheck.showLevelCheckResults()">
                    View Results →
                </button>
                <button class="btn btn-secondary" onclick="window.MicCheck.stopLevelCheck()">Stop</button>
            </div>
        </div>
    `;
}

async function startVoiceRecording() {
    const preStart = document.getElementById('voice-pre-start');
    const visualizer = document.getElementById('voice-visualizer');
    
    if (preStart) preStart.style.display = 'none';
    if (visualizer) visualizer.style.display = 'block';
    
    // Reinitialize with user's AGC preference for voice phase
    const agcEnabled = qualityTestData.userAgcPreference || false;
    const deviceId = qualityTestData.selectedDeviceId || '';
    
    const success = await initQualityAudio(agcEnabled, deviceId);
    if (!success) {
        alert('Failed to access microphone.');
        return;
    }
    
    qualityTestData.voiceSamples = [];
    qualityTestData.peakVoice = -Infinity;
    qualityTestData.isRunning = true;
    
    const duration = 12000;
    const startTime = Date.now();
    
    function measure() {
        if (!qualityTestData.isRunning) return;
        
        const elapsed = Date.now() - startTime;
        const rms = getRmsFromAnalyser(qualityTestData.analyser);
        const db = linearToDb(rms);
        
        qualityTestData.voiceSamples.push(rms);
        sampleChannels();
        collectKWeightedSamples();
        
        if (db > qualityTestData.peakVoice) {
            qualityTestData.peakVoice = db;
        }
        
        const percent = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        const levelBar = document.getElementById('voice-level-bar');
        const levelText = document.getElementById('voice-level-text');
        const dbReading = document.getElementById('voice-db-reading');
        const countdown = document.getElementById('voice-countdown');
        
        if (levelBar) levelBar.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
        if (levelText) levelText.textContent = `${Math.round(percent)}%`;
        if (dbReading) dbReading.textContent = formatDb(db);
        
        const remaining = Math.ceil((duration - elapsed) / 1000);
        if (countdown) countdown.textContent = remaining > 0 ? `${remaining}s remaining` : '';
        
        if (elapsed >= duration) {
            finishVoiceRecording();
        } else {
            levelCheckAnimationId = requestAnimationFrame(measure);
        }
    }
    
    measure();
}

function finishVoiceRecording() {
    // Calculate voice levels from loudest portion
    const sorted = [...qualityTestData.voiceSamples].sort((a, b) => b - a);
    const loudPortion = sorted.slice(0, Math.floor(sorted.length * 0.3));
    const avgVoice = loudPortion.length > 0 ? loudPortion.reduce((a, b) => a + b, 0) / loudPortion.length : 0;
    
    // Calculate LUFS using the K-weighted collector if available
    if (qualityTestData.lufsCollector && qualityTestData.lufsCollector.blocks.length > 0) {
        const lufsResult = calculateGatedLufs(qualityTestData.lufsCollector.blocks);
        qualityTestData.voiceLufs = lufsResult.lufs !== null ? lufsResult.lufs : linearToDb(avgVoice) - 3;
    } else {
        // Fallback: approximate LUFS from RMS (less accurate)
        qualityTestData.voiceLufs = linearToDb(avgVoice) - 3;
    }
    
    qualityTestData.voicePeakDb = qualityTestData.peakVoice;
    qualityTestData.snr = qualityTestData.voiceLufs - qualityTestData.noiseFloorDb;
    qualityTestData.channelBalance = analyzeChannelBalance();
    
    const countdown = document.getElementById('voice-countdown');
    const result = document.getElementById('voice-result');
    const lufsReading = document.getElementById('voice-lufs-final');
    const peakReading = document.getElementById('voice-peak-final');
    const resultsBtn = document.getElementById('btn-show-results');
    
    if (countdown) countdown.textContent = '✓ Complete';
    if (result) result.style.display = 'block';
    if (lufsReading) lufsReading.textContent = formatLufs(qualityTestData.voiceLufs);
    if (peakReading) peakReading.textContent = formatDb(qualityTestData.voicePeakDb);
    if (resultsBtn) resultsBtn.style.display = 'inline-flex';
    
    stopQualityAudio();
}

function showLevelCheckResults() {
    document.getElementById('level-check-steps').style.display = 'none';
    document.getElementById('level-check-results').style.display = 'block';
    displayQualityResults();
}

export function stopLevelCheck() {
    // Stop animation loop
    if (levelCheckAnimationId) {
        cancelAnimationFrame(levelCheckAnimationId);
        levelCheckAnimationId = null;
    }
    
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
        stopMonitor,
        stopLevelCheck,
        runPrivacyCheck,
        continueWithPermissionTests,
        toggleMonitoring,
        openMonitor,
        // Level check step functions
        goToVoiceStep,
        startVoiceRecording,
        showLevelCheckResults
    };
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
