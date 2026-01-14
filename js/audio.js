/**
 * Audio Processing Module
 * 
 * Handles AudioContext management, RMS calculations,
 * and stereo channel analysis.
 */

import { linearToDb } from './standards.js';
import { createKWeightingFilters, LufsBlockCollector } from './lufs.js';
import { isChromiumBased, detectBrowser } from './browser.js';
import { getRmsFromAnalyser, populateDeviceDropdown } from './utils.js';

// Re-export getRmsFromAnalyser for backward compatibility
export { getRmsFromAnalyser };

/**
 * State for quality test audio
 */
export const levelCheckState = {
    noiseFloorSamples: [],
    voiceSamples: [],
    peakVoice: -Infinity,
    noiseFloorDb: null,
    voiceLufs: null,
    voicePeakDb: null,
    snr: null,
    isRunning: false,
    stream: null,
    audioContext: null,
    analyser: null,
    // K-weighted LUFS measurement (ITU-R BS.1770)
    kWeightedAnalyser: null,
    lufsCollector: null,
    channelAnalysers: [],
    channelSamples: [],
    channelBalance: null,
    agcEnabled: false,
    deviceId: null,
    deviceLabel: null,
    appliedSettings: null,
    contextSampleRate: null,
    userAgcPreference: false,
    selectedDeviceId: null
};

/**
 * Reset quality test data to initial state
 * Note: Call stopQualityAudio() first to clean up stream/context resources
 */
export function resetQualityTestData() {
    levelCheckState.noiseFloorSamples = [];
    levelCheckState.voiceSamples = [];
    levelCheckState.peakVoice = -Infinity;
    levelCheckState.noiseFloorDb = null;
    levelCheckState.voiceLufs = null;
    levelCheckState.voicePeakDb = null;
    levelCheckState.snr = null;
    levelCheckState.agcEnabled = false;
    levelCheckState.channelBalance = null;
    levelCheckState.channelSamples = [];
    levelCheckState.channelAnalysers = [];
    levelCheckState.isRunning = false;
    levelCheckState.deviceId = null;
    levelCheckState.deviceLabel = null;
    levelCheckState.appliedSettings = null;
    levelCheckState.contextSampleRate = null;
    levelCheckState.userAgcPreference = false;
    levelCheckState.selectedDeviceId = null;
    // Reset LUFS collector
    if (levelCheckState.lufsCollector) {
        levelCheckState.lufsCollector.reset();
    }
}

/**
 * Request microphone access
 * @param {object} constraints - Audio constraints
 * @returns {Promise<{success: boolean, stream?: MediaStream, error?: Error}>}
 */
export async function requestMicAccess(constraints = { audio: true }) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        return { success: true, stream };
    } catch (error) {
        return { success: false, error };
    }
}

/**
 * Ensure we have permission and device labels available.
 * Gets a temporary stream if needed, then releases it.
 * Use this before populating device dropdowns when you need labels.
 * @returns {Promise<{granted: boolean, error?: string}>}
 */
export async function ensurePermissionAndLabels() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        const hasLabels = audioInputs.some(d => d.label && d.label.length > 0);
        
        if (hasLabels) {
            return { granted: true };
        }
        
        // No labels means permission not yet granted — request it
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        return { granted: true };
    } catch (err) {
        return { granted: false, error: err.name };
    }
}

/**
 * Initialize audio for quality analysis
 * @param {boolean} agcEnabled - Whether to enable AGC
 * @param {string} deviceId - Specific device ID to use
 * @returns {Promise<boolean>} Success status
 */
