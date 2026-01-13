/**
 * Main Application Module
 * 
 * Handles UI interactions, screen navigation, and event handlers.
 * This is the entry point that coordinates all other modules.
 */

import { 
    QUALITY_REFERENCE, 
    linearToDb, 
    formatDb, 
    formatLufs, 
    rmsToApproxLufs,
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
    populateDeviceList
} from './audio.js';

import { 
    detectBrowser, 
    detectedBrowser,
    isFirefoxBased,
    checkPermission,
    getResetInstructions,
    getLowVolumeWarningHtml,
    getAudioBlockedWarningHtml
} from './browser.js';

import { 
    generateDiagnosticsReport,
    downloadDiagnosticsReport 
} from './diagnostics.js';

import { displayQualityResults } from './results.js';

// ============================================
// Utilities
// ============================================

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

// ============================================
// State
// ============================================
let currentStream = null;
let audioContext = null;
let analyser = null;
let animationId = null;
let previousScreen = 'screen-select';
let audioDetected = false;
let lowVolumeWarningShown = false;
let audioBlockedWarningShown = false;

// ============================================
// Screen Navigation
// ============================================
export function showScreen(screenId) {
    previousScreen = document.querySelector('.screen.active')?.id || 'screen-select';
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId)?.classList.add('active');
    window.scrollTo(0, 0);
}

export function goBack() {
    showScreen(previousScreen);
}

// ============================================
// Stream Management
// ============================================
function stopStream() {
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        currentStream = null;
    }
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
        analyser = null;
    }
}

// ============================================
// Quick Test
// ============================================
async function runQuickTest() {
    const statusEl = document.getElementById('quick-test-status');
    const visualizerEl = document.getElementById('quick-visualizer');
    const btnEl = document.getElementById('btn-quick-test');
    
    statusEl.innerHTML = `
        <div class="status-card info">
            <span class="status-icon">⏳</span>
            <div class="status-text">
                <div class="status-title">Requesting microphone access...</div>
                <div class="status-detail">Your browser may ask for permission</div>
            </div>
        </div>
    `;
    
    const result = await requestMicAccess();
    
    if (result.success) {
        currentStream = result.stream;
        btnEl.style.display = 'none';
        visualizerEl.style.display = 'block';
        statusEl.innerHTML = ''; // Clear the "requesting" status - meter speaks for itself
        
        // Show AGC status indicator
        const agcStatusEl = document.getElementById('quick-agc-status');
        if (agcStatusEl) {
            // Check actual AGC status from the track settings
            const track = currentStream.getAudioTracks()[0];
            const settings = track?.getSettings() || {};
            const agcOn = settings.autoGainControl !== false; // Default to true if not specified
            
            agcStatusEl.style.display = 'flex';
            agcStatusEl.className = `agc-status ${agcOn ? 'agc-on' : 'agc-off'}`;
            document.getElementById('quick-agc-icon').textContent = agcOn ? '🔊' : '🔇';
            document.getElementById('quick-agc-text').textContent = agcOn ? 'AGC: On' : 'AGC: Off';
        }
        
        await startLevelMeter('quick-level-bar', 'quick-level-text');
    } else {
        let message = 'Unknown error';
        let detail = '';
        
        if (result.error.name === 'NotAllowedError') {
            message = 'Permission denied';
            detail = 'You blocked microphone access. Check the guide below to reset.';
        } else if (result.error.name === 'NotFoundError') {
            message = 'No microphone found';
            detail = 'Your device doesn\'t have a microphone, or it\'s disabled.';
        } else if (result.error.name === 'NotReadableError') {
            message = 'Microphone is busy';
            detail = 'Another application may be using your microphone.';
        }
        
        statusEl.innerHTML = `
            <div class="status-card error">
                <span class="status-icon">❌</span>
                <div class="status-text">
                    <div class="status-title">${message}</div>
                    <div class="status-detail">${detail}</div>
                </div>
            </div>
        `;
    }
}

