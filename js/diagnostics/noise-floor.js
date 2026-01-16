/**
 * Noise Floor Diagnostic
 * 
 * Measures background noise level over 5 seconds of silence.
 * This is a USER-INITIATED test - it doesn't auto-start.
 * 
 * Requires AGC OFF for accurate measurement (AGC boosts the noise floor
 * of silent mics to around -45dB, masking true noise levels).
 * 
 * This test requires:
 * - Audio context and analyser from signal-detection
 * - User to click "Start" to begin recording
 */

import { getRmsFromAnalyser } from '../utils.js';
import { linearToDb, formatDb, getQualityRating, QUALITY_REFERENCE } from '../standards.js';

export const diagnostic = {
    id: 'noise-floor',
    name: 'Background Noise',
    description: 'Measures ambient noise level during 5 seconds of silence',
    scope: 'quality',  // Quality tests - user-initiated, run after signal detection
    requiresPermission: true,
    userInitiated: true,  // User must click to start
    pendingMessage: 'Ready — stay quiet for 5 seconds',
    runningMessage: 'Recording silence...',
    
    /**
     * Check if prerequisites are met for this test
     * @param {object} context - Shared context
     * @param {object} results - Current diagnostic results
     * @returns {boolean} True if test can run
     */
    canRun(context, results) {
        // Requires signal-detection to have passed
        return results['signal-detection']?.status === 'pass' && 
               context.analyser && 
               context.audioContext;
    },
    
    /**
     * Run the diagnostic test
     * This measures noise floor over 5 seconds
     * 
     * @param {object} context - Shared context from the diagnostic runner
     * @param {object} options - Test options
     * @param {function} options.onProgress - Called with progress updates {elapsed, remaining, level}
     * @returns {Promise<{status: string, message: string, details?: object}>}
     */
    async test(context, options = {}) {
        const { onProgress } = options;
        
        const details = {
            samples: [],
            noiseFloorDb: null,
            duration: 5000,
            rating: null
        };
        
        if (!context.analyser || !context.audioContext) {
            return {
                status: 'skip',
                message: 'No audio context available',
                details
            };
        }
        
        // Need to reinitialize stream with AGC OFF for accurate noise floor
        // The existing stream may have AGC on
        try {
            // Stop existing stream and clear reference
            if (context.stream) {
                context.stream.getTracks().forEach(t => t.stop());
                context.stream = null;
            }
            
            // Get new stream with AGC OFF
            const constraints = {
                audio: {
                    deviceId: context.selectedDeviceId ? { exact: context.selectedDeviceId } : undefined,
                    autoGainControl: false,
                    noiseSuppression: false,
                    echoCancellation: false
                }
            };
            
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            context.stream = stream;
            
            // Reconnect to audio context
            if (context.source) {
                try { context.source.disconnect(); } catch (e) { /* ignore */ }
            }
            context.source = context.audioContext.createMediaStreamSource(stream);
            context.source.connect(context.analyser);
            
            // Store that we're running with processing off
            context.processingOff = true;
            
        } catch (error) {
            // Stream is now stopped - mark context accordingly
            context.stream = null;
            context.source = null;
            return {
                status: 'fail',
                message: 'Could not configure microphone for noise test',
                details: { ...details, error: error.message }
            };
        }
        
        // Collect samples for 5 seconds
        const duration = 5000;
        const sampleInterval = 50; // 50ms between samples = 100 samples
        const startTime = Date.now();
        const samples = [];
        
        while (Date.now() - startTime < duration) {
            const rms = getRmsFromAnalyser(context.analyser);
            const db = linearToDb(rms);
            samples.push(rms);
            
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
        
        // Calculate noise floor from quietest half of samples
        // This filters out any accidental sounds
        const sorted = [...samples].sort((a, b) => a - b);
        const quietHalf = sorted.slice(0, Math.floor(sorted.length / 2));
        const avgNoise = quietHalf.length > 0 
            ? quietHalf.reduce((a, b) => a + b, 0) / quietHalf.length 
            : 0;
        // Clamp to a reasonable minimum to avoid -Infinity from log10(0)
        const noiseFloorDb = avgNoise > 0 ? linearToDb(avgNoise) : -100;
        
        details.samples = samples;
        details.noiseFloorDb = noiseFloorDb;
        
        // Get rating
        const rating = getQualityRating(noiseFloorDb, QUALITY_REFERENCE.noiseFloor, false);
        details.rating = rating;
        
        // Store in context for voice level test
        context.noiseFloorDb = noiseFloorDb;
        context.noiseFloorRating = rating;
        
        // Generate result message
        let message, status;
        if (rating === 'excellent' || rating === 'good') {
            status = 'pass';
            message = `${formatDb(noiseFloorDb)} — Quiet environment`;
        } else if (rating === 'acceptable') {
            status = 'pass';
            message = `${formatDb(noiseFloorDb)} — Some background noise`;
        } else {
            status = 'warn';
            message = `${formatDb(noiseFloorDb)} — High background noise`;
        }
        
        return {
            status,
            message,
            details,
            fix: rating === 'poor' 
                ? 'Try moving to a quieter location or reducing ambient noise sources.'
                : undefined
        };
    }
};