export async function initQualityAudio(agcEnabled = false, deviceId = '') {
    try {
        // Clean up any existing resources first to prevent leaks
        stopQualityAudio();
        
        levelCheckState.agcEnabled = agcEnabled;
        
        const audioConstraints = {
            autoGainControl: agcEnabled,
            noiseSuppression: agcEnabled,
            echoCancellation: agcEnabled
        };
        
        if (deviceId && deviceId !== '') {
            audioConstraints.deviceId = { exact: deviceId };
        }
        
        console.log('Requesting audio with constraints:', audioConstraints);
        
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: audioConstraints
        });
        
        levelCheckState.stream = stream;
        
        // Get the track settings to see which device is being used
        const audioTrack = stream.getAudioTracks()[0];
        const settings = audioTrack.getSettings();
        
        // Store device info for display
        levelCheckState.deviceId = settings.deviceId || 'unknown';
        levelCheckState.deviceLabel = audioTrack.label || 'Unknown Microphone';
        
        // Note: Browser reports whether AGC is applied, but actual implementation
        // varies significantly between browsers, OS, and audio drivers.
        // The "applied" value may not reflect actual audio processing.
        levelCheckState.appliedSettings = {
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            autoGainControl: settings.autoGainControl,
            noiseSuppression: settings.noiseSuppression,
            echoCancellation: settings.echoCancellation,
            // Track what we requested vs what was reported
            agcRequested: agcEnabled,
            agcReported: settings.autoGainControl
        };
        
        levelCheckState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await levelCheckState.audioContext.resume();
        
        // Store sample rate from AudioContext (more reliable than track settings)
        levelCheckState.contextSampleRate = levelCheckState.audioContext.sampleRate;
        
        const source = levelCheckState.audioContext.createMediaStreamSource(stream);
        
        // Main analyser (for combined/mono signal - used for dB display)
        levelCheckState.analyser = levelCheckState.audioContext.createAnalyser();
        levelCheckState.analyser.fftSize = 4096;
        levelCheckState.analyser.smoothingTimeConstant = 0.1;
        source.connect(levelCheckState.analyser);
        
        // K-weighted signal chain for LUFS measurement (ITU-R BS.1770)
        const { preFilter, rlbFilter } = createKWeightingFilters(levelCheckState.audioContext);
        source.connect(preFilter);
        // rlbFilter is already connected to preFilter inside createKWeightingFilters
        
        // K-weighted analyser for LUFS block collection
        levelCheckState.kWeightedAnalyser = levelCheckState.audioContext.createAnalyser();
        levelCheckState.kWeightedAnalyser.fftSize = 4096;
        levelCheckState.kWeightedAnalyser.smoothingTimeConstant = 0;  // No smoothing for accurate samples
        rlbFilter.connect(levelCheckState.kWeightedAnalyser);
        
        // Initialize LUFS block collector with actual sample rate
        levelCheckState.lufsCollector = new LufsBlockCollector(levelCheckState.contextSampleRate);
        
        // Set up per-channel analysis for stereo detection
        const channelCount = levelCheckState.appliedSettings?.channelCount || 1;
        levelCheckState.channelAnalysers = [];
        levelCheckState.channelSamples = [];
        
        if (channelCount >= 2) {
            console.log('Stereo device detected - setting up per-channel analysis');
            const splitter = levelCheckState.audioContext.createChannelSplitter(2);
            source.connect(splitter);
            
            for (let i = 0; i < 2; i++) {
                const channelAnalyser = levelCheckState.audioContext.createAnalyser();
                channelAnalyser.fftSize = 4096;
                channelAnalyser.smoothingTimeConstant = 0.1;
                splitter.connect(channelAnalyser, i);
                levelCheckState.channelAnalysers.push(channelAnalyser);
                levelCheckState.channelSamples.push([]);
            }
        }
        
        console.log('Quality test using:', levelCheckState.deviceLabel);
        console.log('Settings:', levelCheckState.appliedSettings);
        console.log('AudioContext sample rate:', levelCheckState.contextSampleRate);
        console.log('Channel count:', channelCount);
        
        return true;
    } catch (error) {
        console.error('Failed to init audio:', error);
        // Clean up any partial resources on failure
        stopQualityAudio();
        return false;
    }
}

/**
 * Stop quality audio and clean up resources
 */
export function stopQualityAudio() {
    if (levelCheckState.stream) {
        levelCheckState.stream.getTracks().forEach(t => t.stop());
        levelCheckState.stream = null;
    }
    if (levelCheckState.audioContext) {
        levelCheckState.audioContext.close();
        levelCheckState.audioContext = null;
    }
    levelCheckState.analyser = null;
    levelCheckState.kWeightedAnalyser = null;
    levelCheckState.lufsCollector = null;
    levelCheckState.channelAnalysers = [];
}


/**
 * Sample each channel separately for stereo analysis
 */
export function sampleChannels() {
    if (levelCheckState.channelAnalysers && levelCheckState.channelAnalysers.length >= 2) {
        for (let i = 0; i < levelCheckState.channelAnalysers.length; i++) {
            const rms = getRmsFromAnalyser(levelCheckState.channelAnalysers[i]);
            levelCheckState.channelSamples[i].push(rms);
        }
    }
}

/**
 * Collect K-weighted samples for LUFS measurement
 * Call this during voice recording to accumulate samples into blocks
 */
export function collectKWeightedSamples() {
    if (!levelCheckState.kWeightedAnalyser || !levelCheckState.lufsCollector) {
        return;
    }
    
    const bufferLength = levelCheckState.kWeightedAnalyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    levelCheckState.kWeightedAnalyser.getFloatTimeDomainData(dataArray);
    
    levelCheckState.lufsCollector.addSamples(dataArray);
}

/**
 * Analyze channel balance after recording
 * @returns {object|null} Channel balance analysis or null if mono
 */