/**
 * Draw spectrogram - scrolling frequency visualization like Merlin Bird ID
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {Uint8Array} frequencyData - Frequency bin data from analyser
 */
function drawSpectrogram(ctx, canvas, frequencyData) {
    const width = canvas.width;
    const height = canvas.height;
    
    // Shift existing image left by 1 pixel (slower scroll effect)
    const imageData = ctx.getImageData(1, 0, width - 1, height);
    ctx.putImageData(imageData, 0, 0);
    
    // Draw new column on the right
    const barWidth = 1;
    const numBins = frequencyData.length;
    
    // Only use lower half of frequency bins (more relevant for voice)
    const usableBins = Math.floor(numBins * 0.5);
    const binHeight = height / usableBins;
    
    for (let i = 0; i < usableBins; i++) {
        const value = frequencyData[i];
        
        // Color based on intensity - dark blue/purple to cyan/green to yellow/white
        let r, g, b;
        if (value < 50) {
            // Very quiet - dark blue/black
            r = 0;
            g = 0;
            b = Math.floor(value * 1.5);
        } else if (value < 100) {
            // Quiet - blue to cyan
            const t = (value - 50) / 50;
            r = 0;
            g = Math.floor(t * 150);
            b = 80 + Math.floor(t * 100);
        } else if (value < 180) {
            // Medium - cyan to green to yellow
            const t = (value - 100) / 80;
            r = Math.floor(t * 255);
            g = 150 + Math.floor(t * 105);
            b = Math.floor(180 - t * 180);
        } else {
            // Loud - yellow to white
            const t = (value - 180) / 75;
            r = 255;
            g = 255;
            b = Math.floor(t * 255);
        }
        
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        // Draw from bottom up (low frequencies at bottom)
        const y = height - (i + 1) * binHeight;
        ctx.fillRect(width - barWidth, y, barWidth, binHeight + 1);
    }
}

async function startLevelMeter(barId, textId, resultId = 'quick-result') {
    if (!currentStream) {
        console.error('No stream available for level meter');
        return;
    }
    
    const barEl = document.getElementById(barId);
    const textEl = document.getElementById(textId);
    const resultEl = resultId ? document.getElementById(resultId) : null;
    
    if (!barEl || !textEl) {
        console.error('Level meter elements not found:', barId, textId);
        return;
    }
    
    const tracks = currentStream.getAudioTracks();
    console.log('Audio tracks:', tracks.length, tracks.map(t => ({
        label: t.label,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState
    })));
    
    if (tracks.length === 0 || tracks[0].readyState !== 'live') {
        console.error('No live audio track available');
        return;
    }
    
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('AudioContext created, state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);
        
        if (audioContext.state === 'suspended') {
            console.log('Resuming suspended AudioContext...');
            await audioContext.resume();
            console.log('AudioContext resumed, state:', audioContext.state);
        }
        
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.3;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;
        
        const source = audioContext.createMediaStreamSource(currentStream);
        
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0;
        
        source.connect(analyser);
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        console.log('Audio graph connected');
        
        const bufferLength = analyser.fftSize;
        const dataArray = new Uint8Array(bufferLength);
        
        // Spectrogram setup
        const spectrogramCanvas = document.getElementById('spectrogram-canvas');
        let spectrogramCtx = null;
        let frequencyData = null;
        if (spectrogramCanvas) {
            spectrogramCtx = spectrogramCanvas.getContext('2d');
            // Use frequency bins for spectrogram
            frequencyData = new Uint8Array(analyser.frequencyBinCount);
            // Clear canvas
            spectrogramCtx.fillStyle = '#0a0a0a';
            spectrogramCtx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height);
        }
        
        let maxLevel = 0;
        let frameCount = 0;
        
        function update() {
            if (!audioContext || audioContext.state === 'closed') {
                console.log('AudioContext closed, stopping meter');
                return;
            }
            
            animationId = requestAnimationFrame(update);
            
            analyser.getByteTimeDomainData(dataArray);
            
            // Draw spectrogram if canvas exists
            if (spectrogramCtx && frequencyData) {
                analyser.getByteFrequencyData(frequencyData);
                drawSpectrogram(spectrogramCtx, spectrogramCanvas, frequencyData);
            }
            
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                const sample = (dataArray[i] - 128) / 128;
                sum += sample * sample;
            }
            const rms = Math.sqrt(sum / bufferLength);
            const level = Math.min(100, rms * 250);
            
            frameCount++;
            if (frameCount % 60 === 0) {
                console.log('Audio level debug - RMS:', rms.toFixed(4), 'Level:', level.toFixed(1));
                
                if (frameCount >= 180 && maxLevel < 0.1) {
                    const allSilent = dataArray.every(v => v === 128);
                    if (allSilent) {
                        console.warn('Detected possible privacy.resistFingerprinting');
                        showFingerprintingWarning(barEl.parentElement);
                    }
                }
            }
            
            // Use clip-path to reveal the bar - inset from right = (100 - level)%
            barEl.style.clipPath = `inset(0 ${100 - level}% 0 0)`;
            textEl.textContent = `${Math.round(level)}%`;
            
            if (level > maxLevel) maxLevel = level;
            
            if (level > 5 && !audioDetected && resultEl) {
                audioDetected = true;
                resultEl.style.display = 'flex';
            }
            
            // Hide low volume warning if volume becomes good
            if (level > 15) {
                const lowVolumeWarning = document.getElementById('low-volume-warning');
                if (lowVolumeWarning) {
                    lowVolumeWarning.remove();
                }
            }
            
            if (frameCount === 300 && maxLevel > 0 && maxLevel < 15) {
                showLowVolumeWarning(barEl.parentElement);
            }
        }
        
        update();
        
    } catch (error) {
        console.error('Error starting level meter:', error);
    }
}

