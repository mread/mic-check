/**
 * Permission State Diagnostic
 * 
 * Checks the current microphone permission state using the Permissions API.
 * This does NOT trigger a permission prompt - it only reads current state.
 * 
 * For detailed documentation on browser permission behaviors, see:
 * @see /permissions.md
 * 
 * Key browser differences to be aware of:
 * - Chrome: Permissions API is reliable
 * - Firefox: May return 'prompt' even when permission was previously granted
 * - Safari: Per-session permissions, Permissions API partially supported
 * 
 * After stream-acquisition succeeds, we update this result to 'pass' regardless
 * of what Permissions API reported (trust actual behavior over API state).
 */

import { detectBrowser, getResetInstructions } from '../browser.js';

export const diagnostic = {
    id: 'permission-state',
    name: 'Permission Status',
    description: 'Checks if microphone permission has been granted',
    scope: 'site',  // Site-level permission - stable once granted
    requiresPermission: false,
    
    /**
     * Run the diagnostic test
     * @param {object} context - Shared context from the diagnostic runner
     * @returns {Promise<{status: string, message: string, details?: object, fix?: string}>}
     */
    async test(context) {
        const browser = detectBrowser();
        const details = {
            permissionApiSupported: false,
            state: 'unknown',
            browser: browser.name
        };
        
        // Check if Permissions API is available
        if (!navigator.permissions?.query) {
            details.permissionApiSupported = false;
            
            // Can't determine state - will need to try getUserMedia
            return {
                status: 'warn',
                message: 'Cannot check permission state (will test when microphone is accessed)',
                details
            };
        }
        
        details.permissionApiSupported = true;
        
        try {
            const result = await navigator.permissions.query({ name: 'microphone' });
            details.state = result.state;
            
            // Store in context for other diagnostics
            context.permissionState = result.state;
            
            switch (result.state) {
                case 'granted':
                    return {
                        status: 'pass',
                        message: 'Microphone permission granted',
                        details
                    };
                    
                case 'denied':
                    return {
                        status: 'fail',
                        message: 'Microphone permission blocked',
                        details,
                        fix: getResetInstructions(browser.name)
                    };
                    
                case 'prompt':
                    // No fix needed - the next diagnostic will trigger the permission prompt
                    return {
                        status: 'info',
                        message: 'Requesting permission...',
                        details
                    };
                    
                default:
                    return {
                        status: 'warn',
                        message: `Unknown permission state: ${result.state}`,
                        details
                    };
            }
        } catch (error) {
            details.error = error.message;
            
            // Some browsers throw on permissions.query for microphone
            return {
                status: 'warn',
                message: 'Could not check permission state',
                details
            };
        }
    }
};
