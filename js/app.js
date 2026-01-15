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
    levelCheckState,
    resetQualityTestData,
    requestMicAccess,
    ensurePermissionAndLabels,
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

import { PlaybackRecorder, DualPlaybackRecorder, createDualStreams, getMediaRecorderSupport } from './playback.js';

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

import {
    initStudio,
    startVisualization as startStudioVisualization,
    cleanupStudio,
    populateStudioDeviceDropdown,
    startRecording as startStudioRecording,
    stopRecording as stopStudioRecording,
    getRecordingTime,
    hasRecording,
    getRecordingUrl,
    deleteRecording,
    isRecording as isStudioRecording,
    resetPeaks,
    setProcessingEnabled,
    isProcessingEnabled,
    drawWaveformPreview,
    switchDevice as switchStudioDevice,
    isRunning as isStudioRunning,
    getChannelCount
} from './studio.js';

import { escapeHtml } from './utils.js';

import { route, navigate, initRouter } from './router.js';

// ============================================
// State
// ============================================
let diagnosticContext = null;
let diagnosticResults = null;
let animationId = null;
let audioDetected = false;

// Playback state
let playbackRecorder = null;
let dualPlaybackRecorder = null;
let playbackCountdownTimer = null;
let playbackRecordingTimer = null;
let playbackPeakLevel = 0;
let playbackAudioElement = null;
let playbackProcessingEnabled = true; // true = processed, false = raw
let playbackProcessedUrl = null;
let playbackRawUrl = null;
let playbackStreamErrors = { processed: null, raw: null };

// Monitor state (for passing device between screens)
let selectedMonitorDeviceId = null;

// ============================================
// Screen Navigation (now handled by router.js)
// ============================================
// Note: showScreen is now internal to router.js
// Use navigate('route-name') for programmatic navigation

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
function openMonitor(deviceId) {
    // Store the device ID for monitor screen (router's onEnter will call initMonitorScreen)
    selectedMonitorDeviceId = deviceId || getPrimaryDeviceId();
    
    // Navigate to monitor (router handles cleanup via onLeave)
    navigate('monitor');
}

/**
 * Initialize the monitor screen
 */
async function initMonitorScreen() {
    const dropdown = document.getElementById('monitor-device-select');
    
    // Ensure we have permission and labels before populating dropdown
    const { granted } = await ensurePermissionAndLabels();
    
    // Populate device dropdown - will show appropriate message based on permission state
    await populateMonitorDeviceDropdown(dropdown, selectedMonitorDeviceId);
    
    // If permission was denied, show error state and don't try to start monitor
    if (!granted) {
        const spectrogramCanvas = document.getElementById('spectrogram');
        if (spectrogramCanvas) {
            const ctx = spectrogramCanvas.getContext('2d');
            ctx.fillStyle = '#f5f5f5';
            ctx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
            ctx.fillStyle = '#666';
            ctx.font = '14px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('Microphone access blocked', spectrogramCanvas.width / 2, spectrogramCanvas.height / 2);
        }
        return;
    }
    
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

// ============================================
// Studio Monitor Screen (DAW-style)
// ============================================

let studioAnimationTimer = null;
let studioRecordingTimer = null;
let studioPlaybackAudio = null;
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
        
        // Recording strip
        recordingContainer: document.getElementById('studio-recording-container'),
        recDot: document.getElementById('studio-rec-dot'),
        recTime: document.getElementById('studio-rec-time'),
        waveformCanvas: document.getElementById('studio-waveform-canvas'),
        waveformEmpty: document.getElementById('studio-waveform-empty'),
        recPlay: document.getElementById('studio-rec-play'),
        recDelete: document.getElementById('studio-rec-delete'),
        
        // Processing toggle
        processingToggle: document.getElementById('studio-processing-toggle'),
        processingStatus: document.getElementById('studio-processing-status')
    };
}

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
        els.recordingContainer.style.display = 'none';
        
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
    els.recordingContainer.style.display = 'block';
    
    // Populate device dropdown
    await populateStudioDeviceDropdown(els.deviceSelect, selectedStudioDeviceId);
    
    // Get device to use
    const deviceId = els.deviceSelect.value || selectedStudioDeviceId;
    
    if (deviceId) {
        await startStudioMonitor(deviceId, els);
    }
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
                updateStudioRecordingUI(els, false);
            }
            await startStudioMonitor(deviceId, els);
        }
    });
    
    // Record button
    els.btnRecord?.addEventListener('click', async () => {
        if (isStudioRecording()) return;
        
        els.btnRecord.classList.add('recording');
        els.btnRecord.disabled = true;
        els.btnStop.disabled = false;
        els.btnPlay.disabled = true;
        els.recDot.classList.add('active');
        els.statusDisplay.textContent = 'Recording';
        els.statusDisplay.className = 'transport-status recording';
        els.waveformEmpty.style.display = 'none';
        
        // Reset peaks when starting new recording
        resetPeaks();
        
        // Start timer
        const startTime = Date.now();
        studioRecordingTimer = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            els.recTime.textContent = formatTime(elapsed);
            els.timeDisplay.textContent = formatTime(elapsed);
        }, 100);
        
        // Start recording
        const success = await startStudioRecording();
        
        // Recording ended (either completed or stopped)
        clearInterval(studioRecordingTimer);
        updateStudioRecordingUI(els, success);
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
        if (studioPlaybackAudio) {
            studioPlaybackAudio.pause();
            studioPlaybackAudio.currentTime = 0;
            updateStudioPlaybackUI(els, false);
        }
    });
    
    // Play button (transport)
    els.btnPlay?.addEventListener('click', () => {
        toggleStudioPlayback(els);
    });
    
    // Recording strip play button
    els.recPlay?.addEventListener('click', () => {
        toggleStudioPlayback(els);
    });
    
    // Delete recording
    els.recDelete?.addEventListener('click', () => {
        deleteRecording();
        els.waveformEmpty.style.display = 'flex';
        els.recPlay.disabled = true;
        els.recDelete.disabled = true;
        els.btnPlay.disabled = true;
        els.recTime.textContent = '00:00';
        els.timeDisplay.textContent = '00:00';
        
        // Clear waveform canvas
        const ctx = els.waveformCanvas?.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, els.waveformCanvas.width, els.waveformCanvas.height);
        }
    });
    
    // Processing toggle
    els.processingToggle?.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        setProcessingEnabled(enabled);
        els.processingStatus.textContent = enabled ? 'On' : 'Off';
        
        // Re-initialize with new settings if running (but not during recording)
        if (isStudioRunning() && selectedStudioDeviceId && !isStudioRecording()) {
            await startStudioMonitor(selectedStudioDeviceId, els);
        }
    });
}