function stopQuickTest() {
    stopStream();
    audioDetected = false;
    document.getElementById('btn-quick-test').style.display = 'block';
    document.getElementById('quick-visualizer').style.display = 'none';
    document.getElementById('quick-result').style.display = 'none';
    document.getElementById('quick-level-bar').style.clipPath = 'inset(0 100% 0 0)';
    document.getElementById('quick-level-text').textContent = '0%';
    document.getElementById('quick-test-status').innerHTML = '';
    
    // Hide AGC status indicator
    const agcStatusEl = document.getElementById('quick-agc-status');
    if (agcStatusEl) agcStatusEl.style.display = 'none';
}

// ============================================
// Privacy Check
// ============================================
async function runPrivacyCheck() {
    const statusEl = document.getElementById('privacy-permission-status');
    const resultsEl = document.getElementById('privacy-results');
    const buttonEl = document.getElementById('btn-privacy-check');
    
    // Hide button while checking
    if (buttonEl) buttonEl.style.display = 'none';
    
    statusEl.innerHTML = `
        <div class="status-card info">
            <span class="status-icon">⏳</span>
            <div class="status-text">
                <div class="status-title">Checking...</div>
            </div>
        </div>
    `;
    
    const perm = await checkPermission();
    
    // Get device info to help determine actual state
    let deviceInfo = { count: 0, hasLabels: false };
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        deviceInfo.count = mics.length;
        deviceInfo.hasLabels = mics.some(d => d.label && d.label.length > 0);
    } catch (e) {}
    
    // Determine the actual state more accurately
    // If we can see device labels, permission has been granted (even if Permissions API says "prompt")
    let effectiveState = perm.state;
    if (perm.state === 'prompt' && deviceInfo.hasLabels) {
        effectiveState = 'granted'; // Labels only visible after permission granted
    }
    
    const stateInfo = {
        'granted': { 
            icon: '🟢', 
            title: 'Microphone access is allowed', 
            detail: 'You\'ve granted this site permission to use your microphone.',
            class: 'success' 
        },
        'denied': { 
            icon: '🔴', 
            title: 'Microphone access is blocked', 
            detail: 'You\'ve blocked this site from accessing your microphone.',
            class: 'error' 
        },
        'prompt': { 
            icon: '🟡', 
            title: 'Permission will be requested when needed', 
            detail: 'Your browser will ask you before any mic access.',
            class: 'warning' 
        },
        'unknown': { 
            icon: '❓', 
            title: 'Cannot determine permission status', 
            detail: 'Your browser doesn\'t support checking permissions.',
            class: 'info' 
        }
    };
    
    const info = stateInfo[effectiveState] || stateInfo['unknown'];
    
    statusEl.innerHTML = `
        <div class="status-card ${info.class}" style="margin-bottom: 1rem;">
            <span class="status-icon">${info.icon}</span>
            <div class="status-text">
                <div class="status-title">${info.title}</div>
                <div class="status-detail">${info.detail}</div>
            </div>
        </div>
    `;
    
    resultsEl.style.display = 'block';
    
    if (effectiveState === 'granted') {
        resultsEl.innerHTML = `
            <p style="margin-bottom: 1rem; color: var(--text-secondary);">
                <strong>Your mic is NOT being recorded right now.</strong> Permission just means this site <em>can</em> request access — it doesn't mean it's listening. Browsers show a recording indicator when audio is actually being captured.
            </p>
            <p style="margin-bottom: 1rem;">To revoke access, click the 🔒 icon in your address bar and change Microphone to "Block" or "Ask".</p>
        `;
    } else if (effectiveState === 'denied') {
        resultsEl.innerHTML = `
            <p style="margin-bottom: 1rem; color: var(--text-secondary);">
                No website code can access your microphone. To re-enable, click the 🔒 icon in your address bar and change Microphone to "Allow" or "Ask".
            </p>
        `;
    } else if (effectiveState === 'prompt') {
        resultsEl.innerHTML = `
            <p style="color: var(--text-secondary);">
                This is the default, privacy-respecting state. Your browser will show a permission dialog before any site can access your mic.
            </p>
        `;
    } else {
        resultsEl.innerHTML = '';
    }
    
    populateResetInstructions();
    
    // Re-show button so user can check again
    if (buttonEl) buttonEl.style.display = 'inline-flex';
}

