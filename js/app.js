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
        statusEl.innerHTML = `
            <div class="status-card success">
                <span class="status-icon">🎤</span>
                <div class="status-text">
                    <div class="status-title">Microphone connected!</div>
                    <div class="status-detail">Speak or make a sound to see the audio level</div>
                </div>
            </div>
        `;
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
        
        let maxLevel = 0;
        let frameCount = 0;
        
        function update() {
            if (!audioContext || audioContext.state === 'closed') {
                console.log('AudioContext closed, stopping meter');
                return;
            }
            
            animationId = requestAnimationFrame(update);
            
            analyser.getByteTimeDomainData(dataArray);
            
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
            
            barEl.style.width = `${level}%`;
            textEl.textContent = `${Math.round(level)}%`;
            
            if (level > maxLevel) maxLevel = level;
            
            if (level > 5 && !audioDetected && resultEl) {
                audioDetected = true;
                resultEl.style.display = 'flex';
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
    document.getElementById('quick-level-bar').style.width = '0%';
    document.getElementById('quick-level-text').textContent = '0%';
    document.getElementById('quick-test-status').innerHTML = '';
}

// ============================================
// Privacy Check
// ============================================
async function runPrivacyCheck() {
    const statusEl = document.getElementById('privacy-permission-status');
    const resultsEl = document.getElementById('privacy-results');
    
    statusEl.innerHTML = `
        <div class="status-card info">
            <span class="status-icon">⏳</span>
            <div class="status-text">
                <div class="status-title">Checking permission status...</div>
            </div>
        </div>
    `;
    
    const perm = await checkPermission();
    
    const stateInfo = {
        'granted': { icon: '🟢', title: 'Permission GRANTED', detail: 'This website currently has permission to access your microphone.', class: 'success' },
        'denied': { icon: '🔴', title: 'Permission DENIED', detail: 'You have blocked microphone access for this website.', class: 'error' },
        'prompt': { icon: '🟡', title: 'Permission not yet requested', detail: 'The browser will ask before granting any microphone access.', class: 'warning' },
        'unknown': { icon: '❓', title: 'Cannot check permissions', detail: 'Your browser doesn\'t support the Permissions API.', class: 'info' }
    };
    
    const info = stateInfo[perm.state] || stateInfo['unknown'];
    
    statusEl.innerHTML = `
        <div class="status-card ${info.class}">
            <span class="status-icon">${info.icon}</span>
            <div class="status-text">
                <div class="status-title">${info.title}</div>
                <div class="status-detail">${info.detail}</div>
            </div>
        </div>
    `;
    
    let deviceInfo = { count: 0, hasLabels: false };
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        deviceInfo.count = mics.length;
        deviceInfo.hasLabels = mics.some(d => d.label && d.label.length > 0);
    } catch (e) {}
    
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = `
        <div class="info-box">
            <h4>📊 What This Website Can See</h4>
            <table class="info-table">
                <tr><th>Information</th><th>Visible?</th></tr>
                <tr><td>Number of microphones</td><td>${deviceInfo.count > 0 ? `Yes (${deviceInfo.count} found)` : 'No'}</td></tr>
                <tr><td>Microphone names/brands</td><td>${deviceInfo.hasLabels ? '✅ Yes' : '❌ No (protected)'}</td></tr>
                <tr><td>Audio from your mic</td><td>${perm.state === 'granted' ? '⚠️ If actively requested' : '❌ No'}</td></tr>
                <tr><td>Background listening</td><td>❌ Not possible in browsers</td></tr>
            </table>
        </div>
        ${perm.state === 'granted' ? `
        <div class="info-box" style="background: var(--warning-light); border: 1px solid var(--warning);">
            <h4>⚠️ You've granted microphone access</h4>
            <p>This means this website can request your microphone when you're on this page. To revoke access:</p>
            <ul>
                <li>Click the lock/info icon in your browser's address bar</li>
                <li>Find "Microphone" and change it to "Block" or "Ask"</li>
            </ul>
        </div>
        ` : ''}
    `;
    
    populateResetInstructions();
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
    
    document.getElementById('ts-step-1').classList.add('complete');
    document.getElementById('ts-step-2').classList.add('active');
    
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
    
    document.getElementById('ts-step-2').classList.add('complete');
    document.getElementById('ts-step-3').classList.add('active');
    
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
    
    document.getElementById('ts-step-3').classList.add('complete');
    document.getElementById('ts-step-4').classList.add('active');
    
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
        document.getElementById('ts-step-4').classList.add('complete');
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
    
    if (!isFirefoxBased()) return;
    
    containerEl.insertAdjacentHTML('afterend', getLowVolumeWarningHtml());
    
    document.getElementById('btn-try-agc')?.addEventListener('click', handleAgcRetry);
}