/**
 * Update UI after recording ends
 */
function updateStudioRecordingUI(els, success) {
    els.btnRecord.classList.remove('recording');
    els.btnRecord.disabled = false;
    els.btnStop.disabled = true;
    els.recDot.classList.remove('active');
    els.statusDisplay.textContent = 'Monitoring';
    els.statusDisplay.className = 'transport-status';
    
    if (success && hasRecording()) {
        els.recPlay.disabled = false;
        els.recDelete.disabled = false;
        els.btnPlay.disabled = false;
        
        // Draw waveform preview
        drawWaveformPreview(els.waveformCanvas);
    }
}

/**
 * Toggle playback (play/stop)
 */
function toggleStudioPlayback(els) {
    if (studioPlaybackAudio && !studioPlaybackAudio.paused) {
        // Stop playback
        studioPlaybackAudio.pause();
        studioPlaybackAudio.currentTime = 0;
        updateStudioPlaybackUI(els, false);
    } else {
        // Start playback
        playStudioRecording(els);
    }
}

/**
 * Play the studio recording
 */
function playStudioRecording(els) {
    const url = getRecordingUrl();
    if (!url) return;
    
    if (!studioPlaybackAudio) {
        studioPlaybackAudio = new Audio();
        studioPlaybackAudio.addEventListener('ended', () => {
            updateStudioPlaybackUI(els, false);
        });
    }
    
    studioPlaybackAudio.src = url;
    studioPlaybackAudio.play();
    updateStudioPlaybackUI(els, true);
}

/**
 * Update UI for playback state
 */