function populateResetInstructions() {
    const browser = detectBrowser()?.name || 'your browser';
    const el = document.getElementById('reset-instructions');
    if (el) {
        el.innerHTML = getResetInstructions(browser);
    }
}

// ============================================
// Troubleshooter
// ============================================
async function runTroubleshoot() {
    const contentEl = document.getElementById('troubleshoot-content');
    const subtitleEl = document.getElementById('ts-subtitle');
    
    if (!contentEl || !subtitleEl) return;
    
    const hasMediaDevices = !!navigator.mediaDevices;
    const hasGetUserMedia = !!navigator.mediaDevices?.getUserMedia;
    const isSecure = window.isSecureContext;
    
    if (!hasMediaDevices || !hasGetUserMedia) {
        contentEl.innerHTML = `
            <div class="status-card error">
                <span class="status-icon">❌</span>
                <div class="status-text">
                    <div class="status-title">Browser doesn't support microphone access</div>
                    <div class="status-detail">Your browser is missing required APIs</div>
                </div>
            </div>
        `;
        return;
    }
    
    if (!isSecure) {
        contentEl.innerHTML = `
            <div class="status-card error">
                <span class="status-icon">🔓</span>
                <div class="status-text">
                    <div class="status-title">Not a secure connection</div>
                    <div class="status-detail">Microphone access requires HTTPS or localhost</div>
                </div>
            </div>
        `;
        return;
    }
    
    subtitleEl.textContent = 'Checking for microphones...';
    
    let devices = [];
    try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        devices = allDevices.filter(d => d.kind === 'audioinput');
    } catch (e) {}
    
    subtitleEl.textContent = 'Attempting microphone access...';
    
    contentEl.innerHTML = `
        <div class="status-card info">
            <span class="status-icon">⏳</span>
            <div class="status-text">
                <div class="status-title">Requesting microphone permission...</div>
            </div>
        </div>
    `;
    
    const result = await requestMicAccess();
    
    if (result.success) {
        currentStream = result.stream;
        
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const mics = allDevices.filter(d => d.kind === 'audioinput');
        
        subtitleEl.textContent = 'Microphone working!';
        contentEl.innerHTML = `
            <div class="status-card success">
                <span class="status-icon">✅</span>
                <div class="status-text">
                    <div class="status-title">Your microphone is working!</div>
                </div>
            </div>
            
            <div class="visualizer-container">
                <div class="visualizer-label">Audio Level — speak to verify</div>
                <div class="level-bar-container">
                    <div id="ts-level-bar" class="level-bar"></div>
                    <span id="ts-level-text" class="level-text">0%</span>
                </div>
            </div>
            
            <div class="info-box">
                <h4>🎤 Detected Microphones (${mics.length})</h4>
                ${mics.map(d => `
                    <div class="device-item">
                        <div class="device-name">${escapeHtml(d.label) || 'Unknown Device'}</div>
                    </div>
                `).join('')}
            </div>
            
            <button class="btn btn-secondary" onclick="window.MicCheck.stopStreamAndGoHome()">
                Done — Return to menu
            </button>
        `;
        
        await startLevelMeter('ts-level-bar', 'ts-level-text', null);
    } else {
        subtitleEl.textContent = 'Issue found';
        
        let diagnosis = result.error.name === 'NotAllowedError' ? 'Permission denied' :
                       result.error.name === 'NotFoundError' ? 'No microphone detected' :
                       result.error.name === 'NotReadableError' ? 'Microphone is in use' :
                       `Error: ${result.error.name}`;
        
        contentEl.innerHTML = `
            <div class="status-card error">
                <span class="status-icon">❌</span>
                <div class="status-text">
                    <div class="status-title">${diagnosis}</div>
                </div>
            </div>
            
            <button class="btn btn-primary" onclick="window.MicCheck.runTroubleshoot()">
                🔄 Try Again
            </button>
        `;
    }
}

