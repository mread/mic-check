/**
 * Browser Support Diagnostic
 * 
 * Tests whether the browser has the required APIs for microphone access:
 * - navigator.mediaDevices
 * - navigator.mediaDevices.getUserMedia
 * - navigator.mediaDevices.enumerateDevices
 * - AudioContext or webkitAudioContext
 * 
 * This test runs WITHOUT requiring user permission.
 */

export const diagnostic = {
    id: 'browser-support',
    name: 'Browser Support',
    description: 'Checks if your browser supports microphone access',
    scope: 'environment',  // Never changes - browser/OS level
    requiresPermission: false,
    
    /**
     * Run the diagnostic test
     * @param {object} context - Shared context from the diagnostic runner
     * @returns {Promise<{status: string, message: string, details?: object, fix?: string}>}
     */
    async test(context) {
        // Check secure context first - mediaDevices is hidden in insecure contexts
        const isSecureContext = window.isSecureContext;
        if (!isSecureContext) {
            return {
                status: 'fail',
                message: 'Microphone access requires HTTPS',
                details: { secureContext: false },
                fix: 'This page must be served over HTTPS or from localhost. ' +
                     'Microphone access is blocked on insecure (HTTP) connections.'
            };
        }
        
        const missing = [];
        const details = {
            secureContext: true,
            mediaDevices: false,
            getUserMedia: false,
            enumerateDevices: false,
            audioContext: false
        };
        
        // Check navigator.mediaDevices
        if (!navigator.mediaDevices) {
            missing.push('MediaDevices API');
        } else {
            details.mediaDevices = true;
            
            // Check getUserMedia
            if (typeof navigator.mediaDevices.getUserMedia !== 'function') {
                missing.push('getUserMedia');
            } else {
                details.getUserMedia = true;
            }
            
            // Check enumerateDevices
            if (typeof navigator.mediaDevices.enumerateDevices !== 'function') {
                missing.push('enumerateDevices');
            } else {
                details.enumerateDevices = true;
            }
        }
        
        // Check AudioContext
        if (!window.AudioContext && !window.webkitAudioContext) {
            missing.push('AudioContext');
        } else {
            details.audioContext = true;
        }
        
        if (missing.length > 0) {
            return {
                status: 'fail',
                message: `Browser missing: ${missing.join(', ')}`,
                details,
                fix: 'Your browser may be outdated or have restricted features. ' +
                     'Try updating your browser or using Chrome, Firefox, or Edge.'
            };
        }
        
        return {
            status: 'pass',
            message: 'Browser supports microphone access',
            details
        };
    }
};