async function handleAgcRetry() {
    const btn = document.getElementById('btn-try-agc');
    const warningPanel = btn.closest('.info-box');
    btn.disabled = true;
    btn.textContent = '⏳ Restarting...';
    
    stopStream();
    audioDetected = false;
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                autoGainControl: { ideal: true },
                noiseSuppression: { ideal: true },
                echoCancellation: { ideal: true }
            }
        });
        currentStream = stream;
        
        const track = stream.getAudioTracks()[0];
        const settings = track.getSettings();
        
        const barId = 'quick-level-bar';
        const textId = 'quick-level-text';
        if (document.getElementById(barId)) {
            await startLevelMeter(barId, textId, null);
        }
        
        if (warningPanel) {
            warningPanel.outerHTML = `
                <div class="info-box" style="margin-top: 1rem; background: #e7f3ff; border: 1px solid #2196f3;">
                    <h4 style="margin-bottom: 0.5rem;">ℹ️ AGC is enabled, but Firefox boosts less than Chrome</h4>
                    <p>Firefox confirms AGC is active, but its implementation is more conservative.</p>
                </div>
            `;
        }
        
    } catch (error) {
        btn.textContent = '❌ Failed - ' + error.message;
        btn.disabled = false;
    }
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
    
    const agcEnabled = document.getElementById('agc-toggle')?.checked || false;
    const deviceSelect = document.getElementById('quality-device-select');
    const deviceId = deviceSelect?.value || '';
    
    const success = await initQualityAudio(agcEnabled, deviceId);
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
    
    updateQualityDeviceInfo();
    
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
        document.getElementById('silence-level-bar').style.width = `${percent}%`;
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

function updateQualityDeviceInfo() {
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
    
    settingsParts.push(`AGC: ${settings.autoGainControl ? 'On' : 'Off'}`);
    settingsParts.push(`Noise Supp: ${settings.noiseSuppression ? 'On' : 'Off'}`);
    
    settingsEl.textContent = settingsParts.join(' • ');
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
    const btn = document.getElementById('btn-start-voice');
    btn.style.display = 'none';
    
    document.getElementById('voice-visualizer').style.display = 'block';
    
    if (!qualityTestData.analyser) {
        const agcEnabled = document.getElementById('agc-toggle')?.checked || false;
        const deviceSelect = document.getElementById('quality-device-select');
        const deviceId = deviceSelect?.value || '';
        const success = await initQualityAudio(agcEnabled, deviceId);
        if (!success) return;
    }
    
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
        document.getElementById('voice-level-bar').style.width = `${percent}%`;
        document.getElementById('voice-level-text').textContent = `${Math.round(percent)}%`;
        document.getElementById('voice-db-reading').textContent = formatDb(db);
        document.getElementById('voice-lufs-reading').textContent = formatLufs(lufs);
        
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
    document.getElementById('voice-snr-final').textContent = `${qualityTestData.snr.toFixed(1)} dB`;
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
    document.getElementById('btn-start-voice').style.display = 'inline-flex';
    document.getElementById('btn-show-results').style.display = 'none';
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
        showScreen('screen-quality');
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
    document.getElementById('btn-stop-quick-test')?.addEventListener('click', stopQuickTest);
    
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
