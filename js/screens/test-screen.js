/**
 * Microphone Test Screen Logic
 * 
 * Handles diagnostics flow, quality tests, and legacy level check.
 */

import { 
    diagnostics,
    qualityDiagnostics,
    allDiagnostics,
    STATUS,
    SCOPE,
    createContext,
    createInitialResults,
    runPrePermissionDiagnostics,
    runPermissionDiagnostics,
    runDeviceDiagnostics,
    runQualityDiagnostic,
    canRunQualityDiagnostics,
    activateQualitySection,
    cleanupContext,
    getOverallStatus
} from '../diagnostics/index.js';

import { 
    linearToDb, 
    formatDb, 
    formatLufs 
} from '../standards.js';

import { 
    levelCheckState,
    resetQualityTestData,
    ensurePermissionAndLabels,
    initQualityAudio,
    stopQualityAudio,
    sampleChannels,
    analyzeChannelBalance,
    populateDeviceList,
    collectKWeightedSamples,
    getRmsFromAnalyser,
    getSampleIntegrity
} from '../audio.js';

import { calculateGatedLufs } from '../lufs.js';

import { isFirefoxBased } from '../browser.js';

import { displayQualityResults } from '../results.js';

import {
    initMultiMeter,
    enableMonitoring,
    disableMonitoring,
    isMonitoring,
    getPrimaryDeviceId,
    setPrimaryDevice,
    findDefaultDeviceId,
    cleanupAllMonitoring,
    getStream,
    getAnalyser
} from '../multi-device-meter.js';

import { escapeHtml } from '../utils.js';

// ============================================
// State
// ============================================
let diagnosticContext = null;
let diagnosticResults = null;
let audioDetected = false;

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
    // Update all diagnostics (core + quality)
    // Fallback to diagnostics array if allDiagnostics not available (cache issue)
    const diagsToUpdate = allDiagnostics || diagnostics;
    
    // Always update quality section state based on signal-detection result
    // This must be called even if quality diagnostics aren't in the results yet
    updateQualitySectionState(results);
    
    diagsToUpdate.forEach(diag => {
        const result = results[diag.id];
        if (!result) return;
        
        const row = document.getElementById(`diag-row-${diag.id}`);
        if (!row) return;
        
        // Update row status class
        row.className = row.className.replace(/\b(pass|fail|warn|skip|pending|running)\b/g, '').trim();
        if (result.status) {
            row.classList.add(result.status);
        }
        
        // Update status icon
        const iconCell = row.querySelector('.diag-icon');
        if (iconCell) {
            iconCell.textContent = getStatusIcon(result.status);
        }
        
        // Update quality section inactive state for quality rows
        if (diag.scope === SCOPE.QUALITY || diag.scope === 'quality') {
            // If quality tests can run, ensure row isn't inactive
            if (canRunQualityDiagnostics(results)) {
                row.classList.remove('inactive');
            }
        }
        
        // Update detail text (but not if we're showing a level meter)
        const detailCell = row.querySelector('.diag-detail');
        if (detailCell && !detailCell.querySelector('.mic-level-meter')) {
            detailCell.textContent = result.message || '';
        }
        
        // Update inline action/fix area
        const actionCell = row.querySelector('.diag-action');
        if (actionCell) {
            updateRowAction(diag.id, result, actionCell, results);
        }
    });
    
    // Check for stereo issues and show warning panel
    if (results['voice-level']?.stereoIssue) {
        const stereoWarning = document.getElementById('stereo-issue-warning');
        if (stereoWarning) {
            stereoWarning.style.display = 'block';
        }
    }
    
    // Show quality summary if both quality tests are done
    updateQualitySummary(results);
}

/**
 * Update quality section state (active/inactive)
 */
function updateQualitySectionState(results) {
    const qualitySection = document.getElementById('diag-section-quality');
    const noiseFloorRow = document.getElementById('diag-row-noise-floor');
    const voiceLevelRow = document.getElementById('diag-row-voice-level');
    
    const canRun = canRunQualityDiagnostics(results);
    
    [qualitySection, noiseFloorRow, voiceLevelRow].forEach(el => {
        if (el) {
            if (canRun) {
                el.classList.remove('inactive');
            } else {
                el.classList.add('inactive');
            }
        }
    });
}