function updateStudioPlaybackUI(els, isPlaying) {
    if (isPlaying) {
        els.btnPlay.classList.add('playing');
        els.recPlay.classList.add('playing');
        els.recPlay.textContent = '⏹ Stop';
        els.statusDisplay.textContent = 'Playing';
        els.statusDisplay.className = 'transport-status playing';
    } else {
        els.btnPlay.classList.remove('playing');
        els.recPlay.classList.remove('playing');
        els.recPlay.textContent = '▶ Play';
        els.statusDisplay.textContent = 'Monitoring';
        els.statusDisplay.className = 'transport-status';
    }
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
    
    // Stop playback
    if (studioPlaybackAudio) {
        studioPlaybackAudio.pause();
        studioPlaybackAudio = null;
    }
    
    // Clear timers
    if (studioRecordingTimer) {
        clearInterval(studioRecordingTimer);
        studioRecordingTimer = null;
    }
    
    // Cleanup studio
    cleanupStudio();
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
    
    // Clean up legacy single recorder
    if (playbackRecorder) {
        if (playbackRecorder.getIsRecording()) {
            playbackRecorder.abort();
        }
        playbackRecorder.cleanup();
        playbackRecorder = null;
    }
    
    // Clean up dual recorder
    if (dualPlaybackRecorder) {
        if (dualPlaybackRecorder.getIsRecording()) {
            dualPlaybackRecorder.abort();
        }
        dualPlaybackRecorder.cleanup();
        dualPlaybackRecorder.releaseStreams();
        dualPlaybackRecorder = null;
    }
    
    if (playbackAudioElement) {
        playbackAudioElement.pause();
        playbackAudioElement.src = '';
    }
    
    // Revoke blob URLs to prevent memory leaks
    // (avoid double-revoking by tracking what we've revoked)
    if (playbackProcessedUrl) {
        URL.revokeObjectURL(playbackProcessedUrl);
    }
    if (playbackRawUrl && playbackRawUrl !== playbackProcessedUrl) {
        URL.revokeObjectURL(playbackRawUrl);
    }
    
    // Reset dual recording state
    playbackProcessedUrl = null;
    playbackRawUrl = null;
    playbackStreamErrors = { processed: null, raw: null };
    playbackProcessingEnabled = true;
    
    // Reset UI
    resetPlaybackModeUI();
    
    // Reset to initial prompt state (container is always visible on Monitor screen)
    showPlaybackSection('playback-record-prompt');
    playbackPeakLevel = 0;
}

/**
 * Reset the playback mode toggle UI to default state
 */
function resetPlaybackModeUI() {
    const toggle = document.getElementById('playback-processing-toggle');
    const label = document.getElementById('playback-mode-label');
    const desc = document.getElementById('playback-mode-description');
    const icon = document.getElementById('playback-mode-icon');
    const errorEl = document.getElementById('playback-mode-error');
    const selector = document.getElementById('playback-mode-selector');
    
    if (toggle) {
        toggle.checked = true;
        toggle.disabled = false;
    }
    if (label) label.textContent = 'Audio Processing';
    if (desc) desc.textContent = 'What browser apps hear';
    if (icon) icon.textContent = '🔊';
    if (errorEl) errorEl.style.display = 'none';
    if (selector) selector.classList.remove('disabled');
}

/**
 * Update the playback mode UI based on current state and errors
 */
function updatePlaybackModeUI() {
    const toggle = document.getElementById('playback-processing-toggle');
    const desc = document.getElementById('playback-mode-description');
    const icon = document.getElementById('playback-mode-icon');
    const errorEl = document.getElementById('playback-mode-error');
    const errorText = document.getElementById('playback-mode-error-text');
    const selector = document.getElementById('playback-mode-selector');
    
    // Check for errors
    const hasProcessedError = playbackStreamErrors.processed !== null;
    const hasRawError = playbackStreamErrors.raw !== null;
    
    // If one mode failed, show error and disable toggle
    if (hasProcessedError || hasRawError) {
        if (errorEl && errorText) {
            errorEl.style.display = 'flex';
            if (hasRawError) {
                errorText.textContent = 'Raw recording unavailable — browser limitation';
                // Force toggle to ON (processed) and disable
                if (toggle) {
                    toggle.checked = true;
                    toggle.disabled = true;
                }
                playbackProcessingEnabled = true;
            } else if (hasProcessedError) {
                errorText.textContent = 'Processed recording unavailable — using raw';
                // Force toggle to OFF (raw) and disable
                if (toggle) {
                    toggle.checked = false;
                    toggle.disabled = true;
                }
                playbackProcessingEnabled = false;
            }
        }
        if (selector) selector.classList.add('disabled');
    } else {
        if (errorEl) errorEl.style.display = 'none';
        if (toggle) toggle.disabled = false;
        if (selector) selector.classList.remove('disabled');
    }
    
    // Update description based on current mode
    if (desc) {
        desc.textContent = playbackProcessingEnabled 
            ? 'What browser apps hear' 
            : 'Raw microphone signal';
    }
    if (icon) {
        icon.textContent = playbackProcessingEnabled ? '🔊' : '🎤';
    }
}

