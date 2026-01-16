/**
 * Device Enumeration Diagnostic
 * 
 * Checks how many audio input devices are available.
 * 
 * Note: Before permission is granted, browsers return devices
 * but with empty labels. We can still count them.
 * After permission, we get full device labels.
 */

import { getAudioInputDevices } from '../utils.js';

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
        
        details.deviceCount = count;
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
        
        const message = hasLabels 
            ? `Found ${count} microphone${count > 1 ? 's' : ''}`
            : `${count} microphone${count > 1 ? 's' : ''} detected`;
        
        return {
            status: 'pass',
            message,
            details
        };
    }
};