// ============================================
// Collapsible Helpers
// ============================================
function toggleCollapsible(id, headerEl) {
    const el = document.getElementById(id);
    el.classList.toggle('open');
    const isOpen = el.classList.contains('open');
    if (headerEl) {
        headerEl.setAttribute('aria-expanded', isOpen);
    }
}

function handleCollapsibleKeydown(event, id, headerEl) {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleCollapsible(id, headerEl);
    }
}

// ============================================
// Warning Displays
// ============================================
function showLowVolumeWarning(containerEl) {
    if (lowVolumeWarningShown) return;
    lowVolumeWarningShown = true;
    
    containerEl.insertAdjacentHTML('afterend', getLowVolumeWarningHtml());
    
    document.getElementById('link-to-level-check')?.addEventListener('click', (e) => {
        e.preventDefault();
        stopStream();
        resetQualityTest(); // Reset to beginning when entering Level Check
        showScreen('screen-quality');
        const select = document.getElementById('quality-device-select');
        if (select) populateDeviceList(select);
    });
}

function showFingerprintingWarning(containerEl) {
    if (audioBlockedWarningShown) return;
    audioBlockedWarningShown = true;
    
    containerEl.insertAdjacentHTML('afterend', getAudioBlockedWarningHtml());
}

// ============================================
// Quality Analysis UI
// ============================================
async function startQualityTest() {
    document.getElementById('quality-intro').style.display = 'none';
    document.getElementById('quality-step-silence').style.display = 'block';
    document.getElementById('quality-results').style.display = 'none';
    
    resetQualityTestData();
    qualityTestData.isRunning = true;
    
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
    
    // Store user's AGC preference for voice phase, but always use AGC OFF for silence
    // This gives us the true noise floor, not the AGC-boosted noise floor
    const userAgcPreference = document.getElementById('agc-toggle')?.checked || false;
    qualityTestData.userAgcPreference = userAgcPreference;
    
    const deviceSelect = document.getElementById('quality-device-select');
    const deviceId = deviceSelect?.value || '';
    qualityTestData.selectedDeviceId = deviceId;
    
    // Always record silence with AGC OFF for accurate noise floor measurement
    const success = await initQualityAudio(false, deviceId);
    if (!success) {
        btn.style.display = 'inline-flex';
        document.getElementById('silence-visualizer').innerHTML = `
            <div class="status-card problem">
                <span class="status-icon">❌</span>
                <div class="status-text">
                    <div class="status-title">Microphone access denied</div>
                    <div class="status-detail">Please allow microphone access and try again.</div>
                </div>
            </div>
        `;
        return;
    }
    
    updateQualityDeviceInfo('silence');
    updateAgcStatusBar(false, '— measuring true noise floor');
    
    qualityTestData.noiseFloorSamples = [];
    const duration = 5000;
    const startTime = Date.now();
    
    function measure() {
        if (!qualityTestData.isRunning) return;
        
        const elapsed = Date.now() - startTime;
        const rms = getRmsFromAnalyser();
        const db = linearToDb(rms);
        
        qualityTestData.noiseFloorSamples.push(rms);
        
        const percent = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        document.getElementById('silence-level-bar').style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
        document.getElementById('silence-level-text').textContent = `${Math.round(percent)}%`;
        document.getElementById('silence-db-reading').textContent = formatDb(db);
        
        const remaining = Math.ceil((duration - elapsed) / 1000);
        document.getElementById('silence-countdown').textContent = remaining > 0 ? `${remaining}s` : '';
        
        if (elapsed >= duration) {
            finishSilenceRecording();
        } else {
            animationId = requestAnimationFrame(measure);
        }
    }
    
    measure();
}