function showPlaybackSection(sectionId) {
    // Main mutually exclusive sections
    const mainSections = [
        'playback-record-prompt',
        'playback-countdown',
        'playback-recording',
        'playback-controls'  // Contains both ready and playing button groups
    ];
    
    // Determine which main section to show
    let mainSectionToShow = sectionId;
    if (sectionId === 'playback-ready' || sectionId === 'playback-playing') {
        mainSectionToShow = 'playback-controls';
    }
    
    mainSections.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.display = id === mainSectionToShow ? 'block' : 'none';
        }
    });
    
    // Toggle between ready and playing button groups within playback-controls
    const readyButtons = document.getElementById('playback-ready-buttons');
    const playingButtons = document.getElementById('playback-playing-buttons');
    
    if (readyButtons && playingButtons) {
        if (sectionId === 'playback-playing') {
            readyButtons.style.display = 'none';
            playingButtons.style.display = 'block';
        } else if (sectionId === 'playback-ready') {
            readyButtons.style.display = 'flex';
            playingButtons.style.display = 'none';
        }
    }
}

async function startPlaybackRecording() {
    // Get stream from monitor to extract device ID
    const monitorStream = getMonitorStream() || diagnosticContext?.stream;
    
    if (!monitorStream) {
        console.error('No stream available for playback recording');
        return;
    }
    
    // Get device ID from current monitor stream
    const track = monitorStream.getAudioTracks()[0];
    const settings = track?.getSettings();
    const deviceId = settings?.deviceId || selectedMonitorDeviceId;
    
    // Reset state
    playbackPeakLevel = 0;
    playbackProcessingEnabled = true;
    playbackStreamErrors = { processed: null, raw: null };
    resetPlaybackModeUI();
    
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
            startDualRecording(deviceId);
        }
    };
    
    playbackCountdownTimer = setTimeout(runCountdown, 1000);
}

/**
 * Start dual recording - captures both processed and raw streams
 * @param {string} deviceId - The device ID to record from
 */
async function startDualRecording(deviceId) {
    showPlaybackSection('playback-recording');
    
    const timerEl = document.getElementById('recording-timer');
    let secondsLeft = 5;
    timerEl.textContent = secondsLeft;
    
    // Create dual streams (processed and raw)
    const { processedStream, rawStream, errors: streamErrors } = await createDualStreams(deviceId);
    
    // Check if we have at least one stream
    if (!processedStream && !rawStream) {
        console.error('Failed to get any streams for recording');
        showPlaybackSection('playback-record-prompt');
        return;
    }
    
    // Store stream errors for UI
    playbackStreamErrors = streamErrors;
    
    // Start the visual countdown timer
    playbackRecordingTimer = setInterval(() => {
        secondsLeft--;
        timerEl.textContent = Math.max(0, secondsLeft);
        
        // Track peak level using monitor stream
        const analyser = getMonitorAnalyser();
        if (analyser) {
            const rms = getRmsFromAnalyser(analyser);
            if (rms > playbackPeakLevel) {
                playbackPeakLevel = rms;
            }
        }
        
        if (secondsLeft <= 0) {
            clearInterval(playbackRecordingTimer);
            playbackRecordingTimer = null;
        }
    }, 1000);
    
    try {
        // Create dual recorder with available streams
        // If one stream failed, create single recorders for the working one
        if (processedStream && rawStream) {
            dualPlaybackRecorder = new DualPlaybackRecorder(processedStream, rawStream);
            const result = await dualPlaybackRecorder.start(5000);
            playbackProcessedUrl = result.processedUrl;
            playbackRawUrl = result.rawUrl;
            
            // Merge any recording errors
            if (result.errors.processed) {
                playbackStreamErrors.processed = result.errors.processed;
            }
            if (result.errors.raw) {
                playbackStreamErrors.raw = result.errors.raw;
            }
        } else if (processedStream) {
            // Only processed stream available
            playbackRecorder = new PlaybackRecorder(processedStream);
            playbackProcessedUrl = await playbackRecorder.start(5000);
            playbackRawUrl = null;
        } else {
            // Only raw stream available
            playbackRecorder = new PlaybackRecorder(rawStream);
            playbackRawUrl = await playbackRecorder.start(5000);
            playbackProcessedUrl = null;
        }
        
        // Release the recording streams (monitor continues separately)
        if (dualPlaybackRecorder) {
            dualPlaybackRecorder.releaseStreams();
        } else {
            // Release single stream
            if (processedStream) {
                processedStream.getTracks().forEach(t => t.stop());
            }
            if (rawStream) {
                rawStream.getTracks().forEach(t => t.stop());
            }
        }
        
        // Set up audio element for playback
        playbackAudioElement = document.getElementById('playback-audio');
        if (playbackAudioElement.src && playbackAudioElement.src.startsWith('blob:')) {
            URL.revokeObjectURL(playbackAudioElement.src);
        }
        
        // Default to processed if available, otherwise raw
        const defaultUrl = playbackProcessedUrl || playbackRawUrl;
        playbackAudioElement.src = defaultUrl;
        playbackProcessingEnabled = playbackProcessedUrl !== null;
        
        // Update toggle UI to match what's available
        updatePlaybackModeUI();
        
        // Show warning if audio was too quiet (based on processed stream if available)
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
        // Clean up streams
        if (processedStream) {
            processedStream.getTracks().forEach(t => t.stop());
        }
        if (rawStream) {
            rawStream.getTracks().forEach(t => t.stop());
        }
        showPlaybackSection('playback-record-prompt');
    }
}

