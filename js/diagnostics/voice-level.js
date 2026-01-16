/**
 * Voice Level Diagnostic
 * 
 * Measures voice loudness (LUFS), peak level, and signal-to-noise ratio
 * over 10 seconds of speech. Also detects stereo misconfiguration issues.
 * 
 * This is a USER-INITIATED test - it doesn't auto-start.
 * User should read the rainbow passage at their normal speaking volume.
 * 
 * This test requires:
 * - Noise floor measurement from noise-floor diagnostic
 * - Audio context from signal-detection
 */

import { getRmsFromAnalyser } from '../utils.js';
import { linearToDb, formatDb, formatLufs, getQualityRating, QUALITY_REFERENCE, AGC_REFERENCE } from '../standards.js';
import { createKWeightingFilters, LufsBlockCollector, calculateGatedLufs } from '../lufs.js';

export const diagnostic = {
    id: 'voice-level',
    name: 'Voice Level',
    description: 'Measures voice loudness and checks for stereo issues',
    scope: 'quality',  // Quality tests - user-initiated
    requiresPermission: true,
    userInitiated: true,  // User must click to start
    pendingMessage: 'Ready — speak for 10 seconds',
    runningMessage: 'Recording voice...',
    
    /**
     * Check if prerequisites are met for this test
     * @param {object} context - Shared context
     * @param {object} results - Current diagnostic results
     * @returns {boolean} True if test can run
     */
    canRun(context, results) {
        // Requires noise-floor to have completed
        return results['noise-floor']?.status !== 'pending' && 
               results['noise-floor']?.status !== 'skip' &&
               context.analyser && 
               context.audioContext &&
               typeof context.noiseFloorDb === 'number';
    },
    
    /**
     * Run the diagnostic test
     * This measures voice level over 10 seconds
     * 
     * @param {object} context - Shared context from the diagnostic runner
     * @param {object} options - Test options
     * @param {function} options.onProgress - Called with progress updates
     * @returns {Promise<{status: string, message: string, details?: object}>}
     */
    async test(context, options = {}) {
        const { onProgress } = options;
        
        const details = {
            lufs: null,
            peakDb: null,
            snr: null,
            channelBalance: null,
            duration: 10000,
            rating: null
        };
        
        if (!context.analyser || !context.audioContext) {
            return {
                status: 'skip',
                message: 'No audio context available',
                details
            };
        }
        
        const audioContext = context.audioContext;
        const sampleRate = audioContext.sampleRate;
        
        // Set up K-weighting for LUFS measurement
        const { preFilter, rlbFilter } = createKWeightingFilters(audioContext);
        const kWeightedAnalyser = audioContext.createAnalyser();
        kWeightedAnalyser.fftSize = 2048;
        kWeightedAnalyser.smoothingTimeConstant = 0;
        
        // Connect: source -> preFilter -> rlbFilter -> kWeightedAnalyser
        if (context.source) {
            context.source.connect(preFilter);
            rlbFilter.connect(kWeightedAnalyser);
        }
        
        // Set up channel splitting for stereo analysis
        const channelSplitter = audioContext.createChannelSplitter(2);
        const channelAnalysers = [];
        const channelSamples = [[], []];
        
        // Get track settings to check if stereo
        const trackSettings = context.stream?.getAudioTracks()[0]?.getSettings();
        const channelCount = trackSettings?.channelCount || 1;
        const isStereo = channelCount >= 2;
        
        if (isStereo && context.source) {
            context.source.connect(channelSplitter);
            
            for (let i = 0; i < 2; i++) {
                const analyser = audioContext.createAnalyser();
                analyser.fftSize = 2048;
                analyser.smoothingTimeConstant = 0.3;
                channelSplitter.connect(analyser, i);
                channelAnalysers.push(analyser);
            }
        }
        
        // LUFS block collector
        const lufsCollector = new LufsBlockCollector(sampleRate);
        
        // Tracking variables
        let peakRms = 0;
        const voiceSamples = [];
        
        // Collect samples for 10 seconds
        const duration = 10000;
        const sampleInterval = 50;
        const startTime = Date.now();
        
        while (Date.now() - startTime < duration) {
            // Get main RMS
            const rms = getRmsFromAnalyser(context.analyser);
            const db = linearToDb(rms);
            voiceSamples.push(rms);
            
            if (rms > peakRms) {
                peakRms = rms;
            }
            
            // Sample K-weighted for LUFS
            const kWeightedBuffer = new Float32Array(kWeightedAnalyser.fftSize);
            kWeightedAnalyser.getFloatTimeDomainData(kWeightedBuffer);
            lufsCollector.addSamples(kWeightedBuffer);
            
            // Sample channels for stereo analysis
            if (isStereo) {
                for (let i = 0; i < channelAnalysers.length; i++) {
                    const chRms = getRmsFromAnalyser(channelAnalysers[i]);
                    channelSamples[i].push(chRms);
                }
            }
            
            if (onProgress) {
                const elapsed = Date.now() - startTime;
                onProgress({
                    elapsed,
                    remaining: Math.max(0, duration - elapsed),
                    remainingSeconds: Math.ceil((duration - elapsed) / 1000),
                    level: rms,
                    levelDb: db
                });
            }
            
            await new Promise(resolve => setTimeout(resolve, sampleInterval));
        }
        
        // Calculate LUFS
        const blocks = lufsCollector.getBlocks();
        const lufsResult = calculateGatedLufs(blocks);
        const lufs = lufsResult.lufs;
        
        // Calculate peak
        const peakDb = linearToDb(peakRms);
        
        // Calculate SNR
        const snr = (lufs !== null && context.noiseFloorDb !== null) 
            ? lufs - context.noiseFloorDb 
            : null;
        
        // Analyze channel balance for stereo issues
        let channelBalance = null;
        if (isStereo && channelSamples[0].length > 0 && channelSamples[1].length > 0) {
            channelBalance = analyzeChannelBalanceFromSamples(channelSamples);
        }
        
        // Store results
        details.lufs = lufs;
        details.peakDb = peakDb;
        details.snr = snr;
        details.channelBalance = channelBalance;
        
        // Store in context for summary
        context.voiceLufs = lufs;
        context.voicePeakDb = peakDb;
        context.snr = snr;
        context.channelBalance = channelBalance;
        
        // Determine rating - use AGC reference since processing is on by default
        // (noise floor test ran with processing off, but user's normal use case has it on)
        let lufsRating;
        if (lufs >= AGC_REFERENCE.lufs.good) {
            lufsRating = 'good';
        } else if (lufs >= AGC_REFERENCE.lufs.acceptable) {
            lufsRating = 'marginal';
        } else {
            lufsRating = 'too-quiet';
        }
        
        const snrRating = snr !== null ? getQualityRating(snr, QUALITY_REFERENCE.snr, true) : null;
        
        details.rating = lufsRating;
        details.snrRating = snrRating;
        
        // Check for stereo issue (most impactful problem)
        const hasStereoIssue = channelBalance?.hasDeadChannel;
        
        // Generate result
        let status, message;
        
        if (hasStereoIssue) {
            status = 'warn';
            message = `${formatLufs(lufs)} — Stereo issue detected`;
        } else if (lufsRating === 'good') {
            status = 'pass';
            message = `${formatLufs(lufs)} — Good level`;
        } else if (lufsRating === 'marginal') {
            status = 'pass';
            message = `${formatLufs(lufs)} — Acceptable`;
        } else {
            status = 'warn';
            message = `${formatLufs(lufs)} — Too quiet`;
        }
        
        // Cleanup K-weighting nodes
        try {
            preFilter.disconnect();
            rlbFilter.disconnect();
            kWeightedAnalyser.disconnect();
            if (isStereo) {
                channelSplitter.disconnect();
                channelAnalysers.forEach(a => a.disconnect());
            }
        } catch (e) { /* ignore cleanup errors */ }
        
        return {
            status,
            message,
            details,
            stereoIssue: hasStereoIssue,
            fix: hasStereoIssue 
                ? 'Stereo configuration issue detected. See fix instructions below.'
                : (lufsRating === 'too-quiet' 
                    ? 'Try moving closer to the microphone or increasing system mic gain.'
                    : undefined)
        };
    }
};