function updateQualityDeviceInfo(phase = 'silence') {
    const infoEl = document.getElementById('quality-device-info');
    const nameEl = document.getElementById('quality-device-name');
    const settingsEl = document.getElementById('quality-device-settings');
    
    if (!infoEl || !qualityTestData.deviceLabel) return;
    
    infoEl.style.display = 'block';
    nameEl.textContent = qualityTestData.deviceLabel;
    
    const settings = qualityTestData.appliedSettings || {};
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

/**
 * Update the persistent AGC status bar
 * @param {boolean} agcOn - Whether AGC is currently on
 * @param {string} detail - Additional detail text
 */
function updateAgcStatusBar(agcOn, detail = '') {
    const bar = document.getElementById('agc-status-bar');
    const icon = document.getElementById('agc-status-icon');
    const text = document.getElementById('agc-status-text');
    const detailEl = document.getElementById('agc-status-detail');
    
    if (!bar) return;
    
    bar.style.display = 'flex';
    bar.className = `agc-status ${agcOn ? 'agc-on' : 'agc-off'}`;
    icon.textContent = agcOn ? '🔊' : '🔇';
    text.textContent = agcOn ? 'AGC: On' : 'AGC: Off';
    detailEl.textContent = detail;
}

function finishSilenceRecording() {
    const sorted = [...qualityTestData.noiseFloorSamples].sort((a, b) => a - b);
    const quietHalf = sorted.slice(0, Math.floor(sorted.length / 2));
    const avgNoise = quietHalf.length > 0 ? quietHalf.reduce((a, b) => a + b, 0) / quietHalf.length : 0;
    qualityTestData.noiseFloorDb = linearToDb(avgNoise);
    
    document.getElementById('silence-countdown').textContent = '✓ Complete';
    document.getElementById('silence-result').style.display = 'block';
    document.getElementById('silence-final-reading').textContent = formatDb(qualityTestData.noiseFloorDb);
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
    const agcEnabled = qualityTestData.userAgcPreference || false;
    const deviceId = qualityTestData.selectedDeviceId || '';
    
    const success = await initQualityAudio(agcEnabled, deviceId);
    if (!success) return;
    
    // Update device info and AGC status to show current settings
    updateQualityDeviceInfo('voice');
    updateAgcStatusBar(agcEnabled, agcEnabled ? '— automatic level adjustment' : '— raw microphone signal');
    
    qualityTestData.voiceSamples = [];
    qualityTestData.peakVoice = -Infinity;
    
    const duration = 12000;
    const startTime = Date.now();
    
    function measure() {
        if (!qualityTestData.isRunning) return;
        
        const elapsed = Date.now() - startTime;
        const rms = getRmsFromAnalyser();
        const db = linearToDb(rms);
        const lufs = rmsToApproxLufs(rms);
        
        qualityTestData.voiceSamples.push(rms);
        sampleChannels();
        if (db > qualityTestData.peakVoice) {
            qualityTestData.peakVoice = db;
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
            animationId = requestAnimationFrame(measure);
        }
    }
    
    measure();
}

function finishVoiceRecording() {
    const sorted = [...qualityTestData.voiceSamples].sort((a, b) => b - a);
    const loudPortion = sorted.slice(0, Math.floor(sorted.length * 0.3));
    const avgVoice = loudPortion.length > 0 ? loudPortion.reduce((a, b) => a + b, 0) / loudPortion.length : 0;
    
    qualityTestData.voiceLufs = rmsToApproxLufs(avgVoice);
    qualityTestData.voicePeakDb = qualityTestData.peakVoice;
    qualityTestData.snr = qualityTestData.voiceLufs - qualityTestData.noiseFloorDb;
    
    qualityTestData.channelBalance = analyzeChannelBalance();
    
    document.getElementById('voice-countdown').textContent = '✓ Complete';
    document.getElementById('voice-result').style.display = 'block';
    document.getElementById('voice-lufs-final').textContent = formatLufs(qualityTestData.voiceLufs);
    document.getElementById('voice-peak-final').textContent = formatDb(qualityTestData.voicePeakDb);
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
    
    // Hide AGC status bar
    const agcBar = document.getElementById('agc-status-bar');
    if (agcBar) agcBar.style.display = 'none';
    
    // Reset voice pre-start section
    const preStart = document.getElementById('voice-pre-start');
    if (preStart) preStart.style.display = 'block';
}

// Note: displayQualityResults is a large function that renders the results HTML.
// It's kept in index.html for now due to its template complexity.
// The function is exported but expects to be defined in the HTML.

// ============================================
// App Debug
// ============================================
async function runAppDebug() {
    const resultsEl = document.getElementById('app-debug-results');
    const btnEl = document.getElementById('btn-app-debug-start');
    
    btnEl.disabled = true;
    btnEl.textContent = '⏳ Running diagnostic...';
    
    const browser = detectBrowser();
    const perm = await checkPermission();
    
    const results = {
        browser,
        secureContext: window.isSecureContext,
        protocol: window.location.protocol,
        permission: perm,
        devices: [],
        apiSupport: {
            mediaDevices: !!navigator.mediaDevices,
            getUserMedia: !!navigator.mediaDevices?.getUserMedia,
            enumerateDevices: !!navigator.mediaDevices?.enumerateDevices,
            permissions: !!navigator.permissions?.query
        },
        micTest: null
    };
    
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        results.devices = devices.filter(d => d.kind === 'audioinput');
    } catch (e) {
        results.deviceError = e.message;
    }
    
    const micResult = await requestMicAccess();
    if (micResult.success) {
        results.micTest = {
            success: true,
            track: micResult.stream.getAudioTracks()[0]?.getSettings()
        };
        micResult.stream.getTracks().forEach(t => t.stop());
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        results.devices = devices.filter(d => d.kind === 'audioinput');
    } else {
        results.micTest = {
            success: false,
            error: micResult.error.name,
            message: micResult.error.message
        };
    }
    
    btnEl.disabled = false;
    btnEl.textContent = '🔬 Run Full Diagnostic';
    
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = `
        <h3 style="margin: 1.5rem 0 1rem;">Diagnostic Results</h3>
        <div class="status-card ${results.micTest?.success ? 'success' : 'error'}">
            <span class="status-icon">${results.micTest?.success ? '✅' : '❌'}</span>
            <div class="status-text">
                <div class="status-title">${results.micTest?.success ? 'Microphone works' : 'Microphone access failed'}</div>
            </div>
        </div>
        <div class="info-box">
            <h4>📋 Configuration</h4>
            <table class="info-table">
                <tr><td>Browser</td><td>${results.browser.name}</td></tr>
                <tr><td>Microphones</td><td>${results.devices.length}</td></tr>
                <tr><td>Permission</td><td>${results.permission.state}</td></tr>
                <tr><td>Secure context</td><td>${results.secureContext ? '✅' : '❌'}</td></tr>
            </table>
        </div>
    `;
}

