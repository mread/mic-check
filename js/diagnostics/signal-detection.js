/**
 * Signal Detection Diagnostic
 * 
 * Tests whether actual audio signal is being received from the microphone.
 * This catches cases where:
 * - Permission is granted but the mic is muted/disconnected
 * - Privacy extensions are blocking audio data
 * - The microphone is not producing any signal
 * 
 * This test requires a stream to already exist in context.
 */

import { isFirefoxBased } from '../browser.js';
import { getRmsFromAnalyser } from '../utils.js';

export const diagnostic = {
    id: 'signal-detection',
    name: 'Audio Signal',
    description: 'Checks if audio is being received from the microphone',
    scope: 'device',  // Device-specific - re-run when device changes
    requiresPermission: true,
    pendingMessage: 'Waiting to check audio signal...',
    runningMessage: 'Listening for audio...',
    
    /**
     * Run the diagnostic test
     * @param {object} context - Shared context from the diagnostic runner
     * @returns {Promise<{status: string, message: string, details?: object, fix?: string}>}
     */
    async test(context) {
        const details = {
            audioContextCreated: false,
            analyserConnected: false,
            samplesCollected: 0,
            maxLevel: 0,
            avgLevel: 0,
            signalDetected: false
        };
        
        // Need a stream from the previous test
        if (!context.stream) {
            return {
                status: 'skip',
                message: 'No stream available (previous test failed)',
                details
            };
        }
        
        try {
            // Create AudioContext
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            details.audioContextCreated = true;
            
            // Resume if suspended (browsers require user interaction)
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }
            
            // Create analyser
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.3;
            
            // Connect stream to analyser
            const source = audioContext.createMediaStreamSource(context.stream);
            source.connect(analyser);
            details.analyserConnected = true;
            
            // Store in context for ongoing visualization
            context.audioContext = audioContext;
            context.analyser = analyser;
            context.source = source;
            
            // Sample audio levels for a short period
            const samples = [];
            const sampleCount = 10; // Number of samples to take
            const sampleInterval = 50; // ms between samples
            
            for (let i = 0; i < sampleCount; i++) {
                await new Promise(resolve => setTimeout(resolve, sampleInterval));
                
                // Use shared RMS function (high precision Float32Array)
                const rms = getRmsFromAnalyser(analyser);
                samples.push(rms);
            }
            
            details.samplesCollected = samples.length;
            details.maxLevel = Math.max(...samples);
            details.avgLevel = samples.reduce((a, b) => a + b, 0) / samples.length;
            
            // Threshold for "signal detected"
            // Very low threshold - we just want to confirm data is flowing
            const signalThreshold = 0.001; // About -60dB
            const silenceThreshold = 0.0001; // Complete silence / muted
            
            if (details.maxLevel > signalThreshold) {
                details.signalDetected = true;
                return {
                    status: 'pass',
                    message: 'Audio signal detected',
                    details
                };
            } else if (details.maxLevel > silenceThreshold) {
                // Very quiet but not completely silent
                return {
                    status: 'warn',
                    message: 'Very low audio level',
                    details,
                    fix: 'Your microphone is working but the signal is very quiet. ' +
                         'Try speaking louder or check your microphone gain settings.'
                };
            } else {
                // Complete silence - likely blocked or muted
                const isFirefox = isFirefoxBased();
                
                return {
                    status: 'warn',
                    message: 'No audio signal detected',
                    details,
                    fix: isFirefox 
                        ? 'Your microphone may be muted, or a privacy setting is blocking audio. ' +
                          'Check that your microphone is not muted in your OS settings. ' +
                          'Firefox-based browsers may need media.getusermedia.audio.capture.enabled set to true in about:config.'
                        : 'Your microphone may be muted or producing no signal. ' +
                          'Check that your microphone is not muted in your OS settings, ' +
                          'and try speaking or making a sound.'
                };
            }
            
        } catch (error) {
            details.error = error.message;
            
            return {
                status: 'fail',
                message: 'Audio analysis failed',
                details,
                fix: `Could not analyze audio: ${error.message}. ` +
                     'Try refreshing the page.'
            };
        }
    }
};