/**
 * Analyze channel balance from collected samples
 * @param {Array<Array<number>>} channelSamples - [leftSamples, rightSamples]
 * @returns {object} Channel balance analysis
 */
function analyzeChannelBalanceFromSamples(channelSamples) {
    const ch1Samples = channelSamples[0];
    const ch2Samples = channelSamples[1];
    
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
    
    // Check for "dead channel" pattern
    const deadChannelThreshold = 15; // dB difference
    const noiseFloorThreshold = -42; // dBFS
    const signalThreshold = -35; // dBFS
    
    let hasDeadChannel = false;
    let deadChannelSide = null;
    
    if (imbalanceDb > deadChannelThreshold) {
        hasDeadChannel = true;
        deadChannelSide = ch1Db < ch2Db ? 'left' : 'right';
    } else if ((ch1Db < noiseFloorThreshold && ch2Db > signalThreshold) ||
               (ch2Db < noiseFloorThreshold && ch1Db > signalThreshold)) {
        hasDeadChannel = true;
        deadChannelSide = ch1Db < ch2Db ? 'left' : 'right';
    }
    
    return {
        left: {
            averageDb: Math.round(ch1Db * 10) / 10,
            peakDb: Math.round(ch1PeakDb * 10) / 10
        },
        right: {
            averageDb: Math.round(ch2Db * 10) / 10,
            peakDb: Math.round(ch2PeakDb * 10) / 10
        },
        imbalanceDb: Math.round(imbalanceDb * 10) / 10,
        hasDeadChannel,
        deadChannelSide
    };
}