/**
 * Update quality summary section
 */
function updateQualitySummary(results) {
    const noiseResult = results['noise-floor'];
    const voiceResult = results['voice-level'];
    
    // Only show summary when both quality tests are complete
    const bothComplete = noiseResult && voiceResult &&
        noiseResult.status !== STATUS.PENDING && noiseResult.status !== STATUS.RUNNING &&
        voiceResult.status !== STATUS.PENDING && voiceResult.status !== STATUS.RUNNING;
    
    const summaryEl = document.getElementById('quality-summary');
    const actionsEl = document.getElementById('quality-actions');
    
    if (!bothComplete || !summaryEl) return;
    
    const hasStereoIssue = voiceResult.stereoIssue;
    const hasWarning = noiseResult.status === STATUS.WARN || voiceResult.status === STATUS.WARN;
    const allPass = noiseResult.status === STATUS.PASS && voiceResult.status === STATUS.PASS;
    
    let icon, title, detail, bgColor;
    
    if (hasStereoIssue) {
        icon = '🔧';
        title = 'Fixable issue found';
        detail = 'Stereo misconfiguration — see fix instructions above';
        bgColor = '#fff3e0';
    } else if (allPass) {
        icon = '✅';
        title = 'Your microphone is ready for calls';
        detail = 'All tests passed';
        bgColor = '#e6f4ea';
    } else if (hasWarning) {
        icon = '⚠️';
        title = 'Some adjustments recommended';
        detail = 'See suggestions above';
        bgColor = '#fff3e0';
    } else {
        icon = '✅';
        title = 'Tests complete';
        detail = '';
        bgColor = 'var(--bg-muted)';
    }
    
    const iconEl = document.getElementById('quality-summary-icon');
    const titleEl = document.getElementById('quality-summary-title');
    const detailEl = document.getElementById('quality-summary-detail');
    
    if (iconEl) iconEl.textContent = icon;
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = detail;
    summaryEl.style.background = bgColor;
    summaryEl.style.display = 'block';
    
    if (actionsEl) {
        actionsEl.style.display = 'flex';
    }
}

/**
 * Update inline action/fix for a specific row
 */
