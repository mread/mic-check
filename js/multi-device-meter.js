/**
 * Multi-Device Meter Module
 * 
 * Manages multiple microphone streams simultaneously for the mic test screen.
 * Each device can be independently enabled/disabled for monitoring.
 * Uses a single AudioContext with multiple MediaStreamSource nodes.
 */

import { isChromiumBased } from './browser.js';
import { getRmsFromAnalyser, cleanupAudioResources } from './utils.js';

/**
 * State for all monitored devices
 */
const deviceMeterState = {
    audioContext: null,
    devices: new Map(), // deviceId -> { stream, source, analyser, enabled, label, groupId }
    animationId: null,
    primaryDeviceId: null,  // The mic used for diagnostics
    allDevices: [],  // All enumerated devices (for UI rendering)
    deduplicatedDevices: [],  // Devices after Chrome deduplication
    onLevelUpdate: null  // Callback for level updates
};

/**
 * Deduplicate Chrome's default/communications virtual devices
 * These may point to the same physical hardware (same groupId)
 * @param {MediaDeviceInfo[]} devices - Array of audio input devices
 * @returns {Array} Deduplicated devices with alias info
 */
export function deduplicateDevices(devices) {
    if (!isChromiumBased()) {
        // Firefox/Safari don't have virtual devices, return as-is with empty aliases
        return devices.map(d => ({
            deviceId: d.deviceId,
            label: d.label,
            groupId: d.groupId,
            aliases: [],
            isDefault: false,
            isCommunications: false
        }));
    }
    
    // For Chrome: group by groupId to find duplicates
    // Collect all devices per group, then pick the best one
    const byGroup = new Map();
    
    devices.forEach(d => {
        const isVirtualDefault = d.deviceId === 'default';
        const isVirtualComms = d.deviceId === 'communications';
        
        // Use deviceId as fallback if groupId is undefined to avoid incorrect grouping
        const groupKey = d.groupId ?? d.deviceId;
        const groupDevices = byGroup.get(groupKey) || [];
        groupDevices.push({
            deviceId: d.deviceId,
            label: d.label,
            groupId: d.groupId,
            isVirtualDefault,
            isVirtualComms,
            isReal: !isVirtualDefault && !isVirtualComms
        });
        byGroup.set(groupKey, groupDevices);
    });
    
    // For each group, pick the real device (if exists) or first virtual
    const results = [];
    byGroup.forEach((groupDevices) => {
        // Find the real device (not default or communications)
        const realDevice = groupDevices.find(d => d.isReal);
        const hasDefault = groupDevices.some(d => d.isVirtualDefault);
        const hasComms = groupDevices.some(d => d.isVirtualComms);
        
        // Use real device if available, otherwise first device in group
        const primary = realDevice || groupDevices[0];
        
        // Build aliases
        const aliases = [];
        if (hasDefault && primary.deviceId !== 'default') {
            aliases.push('Default');
        }
        if (hasComms && primary.deviceId !== 'communications') {
            aliases.push('Communications');
        }
        
        results.push({
            deviceId: primary.deviceId,
            label: primary.label,
            groupId: primary.groupId,
            aliases,
            isDefault: hasDefault,
            isCommunications: hasComms
        });
    });
    
    return results;
}

/**
 * Initialize the multi-device meter system
 * @param {MediaDeviceInfo[]} devices - Array of audio input devices
 * @param {Function} onLevelUpdate - Callback: (deviceId, level) => void
 */
export function initMultiMeter(devices, onLevelUpdate) {
    // Clean up any existing state
    cleanupAllMonitoring();
    
    deviceMeterState.allDevices = devices;
    deviceMeterState.deduplicatedDevices = deduplicateDevices(devices);
    deviceMeterState.onLevelUpdate = onLevelUpdate;
    
    return deviceMeterState.deduplicatedDevices;
}

