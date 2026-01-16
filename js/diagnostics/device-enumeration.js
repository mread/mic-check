/**
 * Device Enumeration Diagnostic
 * 
 * Checks how many audio input devices are available.
 * 
 * Note: Before permission is granted, browsers return devices
 * but with empty labels. We can still count them.
 * After permission, we get full device labels.
 * 
 * IMPORTANT: Chrome reports virtual "default" and "communications" devices
 * in addition to physical devices. We deduplicate these so the count shown
 * matches the actual number of microphones displayed in the UI.
 */

import { getAudioInputDevices } from '../utils.js';
import { deduplicateDevices } from '../multi-device-meter.js';

export const diagnostic = {
    id: 'device-enumeration',
    name: 'Microphone Detection',
    description: 'Checks if microphones are connected',
    scope: 'site',  // Site-level - device list is stable once permission granted
    requiresPermission: false,
    pendingMessage: 'Looking for microphones...',
    runningMessage: 'Detecting microphones...',
    
    /**
     * Run the diagnostic test
     * @param {object} context - Shared context from the diagnostic runner
     * @returns {Promise<{status: string, message: string, details?: object, fix?: string}>}
     */
    async test(context) {
        const details = {
            deviceCount: 0,
            hasLabels: false,
            devices: []
        };
        
        // When permission is not granted, browsers return placeholder devices for anti-fingerprinting.
        // Don't show this unreliable data — it would mislead users into thinking we detected
        // their microphone when we actually can't see any real device information.
        // Only show device enumeration when permission is actually 'granted'.
        if (context.permissionState && context.permissionState !== 'granted') {
            const message = context.permissionState === 'denied' 
                ? 'Skipped (permission blocked)'
                : 'Skipped (permission not yet granted)';
            return {
                status: 'skip',
                message,
                details
            };
        }
        
        // Use central device enumeration utility (single source of truth)
        const deviceInfo = await getAudioInputDevices();
        const { devices: audioInputs, count, hasLabels, error } = deviceInfo;
        
        if (error) {
            details.error = error;
            return {
                status: 'fail',
                message: 'Could not enumerate devices',
                details,
                fix: 'Your browser may be blocking device access. Check your privacy settings.'
            };
        }
        
        details.hasLabels = hasLabels;
        
        // Store device info (with or without labels)
        details.devices = audioInputs.map(d => ({
            deviceId: d.deviceId,
            label: d.label || '(label hidden until permission granted)',
            isDefault: d.deviceId === 'default',
            isCommunications: d.deviceId === 'communications'
        }));
        
        // Store in context for other diagnostics
        context.devices = audioInputs;
        context.hasDeviceLabels = hasLabels;
        
        if (count === 0) {
            return {
                status: 'fail',
                message: 'No microphones detected',
                details,
                fix: 'Check that your microphone is connected and not disabled in your operating system\'s sound settings.'
            };
        }
        
        // Check if we found the meta-devices (Default, Communications)
        const hasDefault = audioInputs.some(d => d.deviceId === 'default');
        const hasCommunications = audioInputs.some(d => d.deviceId === 'communications');
        details.hasDefaultDevice = hasDefault;
        details.hasCommunicationsDevice = hasCommunications;
        
        // Use deduplicated count for the message to match what the UI actually shows.
        // Chrome reports virtual "default" and "communications" devices separately,
        // but deduplication merges them with their physical counterparts.
        // This prevents scary mismatches like "7 microphones found" showing only 4.
        const deduplicated = deduplicateDevices(audioInputs);
        const displayCount = deduplicated.length;
        
        const message = hasLabels 
            ? `Found ${displayCount} microphone${displayCount !== 1 ? 's' : ''}`
            : `${displayCount} microphone${displayCount !== 1 ? 's' : ''} detected`;
        
        // Store counts in details - deviceCount is what user sees (deduplicated)
        details.deviceCount = displayCount;
        details.rawDeviceCount = count;
        
        return {
            status: 'pass',
            message,
            details
        };
    }
};
