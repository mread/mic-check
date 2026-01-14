/**
 * Stream Acquisition Diagnostic
 * 
 * Attempts to get a microphone stream using getUserMedia.
 * This WILL trigger a permission prompt if permission hasn't been granted.
 * 
 * On success, stores the stream in context for the signal detection test.
 * On failure, provides specific error messages based on the error type.
 */

import { detectBrowser, getResetInstructions } from '../browser.js';

export const diagnostic = {
    id: 'stream-acquisition',
    name: 'Microphone Access',
    description: 'Tests if we can access the selected microphone',
    scope: 'device',  // Device-specific - re-run when device changes
    requiresPermission: true,
    
    /**
     * Run the diagnostic test
     * @param {object} context - Shared context from the diagnostic runner
     * @returns {Promise<{status: string, message: string, details?: object, fix?: string}>}
     */
    async test(context) {
        const browser = detectBrowser();
        const details = {
            streamObtained: false,
            trackLabel: null,
            trackSettings: null,
            errorName: null,
            errorMessage: null
        };
        
        // Build constraints - use selected device if specified
        const constraints = context.selectedDeviceId 
            ? { audio: { deviceId: { exact: context.selectedDeviceId } } }
            : { audio: true };
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            details.streamObtained = true;
            
            // Get track info
            const track = stream.getAudioTracks()[0];
            if (track) {
                details.trackLabel = track.label;
                details.trackSettings = track.getSettings();
                details.trackState = track.readyState;
            }
            
            // Store stream in context for signal detection test
            context.stream = stream;
            context.audioTrack = track;
            
            return {
                status: 'pass',
                message: `Microphone access granted`,
                details
            };
            
        } catch (error) {
            details.errorName = error.name;
            details.errorMessage = error.message;
            
            // Provide specific fixes based on error type
            switch (error.name) {
                case 'NotAllowedError':
                    return {
                        status: 'fail',
                        message: 'Permission denied',
                        details,
                        fix: getResetInstructions(browser.name)
                    };
                    
                case 'NotFoundError':
                    return {
                        status: 'fail',
                        message: 'No microphone found',
                        details,
                        fix: 'No working microphone was found. Check that your microphone is ' +
                             'connected, enabled, and not being used by another application.'
                    };
                    
                case 'NotReadableError':
                case 'AbortError':
                    return {
                        status: 'fail',
                        message: 'Microphone is busy or unavailable',
                        details,
                        fix: 'Your microphone may be in use by another application (Zoom, Discord, etc.). ' +
                             'Close other apps that might be using the microphone and try again.'
                    };
                    
                case 'OverconstrainedError':
                    return {
                        status: 'fail',
                        message: 'Selected microphone not available',
                        details,
                        fix: 'The selected microphone could not be accessed. It may have been disconnected. ' +
                             'Try selecting a different microphone.'
                    };
                    
                case 'SecurityError':
                    return {
                        status: 'fail',
                        message: 'Security policy blocked access',
                        details,
                        fix: 'Your browser\'s security policy is blocking microphone access. ' +
                             'This page must be served over HTTPS.'
                    };
                    
                default:
                    return {
                        status: 'fail',
                        message: `Microphone error: ${error.name}`,
                        details,
                        fix: `An unexpected error occurred: ${error.message}. ` +
                             'Try refreshing the page or using a different browser.'
                    };
            }
        }
    }
};