function playRecording() {
    // Get the URL for the currently selected mode
    const url = playbackProcessingEnabled ? playbackProcessedUrl : playbackRawUrl;
    
    if (!playbackAudioElement || !url) return;
    
    // Update audio source if it changed (user toggled mode)
    if (playbackAudioElement.src !== url) {
        playbackAudioElement.src = url;
    }
    
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
        playbackAudioElement.src = '';
    }
    
    // Clean up dual recorder
    if (dualPlaybackRecorder) {
        dualPlaybackRecorder.cleanup();
        dualPlaybackRecorder = null;
    }
    
    // Clean up legacy single recorder
    if (playbackRecorder) {
        playbackRecorder.cleanup();
        playbackRecorder = null;
    }
    
    // Revoke blob URLs
    if (playbackProcessedUrl) {
        URL.revokeObjectURL(playbackProcessedUrl);
        playbackProcessedUrl = null;
    }
    if (playbackRawUrl) {
        URL.revokeObjectURL(playbackRawUrl);
        playbackRawUrl = null;
    }
    
    startPlaybackRecording();
}

/**
 * Handle playback mode toggle change
 * @param {boolean} processingEnabled - true for processed, false for raw
 */
function onPlaybackModeChange(processingEnabled) {
    playbackProcessingEnabled = processingEnabled;
    
    // Update UI description
    const desc = document.getElementById('playback-mode-description');
    const icon = document.getElementById('playback-mode-icon');
    
    if (desc) {
        desc.textContent = processingEnabled 
            ? 'What browser apps hear' 
            : 'Raw microphone signal';
    }
    if (icon) {
        icon.textContent = processingEnabled ? '🔊' : '🎤';
    }
    
    // If audio is currently playing, switch to the new source
    if (playbackAudioElement && !playbackAudioElement.paused) {
        const newUrl = processingEnabled ? playbackProcessedUrl : playbackRawUrl;
        if (newUrl && playbackAudioElement.src !== newUrl) {
            // Remember current playback position
            const currentTime = playbackAudioElement.currentTime;
            
            // Switch source and resume from same position
            playbackAudioElement.src = newUrl;
            playbackAudioElement.currentTime = currentTime;
            playbackAudioElement.play();
        }
    }
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
// Event Listeners
// ============================================
function setupListeners() {
    // Home screen - Start Test button
    document.getElementById('btn-start-test')?.addEventListener('click', () => {
        navigate('test');
    });
    
    // Journey cards - handle both click and keyboard activation
    // Map journey names to route paths
    const journeyRoutes = {
        'level-check': 'level-check',
        'monitor': 'monitor',
        'studio': 'studio',
        'privacy': 'privacy'
    };
    
    document.querySelectorAll('.journey-card').forEach(card => {
        const activateCard = () => {
            const journey = card.dataset.journey;
            const routePath = journeyRoutes[journey];
            if (routePath) {
                navigate(routePath);
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
        selectedMonitorDeviceId = getPrimaryDeviceId();
        navigate('monitor');
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
    
    // Playback mode toggle (processed vs raw)
    document.getElementById('playback-processing-toggle')?.addEventListener('change', (e) => {
        onPlaybackModeChange(e.target.checked);
    });
    
    document.getElementById('link-playback-level-check')?.addEventListener('click', (e) => {
        e.preventDefault();
        navigate('level-check');
    });
    
    // Privacy check
    document.getElementById('btn-privacy-check')?.addEventListener('click', () => {
        runPrivacyCheck();
    });
    
    // Level check
    document.getElementById('btn-quality-start')?.addEventListener('click', () => {
        startQualityTest();
    });
    
    document.getElementById('btn-refresh-devices')?.addEventListener('click', async () => {
        const select = document.getElementById('quality-device-select');
        await populateDeviceList(select);
    });
    
    // Level check step buttons
    document.getElementById('btn-start-silence')?.addEventListener('click', startSilenceRecording);
    document.getElementById('btn-next-to-voice')?.addEventListener('click', goToVoiceStep);
    document.getElementById('btn-start-voice')?.addEventListener('click', startVoiceRecording);
    document.getElementById('btn-show-results')?.addEventListener('click', showQualityResults);
}

// ============================================
// Level Check Functions
// ============================================
async function initLevelCheck() {
    const select = document.getElementById('quality-device-select');
    
    // Ensure we have permission and labels before populating dropdown
    const { granted } = await ensurePermissionAndLabels();
    
    // Populate device dropdown - will show appropriate message based on permission state
    await populateDeviceList(select);
    
    // If permission was denied, disable the start button
    if (!granted) {
        const startBtn = document.getElementById('btn-quality-start');
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.title = 'Microphone access is blocked';
        }
    }
}

let levelCheckAnimationId = null;

async function startQualityTest() {
    document.getElementById('quality-intro').style.display = 'none';
    document.getElementById('quality-step-silence').style.display = 'block';
    document.getElementById('quality-results').style.display = 'none';
    
    resetQualityTestData();
    levelCheckState.isRunning = true;
    
    document.getElementById('silence-visualizer').style.display = 'none';
    document.getElementById('silence-result').style.display = 'none';
    document.getElementById('btn-start-silence').style.display = 'inline-flex';
    document.getElementById('btn-next-to-voice').style.display = 'none';
    document.getElementById('silence-countdown').textContent = '';
    document.getElementById('silence-final-reading').textContent = '—';
}

async function startSilenceRecording() {
    const btn = document.getElementById('btn-start-silence');
    btn.style.display = 'none';
    
    document.getElementById('silence-visualizer').style.display = 'block';
    
    // Voice phase always uses AGC ON (simulates how browser apps hear you)
    // Silence phase uses AGC OFF for accurate noise floor measurement
    levelCheckState.userAgcPreference = true;
    
    const deviceSelect = document.getElementById('quality-device-select');
    const deviceId = deviceSelect?.value || '';
    levelCheckState.selectedDeviceId = deviceId;
    
    // Always record silence with AGC OFF for accurate noise floor measurement
    const success = await initQualityAudio(false, deviceId);
    if (!success) {
        document.getElementById('silence-visualizer').innerHTML = `
            <div class="status-card problem">
                <span class="status-icon">❌</span>
                <div class="status-text">
                    <div class="status-title">Microphone access denied</div>
                    <div class="status-detail">
                        Allow microphone access in your browser settings, then <strong>refresh this page</strong> to try again.
                    </div>
                </div>
            </div>
            <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                <button id="btn-refresh-page" class="btn btn-primary" style="flex: 1;">
                    🔄 Refresh Page
                </button>
                <button id="btn-retry-level-check" class="btn btn-secondary" style="flex: 1;">
                    ← Back
                </button>
            </div>
        `;
        document.getElementById('btn-refresh-page')?.addEventListener('click', () => location.reload());
        document.getElementById('btn-retry-level-check')?.addEventListener('click', resetQualityTest);
        return;
    }
    
    updateQualityDeviceInfo('silence');
    
    levelCheckState.noiseFloorSamples = [];
    const duration = 5000;
    const startTime = Date.now();
    
    function measure() {
        if (!levelCheckState.isRunning) return;
        
        const elapsed = Date.now() - startTime;
        const rms = getRmsFromAnalyser(levelCheckState.analyser);
        const db = linearToDb(rms);
        
        levelCheckState.noiseFloorSamples.push(rms);
        
        const percent = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        document.getElementById('silence-level-bar').style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
        document.getElementById('silence-level-text').textContent = `${Math.round(percent)}%`;
        document.getElementById('silence-db-reading').textContent = formatDb(db);
        
        const remaining = Math.ceil((duration - elapsed) / 1000);
        document.getElementById('silence-countdown').textContent = remaining > 0 ? `${remaining}s` : '';
        
        if (elapsed >= duration) {
            finishSilenceRecording();
        } else {
            levelCheckAnimationId = requestAnimationFrame(measure);
        }
    }
    
    measure();
}

function updateQualityDeviceInfo(phase = 'silence') {
    const infoEl = document.getElementById('quality-device-info');
    const nameEl = document.getElementById('quality-device-name');
    const settingsEl = document.getElementById('quality-device-settings');
    
    if (!infoEl || !levelCheckState.deviceLabel) return;
    
    infoEl.style.display = 'block';
    nameEl.textContent = levelCheckState.deviceLabel;
    
    const settings = levelCheckState.appliedSettings || {};
    const settingsParts = [];
    
    if (settings.sampleRate) {
        settingsParts.push(`${settings.sampleRate / 1000}kHz`);
    }
    if (settings.channelCount) {
        settingsParts.push(settings.channelCount === 1 ? 'Mono' : `${settings.channelCount}ch`);
    }
    
    // Explain why AGC is off during silence phase
    if (phase === 'silence') {
        settingsParts.push('AGC: Off (for accurate noise floor)');
    } else {
        settingsParts.push(`AGC: ${settings.autoGainControl ? 'On' : 'Off'}`);
    }
    
    settingsEl.textContent = settingsParts.join(' • ');
}

function finishSilenceRecording() {
    const sorted = [...levelCheckState.noiseFloorSamples].sort((a, b) => a - b);
    const quietHalf = sorted.slice(0, Math.floor(sorted.length / 2));
    const avgNoise = quietHalf.length > 0 ? quietHalf.reduce((a, b) => a + b, 0) / quietHalf.length : 0;
    levelCheckState.noiseFloorDb = linearToDb(avgNoise);
    
    document.getElementById('silence-countdown').textContent = '✓ Complete';
    document.getElementById('silence-result').style.display = 'block';
    document.getElementById('silence-final-reading').textContent = formatDb(levelCheckState.noiseFloorDb);
    document.getElementById('btn-next-to-voice').style.display = 'inline-flex';
}

function goToVoiceStep() {
    document.getElementById('quality-step-silence').style.display = 'none';
    document.getElementById('quality-step-voice').style.display = 'block';
    
}

async function startVoiceRecording() {
    // Hide the pre-start section with the button
    const preStart = document.getElementById('voice-pre-start');
    if (preStart) preStart.style.display = 'none';
    
    document.getElementById('voice-visualizer').style.display = 'block';
    
    // Reinitialize audio with user's AGC preference for voice phase
    // (Silence phase was recorded with AGC OFF for accurate noise floor)
    const agcEnabled = levelCheckState.userAgcPreference || false;
    const deviceId = levelCheckState.selectedDeviceId || '';
    
    const success = await initQualityAudio(agcEnabled, deviceId);
    if (!success) {
        document.getElementById('voice-visualizer').innerHTML = `
            <div class="status-card problem">
                <span class="status-icon">❌</span>
                <div class="status-text">
                    <div class="status-title">Microphone access denied</div>
                    <div class="status-detail">
                        Allow microphone access in your browser settings, then <strong>refresh this page</strong> to try again.
                    </div>
                </div>
            </div>
            <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
                <button id="btn-refresh-page-voice" class="btn btn-primary" style="flex: 1;">
                    🔄 Refresh Page
                </button>
                <button id="btn-retry-level-check-voice" class="btn btn-secondary" style="flex: 1;">
                    ← Back
                </button>
            </div>
        `;
        document.getElementById('btn-refresh-page-voice')?.addEventListener('click', () => location.reload());
        document.getElementById('btn-retry-level-check-voice')?.addEventListener('click', resetQualityTest);
        return;
    }
    
    // Update device info
    updateQualityDeviceInfo('voice');
    
    levelCheckState.voiceSamples = [];
    levelCheckState.peakVoice = -Infinity;
    levelCheckState.isRunning = true;
    
    const duration = 12000;
    const startTime = Date.now();
    
    function measure() {
        if (!levelCheckState.isRunning) return;
        
        const elapsed = Date.now() - startTime;
        const rms = getRmsFromAnalyser(levelCheckState.analyser);
        const db = linearToDb(rms);
        
        levelCheckState.voiceSamples.push(rms);
        sampleChannels();
        
        // Collect K-weighted samples for ITU-R BS.1770 LUFS measurement
        collectKWeightedSamples();
        
        if (db > levelCheckState.peakVoice) {
            levelCheckState.peakVoice = db;
        }
        
        const percent = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        document.getElementById('voice-level-bar').style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
        document.getElementById('voice-level-text').textContent = `${Math.round(percent)}%`;
        document.getElementById('voice-db-reading').textContent = formatDb(db);
        
        const remaining = Math.ceil((duration - elapsed) / 1000);
        document.getElementById('voice-countdown').textContent = remaining > 0 ? `${remaining}s remaining` : '';
        
        if (elapsed >= duration) {
            finishVoiceRecording();
        } else {
            levelCheckAnimationId = requestAnimationFrame(measure);
        }
    }
    
    measure();
}

function finishVoiceRecording() {
    // Calculate LUFS using ITU-R BS.1770 gating algorithm
    const lufsResult = calculateGatedLufs(levelCheckState.lufsCollector?.getBlocks() || []);
    
    // Handle edge cases from LUFS calculation
    if (lufsResult.error === 'insufficient-data') {
        console.warn('LUFS calculation: insufficient data, need at least 400ms of audio');
        levelCheckState.voiceLufs = -60; // Fallback to very quiet
    } else if (lufsResult.error === 'no-voice-detected') {
        console.warn('LUFS calculation: no voice detected above -70 LUFS threshold');
        levelCheckState.voiceLufs = -60;
    } else {
        levelCheckState.voiceLufs = lufsResult.lufs;
        if (lufsResult.warning === 'used-ungated') {
            console.log('LUFS calculation: used ungated measurement (relative gate removed all blocks)');
        }
    }
    
    console.log('LUFS calculation result:', lufsResult);
    
    levelCheckState.voicePeakDb = levelCheckState.peakVoice;
    levelCheckState.snr = levelCheckState.voiceLufs - levelCheckState.noiseFloorDb;
    
    levelCheckState.channelBalance = analyzeChannelBalance();
    
    document.getElementById('voice-countdown').textContent = '✓ Complete';
    document.getElementById('voice-result').style.display = 'block';
    document.getElementById('voice-lufs-final').textContent = formatLufs(levelCheckState.voiceLufs);
    document.getElementById('voice-peak-final').textContent = formatDb(levelCheckState.voicePeakDb);
    document.getElementById('btn-show-results').style.display = 'inline-flex';
    
    stopQualityAudio();
}

function showQualityResults() {
    document.getElementById('quality-step-voice').style.display = 'none';
    document.getElementById('quality-results').style.display = 'block';
    displayQualityResults();
}

function resetQualityTest() {
    stopQualityAudio();
    resetQualityTestData();
    
    document.getElementById('quality-intro').style.display = 'block';
    document.getElementById('quality-step-silence').style.display = 'none';
    document.getElementById('quality-step-voice').style.display = 'none';
    document.getElementById('quality-results').style.display = 'none';
    
    // Reset UI elements
    const elementsToReset = [
        'silence-visualizer', 'silence-result', 'voice-visualizer', 'voice-result'
    ];
    elementsToReset.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    
    document.getElementById('btn-start-silence').style.display = 'inline-flex';
    document.getElementById('btn-next-to-voice').style.display = 'none';
    document.getElementById('btn-show-results').style.display = 'none';
    
    // Reset voice pre-start section
    const preStart = document.getElementById('voice-pre-start');
    if (preStart) preStart.style.display = 'block';
}

function downloadLevelCheckReport() {
    // Generate and download diagnostics report
    const report = {
        timestamp: new Date().toISOString(),
        type: 'level-check',
        device: levelCheckState.deviceLabel,
        settings: {
            agcEnabled: levelCheckState.agcEnabled,
            sampleRate: levelCheckState.contextSampleRate
        },
        results: {
            noiseFloorDb: levelCheckState.noiseFloorDb,
            voiceLufs: levelCheckState.voiceLufs,
            voicePeakDb: levelCheckState.voicePeakDb,
            snr: levelCheckState.snr,
            channelBalance: levelCheckState.channelBalance
        }
    };
    
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mic-check-level-report-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export function stopLevelCheck() {
    // Stop animation loop
    if (levelCheckAnimationId) {
        cancelAnimationFrame(levelCheckAnimationId);
        levelCheckAnimationId = null;
    }
    
    resetQualityTest();
}

// ============================================
// Initialization
// ============================================
function init() {
    detectBrowser();
    setupListeners();
    
    // Define routes
    route('', {
        screen: 'screen-home',
        onLeave: () => {
            // No cleanup needed for home
        }
    });
    
    route('test', {
        screen: 'screen-mic-test',
        onEnter: runMicrophoneTest,
        onLeave: stopTest
    });
    
    route('level-check', {
        screen: 'screen-level-check',
        onEnter: initLevelCheck,
        onLeave: stopLevelCheck
    });
    
    route('monitor', {
        screen: 'screen-monitor',
        onEnter: initMonitorScreen,
        onLeave: stopMonitor
    });
    
    route('studio', {
        screen: 'screen-studio',
        onEnter: initStudioScreen,
        onLeave: stopStudioScreen
    });
    
    route('privacy', {
        screen: 'screen-privacy',
        onEnter: runPrivacyCheck,
        onLeave: () => {
            // No cleanup needed for privacy
        }
    });
    
    // Start the router
    initRouter();
    
    // Expose API for inline onclick handlers and programmatic navigation
    window.MicCheck = {
        navigate,
        stopTest,
        stopMonitor,
        stopStudioScreen,
        stopLevelCheck,
        runPrivacyCheck,
        continueWithPermissionTests,
        toggleMonitoring,
        // Level check step functions
        goToVoiceStep,
        startVoiceRecording,
        showQualityResults,
        startSilenceRecording,
        // Results screen functions (with aliases for backward compatibility)
        resetQualityTest,
        resetLevelCheck: resetQualityTest,
        downloadLevelCheckReport
    };
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