// ============================================
// Initialization
// ============================================
function setupListeners() {
    // Homepage navigation buttons
    document.getElementById('btn-home-test')?.addEventListener('click', () => {
        showScreen('screen-quick-test');
        runQuickTest();
    });
    document.getElementById('btn-home-quality')?.addEventListener('click', () => {
        resetQualityTest(); // Reset to beginning when entering Level Check
        showScreen('screen-quality');
        // Auto-load microphone list when entering Level Check
        const select = document.getElementById('quality-device-select');
        if (select) {
            populateDeviceList(select);
        }
    });
    
    // Journey cards
    document.querySelectorAll('.journey-card[data-journey]').forEach(card => {
        card.addEventListener('click', () => {
            const journey = card.dataset.journey;
            switch (journey) {
                case 'troubleshoot':
                    showScreen('screen-troubleshoot');
                    runTroubleshoot();
                    break;
                case 'privacy':
                    showScreen('screen-privacy');
                    runPrivacyCheck();
                    break;
                case 'app-debug':
                    showScreen('screen-app-debug');
                    break;
            }
        });
    });
    
    // Quick test
    document.getElementById('btn-quick-test')?.addEventListener('click', runQuickTest);
    document.getElementById('btn-quick-stop')?.addEventListener('click', stopQuickTest);
    
    // Privacy check
    document.getElementById('btn-privacy-check')?.addEventListener('click', runPrivacyCheck);
    
    // Troubleshooter
    document.getElementById('btn-ts-check-support')?.addEventListener('click', runTroubleshoot);
    
    // App debug
    document.getElementById('btn-app-debug-start')?.addEventListener('click', runAppDebug);
    
    // Quality analysis
    document.getElementById('btn-quality-start')?.addEventListener('click', startQualityTest);
    document.getElementById('btn-start-silence')?.addEventListener('click', startSilenceRecording);
    document.getElementById('btn-next-to-voice')?.addEventListener('click', goToVoiceStep);
    document.getElementById('btn-start-voice')?.addEventListener('click', startVoiceRecording);
    document.getElementById('btn-show-results')?.addEventListener('click', showQualityResults);
    
    // Device selector
    document.getElementById('btn-refresh-devices')?.addEventListener('click', () => {
        const select = document.getElementById('quality-device-select');
        populateDeviceList(select);
    });
    document.getElementById('quality-device-select')?.addEventListener('focus', function() {
        if (this.options.length <= 1 && this.options[0]?.value === '') {
            populateDeviceList(this);
        }
    });
}

export function init() {
    detectBrowser();
    setupListeners();
    
    if (window.location.protocol === 'file:') {
        console.warn('Running via file:// - some features may not work correctly');
    }
}

// ============================================
// Global API (for onclick handlers in HTML)
// ============================================
window.MicCheck = {
    showScreen,
    goBack,
    stopQuickTest,
    runTroubleshoot,
    runQuickTest,
    runPrivacyCheck,
    runAppDebug,
    startQualityTest,
    resetQualityTest,
    downloadDiagnosticsReport,
    toggleCollapsible,
    handleCollapsibleKeydown,
    stopStreamAndGoHome: () => { stopStream(); showScreen('screen-select'); },
    // Expose for displayQualityResults in HTML
    qualityTestData,
    QUALITY_REFERENCE,
    formatDb,
    formatLufs,
    getQualityRating
};

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