/** Get the deduplicated device list */
export function getDeduplicatedDevices() {
    return deviceMeterState.deduplicatedDevices;
}

/**
 * Get the primary device ID (used for diagnostics)
 */
export function getPrimaryDeviceId() {
    return deviceMeterState.primaryDeviceId;
}

/**
 * Set the primary device (used for diagnostics)
 * @param {string} deviceId 
 */
export function setPrimaryDevice(deviceId) {
    deviceMeterState.primaryDeviceId = deviceId;
}

/**
 * Enable monitoring for a specific device
 * Opens a stream and creates an analyser node
 * @param {string} deviceId - The device ID to enable
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function enableMonitoring(deviceId) {
    // Check if already monitoring or pending
    if (deviceMeterState.devices.has(deviceId)) {
        const device = deviceMeterState.devices.get(deviceId);
        if (device.enabled || device.pending) {
            return { success: true };
        }
    }
    
    // Mark as pending to prevent duplicate requests during async work
    deviceMeterState.devices.set(deviceId, { pending: true, enabled: false });
    
    // Declare stream outside try block so we can clean it up on failure
    let stream = null;
    
    try {
        // Create AudioContext if needed
        if (!deviceMeterState.audioContext) {
            deviceMeterState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            await deviceMeterState.audioContext.resume();
        }
        
        // Get stream for this device
        const constraints = {
            audio: {
                deviceId: { exact: deviceId }
            }
        };
        
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        const source = deviceMeterState.audioContext.createMediaStreamSource(stream);
        
        // Create analyser for level metering
        const analyser = deviceMeterState.audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);
        
        // Get device label
        const track = stream.getAudioTracks()[0];
        const label = track?.label || 'Unknown Microphone';
        
        // Store in state
        deviceMeterState.devices.set(deviceId, {
            stream,
            source,
            analyser,
            enabled: true,
            label,
            groupId: track?.getSettings()?.groupId
        });
        
        // Set as primary if none set
        if (!deviceMeterState.primaryDeviceId) {
            deviceMeterState.primaryDeviceId = deviceId;
        }
        
        // Start animation loop if not already running
        if (!deviceMeterState.animationId) {
            startAnimationLoop();
        }
        
        return { success: true };
        
    } catch (error) {
        console.error(`Failed to enable monitoring for ${deviceId}:`, error);
        
        // Stop any acquired stream tracks to prevent resource leak
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
        }
        
        // Remove pending entry on failure
        deviceMeterState.devices.delete(deviceId);
        return { 
            success: false, 
            error: error.name === 'NotReadableError' 
                ? 'Device is busy or unavailable'
                : error.message
        };
    }
}

/**
 * Disable monitoring for a specific device
 * Stops the stream and removes from animation loop
 * @param {string} deviceId - The device ID to disable
 */
export function disableMonitoring(deviceId) {
    const device = deviceMeterState.devices.get(deviceId);
    if (!device) return;
    
    // Stop the stream (if it has tracks - might be pending entry)
    if (device.stream) {
        device.stream.getTracks().forEach(t => t.stop());
    }
    
    // Disconnect audio nodes (if they exist)
    if (device.source) {
        device.source.disconnect();
    }
    
    // Remove from state
    deviceMeterState.devices.delete(deviceId);
    
    // If this was the primary, pick a new one from enabled devices only
    if (deviceMeterState.primaryDeviceId === deviceId) {
        const enabledDevices = Array.from(deviceMeterState.devices.entries())
            .filter(([, device]) => device.enabled)
            .map(([id]) => id);
        deviceMeterState.primaryDeviceId = enabledDevices.length > 0 ? enabledDevices[0] : null;
    }
    
    // Stop animation if no devices left
    if (deviceMeterState.devices.size === 0 && deviceMeterState.animationId) {
        cancelAnimationFrame(deviceMeterState.animationId);
        deviceMeterState.animationId = null;
    }
}