function updateRowAction(diagId, result, actionCell, results) {
    // Permission button goes inline in permission-state row
    // Show for both PENDING (explicit 'prompt') and WARN (API unavailable/uncertain)
    if (diagId === 'permission-state' && 
        (result.status === STATUS.PENDING || result.status === STATUS.WARN)) {
        actionCell.innerHTML = `
            <button class="btn btn-primary btn-small" onclick="window.MicCheck.continueWithPermissionTests()">
                🔓 Request Audio Access
            </button>
            <div class="diag-action-hint">Your browser will ask you to allow access.</div>
        `;
        actionCell.style.display = 'block';
        return;
    }
    
    // Noise floor test - show start button when ready
    if (diagId === 'noise-floor' && result.status === STATUS.PENDING && canRunQualityDiagnostics(results)) {
        actionCell.innerHTML = `
            <button class="btn btn-primary btn-small" id="btn-start-noise-test" onclick="window.MicCheck.startNoiseFloorTest()">
                🎤 Start Silence Test (5s)
            </button>
            <div class="diag-action-hint">Stay quiet while we measure background noise.</div>
        `;
        actionCell.style.display = 'block';
        return;
    }
    
    // Voice level test - show start button when noise test is done
    if (diagId === 'voice-level' && result.status === STATUS.PENDING && 
        results['noise-floor']?.status === STATUS.PASS) {
        actionCell.innerHTML = `
            <button class="btn btn-primary btn-small" id="btn-start-voice-test" onclick="window.MicCheck.startVoiceLevelTest()">
                🎤 Start Voice Test (10s)
            </button>
            <div class="diag-action-hint">Read the passage below at your normal speaking volume.</div>
            <div class="rainbow-passage" style="margin-top: 0.75rem; padding: 0.75rem; background: #fffbf0; border-left: 3px solid #f0c040; font-style: italic; font-size: 0.85rem; line-height: 1.5;">
                "The rainbow appears when sunlight shines through falling rain. 
                People look with awe at the brilliant colors stretching across the sky. 
                Vibrant reds blend gently into warm oranges and yellows, 
                while cool blues and deep purples fade softly at the edges."
            </div>
        `;
        actionCell.style.display = 'block';
        return;
    }
    
    // Voice level test - RUNNING: keep passage visible, don't modify the recording UI
    if (diagId === 'voice-level' && result.status === STATUS.RUNNING) {
        // The recording UI with rainbow passage is already set by startVoiceLevelTest()
        // Just ensure the action cell stays visible
        actionCell.style.display = 'block';
        return;
    }
    
    // Fix instructions go inline for failed/warn tests
    if ((result.status === STATUS.FAIL || result.status === STATUS.WARN) && result.fix) {
        actionCell.innerHTML = '';
        const label = document.createElement('strong');
        label.textContent = 'How to fix:';
        const message = document.createTextNode(` ${result.fix}`);
        actionCell.append(label, message);
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
    const diagsToReset = allDiagnostics || diagnostics;
    diagsToReset.forEach(diag => {
        const row = document.getElementById(`diag-row-${diag.id}`);
        if (!row) return;
        
        // Preserve class modifiers like 'diag-quality-section' but reset status classes
        const preserveClasses = ['diag-quality-section', 'diag-section-row'];
        const currentClasses = [...row.classList].filter(c => preserveClasses.includes(c));
        row.className = currentClasses.join(' ');
        
        // Add inactive to quality rows
        if (diag.scope === SCOPE.QUALITY || diag.scope === 'quality') {
            row.classList.add('inactive');
        }
        
        const iconCell = row.querySelector('.diag-icon');
        if (iconCell) iconCell.textContent = '⏸️';
        
        const detailCell = row.querySelector('.diag-detail');
        if (detailCell) {
            // Set default message - quality tests show dependency, others show pending message
            if (diag.id === 'noise-floor') {
                detailCell.textContent = 'Waiting for audio signal test';
            } else if (diag.id === 'voice-level') {
                detailCell.textContent = 'Waiting for silence test';
            } else {
                // Use the diagnostic's pending message if available
                detailCell.textContent = diag.pendingMessage || '';
            }
        }
        
        const actionCell = row.querySelector('.diag-action');
        if (actionCell) {
            actionCell.style.display = 'none';
            actionCell.innerHTML = '';
        }
    });
    
    // Reset quality section header too
    const qualitySection = document.getElementById('diag-section-quality');
    if (qualitySection) {
        qualitySection.classList.add('inactive');
    }
    
    // Hide summary and stereo warning
    const summaryEl = document.getElementById('quality-summary');
    if (summaryEl) summaryEl.style.display = 'none';
    
    const stereoWarning = document.getElementById('stereo-issue-warning');
    if (stereoWarning) stereoWarning.style.display = 'none';
    
    const actionsEl = document.getElementById('quality-actions');
    if (actionsEl) actionsEl.style.display = 'none';
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
    // visualizer-section removed - no longer needed
    const detectedDevices = document.getElementById('detected-devices');
    if (detectedDevices) detectedDevices.style.display = 'none';
    const btnRetry = document.getElementById('btn-retry-test');
    if (btnRetry) btnRetry.style.display = 'none';
    const testActions = document.getElementById('test-actions');
    if (testActions) testActions.style.display = 'block';
    
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
    }
    
    // Populate the mic monitor panel
    populateMicMonitorPanel(deduplicatedDevices, defaultDeviceId);
    
    // Activate quality section - signal detection passed
    activateQualitySection(diagnosticResults, updateDiagnosticTable);
    
    // Update noise-floor to show it's ready (using the diagnostic's pendingMessage)
    const noiseFloorDiag = qualityDiagnostics.find(d => d.id === 'noise-floor');
    if (diagnosticResults['noise-floor'] && noiseFloorDiag) {
        diagnosticResults['noise-floor'].message = noiseFloorDiag.pendingMessage;
        updateDiagnosticTable(diagnosticResults);
    }
}

