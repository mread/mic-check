/**
 * Audio Processing Module
 * 
 * Handles AudioContext management, RMS calculations,
 * and stereo channel analysis.
 */

import { linearToDb } from './standards.js';

/**
 * State for quality test audio
 */
export const qualityTestData = {
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
    channelAnalysers: [],
    channelSamples: [],
    channelBalance: null,
    agcEnabled: false,
    deviceId: null,
    deviceLabel: null,
    appliedSettings: null,
    contextSampleRate: null
};

/**
 * Reset quality test data to initial state
 * Note: Call stopQualityAudio() first to clean up stream/context resources
 */
export function resetQualityTestData() {
    qualityTestData.noiseFloorSamples = [];
    qualityTestData.voiceSamples = [];
    qualityTestData.peakVoice = -Infinity;
    qualityTestData.noiseFloorDb = null;
    qualityTestData.voiceLufs = null;
    qualityTestData.voicePeakDb = null;
    qualityTestData.snr = null;
    qualityTestData.agcEnabled = false;
    qualityTestData.channelBalance = null;
    qualityTestData.channelSamples = [];
    qualityTestData.channelAnalysers = [];
    qualityTestData.isRunning = false;
    qualityTestData.deviceId = null;
    qualityTestData.deviceLabel = null;
    qualityTestData.appliedSettings = null;
    qualityTestData.contextSampleRate = null;
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
 * Initialize audio for quality analysis
 * @param {boolean} agcEnabled - Whether to enable AGC
 * @param {string} deviceId - Specific device ID to use
 * @returns {Promise<boolean>} Success status
 */
export async function initQualityAudio(agcEnabled = false, deviceId = '') {
    try {
        // Clean up any existing resources first to prevent leaks
        stopQualityAudio();
        
        qualityTestData.agcEnabled = agcEnabled;
        
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
        
        qualityTestData.stream = stream;
        
        // Get the track settings to see which device is being used
        const audioTrack = stream.getAudioTracks()[0];
        const settings = audioTrack.getSettings();
        
        // Store device info for display
        qualityTestData.deviceId = settings.deviceId || 'unknown';
        qualityTestData.deviceLabel = audioTrack.label || 'Unknown Microphone';
        qualityTestData.appliedSettings = {
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            autoGainControl: settings.autoGainControl,
            noiseSuppression: settings.noiseSuppression,
            echoCancellation: settings.echoCancellation
        };
        
        qualityTestData.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await qualityTestData.audioContext.resume();
        
        // Store sample rate from AudioContext (more reliable than track settings)
        qualityTestData.contextSampleRate = qualityTestData.audioContext.sampleRate;
        
        const source = qualityTestData.audioContext.createMediaStreamSource(stream);
        
        // Main analyser (for combined/mono signal)
        qualityTestData.analyser = qualityTestData.audioContext.createAnalyser();
        qualityTestData.analyser.fftSize = 4096;
        qualityTestData.analyser.smoothingTimeConstant = 0.1;
        source.connect(qualityTestData.analyser);
        
        // Set up per-channel analysis for stereo detection
        const channelCount = qualityTestData.appliedSettings?.channelCount || 1;
        qualityTestData.channelAnalysers = [];
        qualityTestData.channelSamples = [];
        
        if (channelCount >= 2) {
            console.log('Stereo device detected - setting up per-channel analysis');
            const splitter = qualityTestData.audioContext.createChannelSplitter(2);
            source.connect(splitter);
            
            for (let i = 0; i < 2; i++) {
                const channelAnalyser = qualityTestData.audioContext.createAnalyser();
                channelAnalyser.fftSize = 4096;
                channelAnalyser.smoothingTimeConstant = 0.1;
                splitter.connect(channelAnalyser, i);
                qualityTestData.channelAnalysers.push(channelAnalyser);
                qualityTestData.channelSamples.push([]);
            }
        }
        
        console.log('Quality test using:', qualityTestData.deviceLabel);
        console.log('Settings:', qualityTestData.appliedSettings);
        console.log('AudioContext sample rate:', qualityTestData.contextSampleRate);
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
    if (qualityTestData.stream) {
        qualityTestData.stream.getTracks().forEach(t => t.stop());
        qualityTestData.stream = null;
    }
    if (qualityTestData.audioContext) {
        qualityTestData.audioContext.close();
        qualityTestData.audioContext = null;
    }
    qualityTestData.analyser = null;
    qualityTestData.channelAnalysers = [];
}

/**
 * Get RMS value from an analyser node
 * @param {AnalyserNode} analyser - The analyser to read from (defaults to main)
 * @returns {number} RMS value (0 to 1)
 */
export function getRmsFromAnalyser(analyser) {
    const targetAnalyser = analyser || qualityTestData.analyser;
    if (!targetAnalyser) return 0;
    
    const bufferLength = targetAnalyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    targetAnalyser.getByteTimeDomainData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
        const sample = (dataArray[i] - 128) / 128;
        sum += sample * sample;
    }
    return Math.sqrt(sum / bufferLength);
}

/**
 * Sample each channel separately for stereo analysis
 */
export function sampleChannels() {
    if (qualityTestData.channelAnalysers && qualityTestData.channelAnalysers.length >= 2) {
        for (let i = 0; i < qualityTestData.channelAnalysers.length; i++) {
            const rms = getRmsFromAnalyser(qualityTestData.channelAnalysers[i]);
            qualityTestData.channelSamples[i].push(rms);
        }
    }
}

/**
 * Analyze channel balance after recording
 * @returns {object|null} Channel balance analysis or null if mono
 */
export function analyzeChannelBalance() {
    if (!qualityTestData.channelSamples || qualityTestData.channelSamples.length < 2) {
        return null; // Mono device, no channel analysis needed
    }
    
    const ch1Samples = qualityTestData.channelSamples[0];
    const ch2Samples = qualityTestData.channelSamples[1];
    
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
 * Populate device list for quality analysis
 * @param {HTMLSelectElement} selectElement - The select element to populate
 */
export async function populateDeviceList(selectElement) {
    if (!selectElement) return;
    
    try {
        // First request permission to get full device list
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach(t => t.stop());
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        
        selectElement.innerHTML = '';
        
        if (audioInputs.length === 0) {
            selectElement.innerHTML = '<option value="">No microphones found</option>';
            return;
        }
        
        audioInputs.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Microphone ${index + 1}`;
            selectElement.appendChild(option);
        });
        
        console.log('Available microphones:', audioInputs.map(d => d.label));
    } catch (error) {
        console.error('Failed to get device list:', error);
        selectElement.innerHTML = '<option value="">Permission needed - click Begin to grant</option>';
    }
}