/**
 * Check if a device is currently being monitored
 * @param {string} deviceId 
 * @returns {boolean}
 */
export function isMonitoring(deviceId) {
    const device = deviceMeterState.devices.get(deviceId);
    return device?.enabled === true;
}

/**
 * Get all currently monitored device IDs
 * @returns {string[]}
 */
export function getMonitoredDeviceIds() {
    return Array.from(deviceMeterState.devices.keys());
}

/**
 * Start the animation loop for level updates
 */
function startAnimationLoop() {
    function update() {
        if (!deviceMeterState.audioContext || deviceMeterState.audioContext.state === 'closed') {
            deviceMeterState.animationId = null;
            return;
        }
        
        deviceMeterState.animationId = requestAnimationFrame(update);
        
        // Update levels for all monitored devices
        deviceMeterState.devices.forEach((device, deviceId) => {
            if (!device.enabled || !device.analyser) return;
            
            // Calculate RMS level using shared utility (high precision)
            const rms = getRmsFromAnalyser(device.analyser);
            const level = Math.min(100, rms * 250);
            
            // Call the update callback
            if (deviceMeterState.onLevelUpdate) {
                deviceMeterState.onLevelUpdate(deviceId, level);
            }
        });
    }
    
    update();
}

/**
 * Get the analyser node for a device (for use by diagnostics)
 * @param {string} deviceId 
 * @returns {AnalyserNode|null}
 */
export function getAnalyser(deviceId) {
    return deviceMeterState.devices.get(deviceId)?.analyser || null;
}

/**
 * Get the stream for a device (for use by diagnostics)
 * @param {string} deviceId 
 * @returns {MediaStream|null}
 */
export function getStream(deviceId) {
    return deviceMeterState.devices.get(deviceId)?.stream || null;
}

/**
 * Get the AudioContext (for use by diagnostics)
 * @returns {AudioContext|null}
 */
export function getAudioContext() {
    return deviceMeterState.audioContext;
}

/**
 * Clean up all monitoring - stop all streams, close context
 */
export function cleanupAllMonitoring() {
    // Stop animation loop
    if (deviceMeterState.animationId) {
        cancelAnimationFrame(deviceMeterState.animationId);
        deviceMeterState.animationId = null;
    }
    
    // Clean up each device's audio resources (fire-and-forget for per-device cleanup)
    deviceMeterState.devices.forEach((device) => {
        // Note: We don't await here since we're cleaning up multiple devices
        // and the stream/source cleanup is synchronous
        cleanupAudioResources({
            stream: device.stream,
            source: device.source,
            analyser: device.analyser
        });
    });
    deviceMeterState.devices.clear();
    
    // Close shared audio context
    if (deviceMeterState.audioContext && deviceMeterState.audioContext.state !== 'closed') {
        // Fire-and-forget - context will close eventually
        deviceMeterState.audioContext.close();
    }
    deviceMeterState.audioContext = null;
    
    // Reset state
    deviceMeterState.primaryDeviceId = null;
    deviceMeterState.allDevices = [];
    deviceMeterState.deduplicatedDevices = [];
    deviceMeterState.onLevelUpdate = null;
}

/**
 * Find the default device ID
 * @returns {string|null} The default device ID or first device if no default
 */
export function findDefaultDeviceId() {
    // Look for deduplicated device marked as default
    const defaultDevice = deviceMeterState.deduplicatedDevices.find(d => d.isDefault);
    if (defaultDevice) {
        return defaultDevice.deviceId;
    }
    
    // For Firefox/Safari or if no default, use first deduplicated device
    if (deviceMeterState.deduplicatedDevices.length > 0) {
        return deviceMeterState.deduplicatedDevices[0].deviceId;
    }
    
    // Fallback to first raw device
    if (deviceMeterState.allDevices.length > 0) {
        return deviceMeterState.allDevices[0].deviceId;
    }
    
    return null;
}