// ============================================
// Stop Test
// ============================================
function stopTest() {
    // Cleanup all multi-device monitoring
    cleanupAllMonitoring();
    
    // Cleanup diagnostic context
    if (diagnosticContext) {
        cleanupContext(diagnosticContext);
        diagnosticContext = null;
    }
    
    diagnosticResults = null;
    audioDetected = false;
}

// ============================================
// Quality Tests (User-Initiated)
// ============================================

/**
 * Start the noise floor test (5 seconds of silence)
 */
async function startNoiseFloorTest() {
    if (!diagnosticContext || !diagnosticResults) {
        console.error('No diagnostic context available');
        return;
    }
    
    // Disable the start button to prevent double-clicks
    const startBtn = document.getElementById('btn-start-noise-test');
    if (startBtn) startBtn.disabled = true;
    
    const row = document.getElementById('diag-row-noise-floor');
    const detailCell = row?.querySelector('.diag-detail');
    const actionCell = row?.querySelector('.diag-action');
    
    // Hide action, show progress in detail
    if (actionCell) actionCell.style.display = 'none';
    
    // Add level meter to detail area (reusing mic-level-meter component)
    if (detailCell) {
        detailCell.innerHTML = `
            <div class="diag-recording">
                <span class="diag-recording-dot"></span>
                <span>Recording silence... <span id="noise-countdown">5s</span></span>
            </div>
            <div class="mic-level-meter inline" id="noise-level-meter">
                <div class="mic-level-meter-fill" id="noise-level-bar"></div>
                <span class="mic-level-meter-text" id="noise-db-reading">—</span>
            </div>
        `;
    }
    
    // Run the noise floor diagnostic
    await runQualityDiagnostic('noise-floor', diagnosticContext, diagnosticResults, {
        onProgress: (progress) => {
            // Update countdown
            const countdownEl = document.getElementById('noise-countdown');
            if (countdownEl) {
                countdownEl.textContent = `${progress.remainingSeconds}s`;
            }
            
            // Update level bar using mic-level-meter's clipPath approach
            const levelBar = document.getElementById('noise-level-bar');
            if (levelBar) {
                const percent = Math.max(0, Math.min(100, ((progress.levelDb + 60) / 60) * 100));
                levelBar.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
            }
            
            // Update dB reading (in the meter text)
            const dbReading = document.getElementById('noise-db-reading');
            if (dbReading) {
                dbReading.textContent = formatDb(progress.levelDb);
            }
        },
        onUpdate: (results) => {
            updateDiagnosticTable(results);
        }
    });
    
    // Update the detail to show final result
    if (detailCell) {
        detailCell.textContent = diagnosticResults['noise-floor'].message;
    }
    
    // Update voice-level to show it's ready (using the diagnostic's pendingMessage)
    const voiceLevelDiag = qualityDiagnostics.find(d => d.id === 'voice-level');
    if (diagnosticResults['voice-level'] && voiceLevelDiag && 
        diagnosticResults['noise-floor'].status === STATUS.PASS) {
        diagnosticResults['voice-level'].message = voiceLevelDiag.pendingMessage;
    }
    
    // Update the full table to show voice test button
    updateDiagnosticTable(diagnosticResults);
}

/**
 * Start the voice level test (10 seconds of speech)
 */