export function analyzeChannelBalance() {
    if (!levelCheckState.channelSamples || levelCheckState.channelSamples.length < 2) {
        return null; // Mono device, no channel analysis needed
    }
    
    const ch1Samples = levelCheckState.channelSamples[0];
    const ch2Samples = levelCheckState.channelSamples[1];
    
    if (ch1Samples.length === 0 || ch2Samples.length === 0) {
        return null;
    }
    
    // Calculate average RMS for each channel
    const ch1Avg = ch1Samples.reduce((a, b) => a + b, 0) / ch1Samples.length;
    const ch2Avg = ch2Samples.reduce((a, b) => a + b, 0) / ch2Samples.length;
    
    // Calculate peak for each channel
    const ch1Peak = Math.max(...ch1Samples);
    const ch2Peak = Math.max(...ch2Samples);
    
    const ch1Db = linearToDb(ch1Avg);
    const ch2Db = linearToDb(ch2Avg);
    const ch1PeakDb = linearToDb(ch1Peak);
    const ch2PeakDb = linearToDb(ch2Peak);
    
    // Calculate imbalance
    const imbalanceDb = Math.abs(ch1Db - ch2Db);
    
    // Determine which channel is louder
    const louderChannel = ch1Db > ch2Db ? 'left' : 'right';
    const quieterChannel = ch1Db > ch2Db ? 'right' : 'left';
    
    // Check for "dead channel" pattern:
    // - One channel is significantly quieter (>15dB difference), OR
    // - One channel is near noise floor while other has real signal
    const deadChannelThreshold = 15; // dB difference (lowered from 20)
    const noiseFloorThreshold = -42; // dBFS - if a channel is around noise floor
    const signalThreshold = -35; // dBFS - if other channel has clear signal above this
    
    let hasDeadChannel = false;
    let deadChannelSide = null;
    
    // Check for large imbalance
    if (imbalanceDb > deadChannelThreshold) {
        hasDeadChannel = true;
        deadChannelSide = ch1Db < ch2Db ? 'left' : 'right';
    }
    // Check for one channel at noise floor while other has signal
    else if ((ch1Db < noiseFloorThreshold && ch2Db > signalThreshold) ||
             (ch2Db < noiseFloorThreshold && ch1Db > signalThreshold)) {
        hasDeadChannel = true;
        deadChannelSide = ch1Db < ch2Db ? 'left' : 'right';
    }
    
    const result = {
        left: {
            averageDb: Math.round(ch1Db * 10) / 10,
            peakDb: Math.round(ch1PeakDb * 10) / 10
        },
        right: {
            averageDb: Math.round(ch2Db * 10) / 10,
            peakDb: Math.round(ch2PeakDb * 10) / 10
        },
        imbalanceDb: Math.round(imbalanceDb * 10) / 10,
        hasDeadChannel: hasDeadChannel,
        deadChannelSide: deadChannelSide,
        diagnosis: null
    };
    
    // Generate diagnosis
    if (hasDeadChannel) {
        result.diagnosis = `Stereo misconfiguration detected: ${deadChannelSide} channel is silent or very quiet. ` +
            `This causes ~6dB signal loss when the browser averages both channels. ` +
            `Your microphone may be incorrectly configured as stereo with only one active input.`;
    } else if (imbalanceDb > 6) {
        result.diagnosis = `Significant channel imbalance (${imbalanceDb.toFixed(1)} dB). ` +
            `The ${louderChannel} channel is much louder than ${quieterChannel}.`;
    }
    
    console.log('Channel balance analysis:', result);
    return result;
}

/**
 * Populate device list - does NOT trigger permission prompt
 * Shows device count if labels aren't available yet
 * @param {HTMLSelectElement} selectElement - The select element to populate
 */
export async function populateDeviceList(selectElement) {
    const isChromium = isChromiumBased();
    
    const { devices, hasLabels } = await populateDeviceDropdown(selectElement, {
        showSeparator: true,
        isChromiumBased: isChromium
    });
    
    // Debug logging
    if (hasLabels && devices.length > 0) {
        const browser = detectBrowser();
        console.log(`Device enumeration (${browser.name}, ${isChromium ? 'Chromium-based' : 'non-Chromium'}):`);
        console.log('  Devices:', devices.map(d => `${d.deviceId}: ${d.label}`));
        
        const metaDevices = devices.filter(d => 
            d.deviceId === 'default' || d.deviceId === 'communications'
        );
        const realDevices = devices.filter(d => 
            d.deviceId !== 'default' && d.deviceId !== 'communications'
        );
        
        if (isChromium && metaDevices.length >= 2) {
            const defaultLabel = metaDevices.find(d => d.deviceId === 'default')?.label || '';
            const commLabel = metaDevices.find(d => d.deviceId === 'communications')?.label || '';
            if (defaultLabel !== commLabel) {
                console.log('  ⚠️ Default and Communications devices differ:');
                console.log('     Default:', defaultLabel);
                console.log('     Communications:', commLabel);
            }
        } else if (!isChromium && realDevices.length > 0) {
            console.log('  ℹ️ First device is system default (per browser spec):', realDevices[0].label);
        }
    }
}