async function startVoiceLevelTest() {
    if (!diagnosticContext || !diagnosticResults) {
        console.error('No diagnostic context available');
        return;
    }
    
    // Disable the start button
    const startBtn = document.getElementById('btn-start-voice-test');
    if (startBtn) startBtn.disabled = true;
    
    const row = document.getElementById('diag-row-voice-level');
    const detailCell = row?.querySelector('.diag-detail');
    const actionCell = row?.querySelector('.diag-action');
    
    // Replace action cell content with recording UI + passage (keep passage visible!)
    if (actionCell) {
        actionCell.innerHTML = `
            <div class="diag-recording">
                <span class="diag-recording-dot"></span>
                <span>Recording... <span id="voice-countdown">10s</span></span>
            </div>
            <div class="mic-level-meter inline" id="voice-level-meter">
                <div class="mic-level-meter-fill" id="voice-level-bar"></div>
                <span class="mic-level-meter-text" id="voice-db-reading">—</span>
            </div>
            <div class="rainbow-passage" style="margin-top: 0.75rem; padding: 0.75rem; background: #fffbf0; border-left: 3px solid #f0c040; font-style: italic; font-size: 0.85rem; line-height: 1.5;">
                "The rainbow appears when sunlight shines through falling rain. 
                People look with awe at the brilliant colors stretching across the sky. 
                Vibrant reds blend gently into warm oranges and yellows, 
                while cool blues and deep purples fade softly at the edges."
            </div>
        `;
    }
    
    // Run the voice level diagnostic
    await runQualityDiagnostic('voice-level', diagnosticContext, diagnosticResults, {
        onProgress: (progress) => {
            // Update countdown
            const countdownEl = document.getElementById('voice-countdown');
            if (countdownEl) {
                countdownEl.textContent = `${progress.remainingSeconds}s`;
            }
            
            // Update level bar using mic-level-meter's clipPath approach
            const levelBar = document.getElementById('voice-level-bar');
            if (levelBar) {
                const percent = Math.max(0, Math.min(100, ((progress.levelDb + 60) / 60) * 100));
                levelBar.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
            }
            
            // Update dB reading (in the meter text)
            const dbReading = document.getElementById('voice-db-reading');
            if (dbReading) {
                dbReading.textContent = formatDb(progress.levelDb);
            }
        },
        onUpdate: (results) => {
            updateDiagnosticTable(results);
        }
    });
    
    // Update the detail to show final result
    if (detailCell) {
        detailCell.textContent = diagnosticResults['voice-level'].message;
    }
    
    // Update the full table
    updateDiagnosticTable(diagnosticResults);
    
    // Update subtitle
    updateSubtitle('Pre-flight check complete!');
}

/**
 * Reset and run the test again
 */
function testAgain() {
    // Can't rely on navigate('test') if already on #test - hashchange won't fire
    // Directly run the test instead
    runMicrophoneTest();
}

/**
 * Download quality test report
 */
function downloadQualityReport() {
    if (!diagnosticContext || !diagnosticResults) {
        console.error('No results to download');
        return;
    }
    
    const report = {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        diagnostics: diagnosticResults,
        noiseFloor: diagnosticContext.noiseFloorDb,
        voiceLufs: diagnosticContext.voiceLufs,
        voicePeak: diagnosticContext.voicePeakDb,
        snr: diagnosticContext.snr,
        channelBalance: diagnosticContext.channelBalance
    };
    
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mic-check-report-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
    
    // Check sample collection integrity
    const integrity = getSampleIntegrity();
    if (!integrity.isReliable) {
        console.warn(`[LUFS Integrity] Sample collection had gaps: ${integrity.gaps} gaps, max ${integrity.maxGapMs}ms, coverage ${integrity.coverage}%`);
        console.warn('[LUFS Integrity] Measurement may be less accurate due to main thread lag. For production use, AudioWorklet would be needed.');
    } else {
        console.log(`[LUFS Integrity] Sample collection OK: coverage ${integrity.coverage}%, no gaps detected`);
    }
    
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
    
    console.log('LUFS calculation result:', lufsResult, 'integrity:', integrity);
    
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

function stopLevelCheck() {
    // Stop animation loop
    if (levelCheckAnimationId) {
        cancelAnimationFrame(levelCheckAnimationId);
        levelCheckAnimationId = null;
    }
    
    resetQualityTest();
}

export {
    runMicrophoneTest,
    stopTest,
    continueWithPermissionTests,
    toggleMonitoring,
    startNoiseFloorTest,
    startVoiceLevelTest,
    testAgain,
    downloadQualityReport,
    initLevelCheck,
    startQualityTest,
    startSilenceRecording,
    goToVoiceStep,
    startVoiceRecording,
    showQualityResults,
    resetQualityTest,
    stopLevelCheck,
    downloadLevelCheckReport
};
