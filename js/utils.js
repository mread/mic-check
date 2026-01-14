/**
 * Shared Utilities Module
 * 
 * Common utility functions used across the mic-check application.
 */

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

/**
 * Get RMS value from an analyser node
 * Uses Float32Array for full 32-bit precision
 * @param {AnalyserNode} analyser - The analyser to read from
 * @returns {number} RMS value (0 to 1)
 */
export function getRmsFromAnalyser(analyser) {
    if (!analyser) return 0;
    
    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i] * dataArray[i];
    }
    return Math.sqrt(sum / bufferLength);
}

/**
 * Clean up audio resources (stream, context, source, analyser)
 * Safely handles null values and already-closed contexts
 * 
 * @param {object} resources - Object containing audio resources to clean up
 * @param {MediaStream} [resources.stream] - Media stream to stop
 * @param {AudioContext} [resources.audioContext] - Audio context to close
 * @param {MediaStreamAudioSourceNode} [resources.source] - Source node to disconnect
 * @param {AnalyserNode} [resources.analyser] - Analyser node to disconnect
 * @returns {Promise<object>} Object with all properties set to null (for easy reassignment)
 */
export async function cleanupAudioResources({ stream, audioContext, source, analyser } = {}) {
    // Stop all tracks in the stream
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
    }
    
    // Disconnect source node
    if (source) {
        try {
            source.disconnect();
        } catch (e) {
            // Already disconnected, ignore
        }
    }
    
    // Disconnect analyser node
    if (analyser) {
        try {
            analyser.disconnect();
        } catch (e) {
            // Already disconnected, ignore
        }
    }
    
    // Close audio context (awaited)
    if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close();
    }
    
    return {
        stream: null,
        audioContext: null,
        source: null,
        analyser: null
    };
}

/**
 * Get audio input devices with metadata about availability
 * 
 * This is the SINGLE SOURCE OF TRUTH for device enumeration.
 * All code that needs to list audio input devices should use this function.
 * 
 * Handles browser anti-fingerprinting behavior:
 * - Before permission: browsers return placeholder devices with empty labels
 * - After permission: real device info with labels is available
 * 
 * Also checks permission state to distinguish between:
 * - Permission not yet requested (placeholder data, might still work)
 * - Permission denied (no access, won't work)
 * 
 * @returns {Promise<{
 *   devices: MediaDeviceInfo[],
 *   count: number,
 *   hasLabels: boolean,
 *   isPlaceholderData: boolean,
 *   permissionDenied: boolean,
 *   permissionState: string|null
 * }>}
 */
export async function getAudioInputDevices() {
    // Check permission state first (if API available)
    let permissionState = null;
    try {
        if (navigator.permissions?.query) {
            const result = await navigator.permissions.query({ name: 'microphone' });
            permissionState = result.state;
        }
    } catch (e) {
        // Permissions API not supported or failed - continue without it
    }
    
    // If permission is explicitly denied, return early
    if (permissionState === 'denied') {
        return {
            devices: [],
            count: 0,
            hasLabels: false,
            isPlaceholderData: false,
            permissionDenied: true,
            permissionState
        };
    }
    
    try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = allDevices.filter(d => d.kind === 'audioinput');
        const hasLabels = audioInputs.some(d => d.label && d.label.length > 0);
        
        return {
            devices: audioInputs,
            count: audioInputs.length,
            hasLabels,
            // When no labels, device list is placeholder data from anti-fingerprinting
            isPlaceholderData: !hasLabels && audioInputs.length > 0,
            permissionDenied: false,
            permissionState
        };
    } catch (error) {
        console.error('Failed to enumerate devices:', error);
        return {
            devices: [],
            count: 0,
            hasLabels: false,
            isPlaceholderData: false,
            permissionDenied: false,
            permissionState,
            error: error.message
        };
    }
}

/**
 * Determine if a device selector should be shown to the user
 * 
 * Hides the selector when it would provide no useful choice:
 * - Permission denied (no access)
 * - No devices available
 * - Only placeholder data (anti-fingerprinting active, no labels)
 * - Only one device (no choice to make)
 * 
 * @param {object} deviceInfo - Result from getAudioInputDevices()
 * @returns {boolean} Whether to show the device selector
 */
export function shouldShowDeviceSelector(deviceInfo) {
    if (deviceInfo.permissionDenied) return false;
    if (deviceInfo.count === 0) return false;
    if (deviceInfo.isPlaceholderData) return false;
    if (deviceInfo.count === 1) return false;
    return true;
}

/**
 * Populate a device dropdown/select element with audio input devices
 * 
 * @param {HTMLSelectElement} selectElement - The select element to populate
 * @param {object} options - Configuration options
 * @param {string} [options.selectedDeviceId] - Device ID to pre-select
 * @param {boolean} [options.skipCommunications=false] - Skip Chrome's "communications" virtual device
 * @param {boolean} [options.showSeparator=false] - Show separator between meta-devices and real devices
 * @param {boolean} [options.isChromiumBased] - Whether browser is Chromium-based (required if showSeparator is true)
 * @returns {Promise<{devices: MediaDeviceInfo[], hasLabels: boolean}>}
 */
export async function populateDeviceDropdown(selectElement, options = {}) {
    const {
        selectedDeviceId = null,
        skipCommunications = false,
        showSeparator = false,
        isChromiumBased = false
    } = options;
    
    if (!selectElement) {
        return { devices: [], hasLabels: false };
    }
    
    // Use central device enumeration utility
    const deviceInfo = await getAudioInputDevices();
    const { devices: audioInputs, hasLabels, count, error, permissionDenied } = deviceInfo;
    
    selectElement.innerHTML = '';
    
    // Handle permission denied - be clear that mic access is blocked
    if (permissionDenied) {
        selectElement.innerHTML = '<option value="">Microphone access blocked</option>';
        selectElement.disabled = true;
        return { devices: [], hasLabels: false, permissionDenied: true };
    }
    
    // Handle enumeration errors
    if (error) {
        selectElement.innerHTML = '<option value="">Error loading devices</option>';
        return { devices: [], hasLabels: false };
    }
    
    if (count === 0) {
        selectElement.innerHTML = '<option value="">No microphones found</option>';
        return { devices: [], hasLabels: false };
    }
    
    // When we only have placeholder data (anti-fingerprinting active, permission not yet granted),
    // show a generic message - permission may still be grantable
    if (!hasLabels) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Default microphone';
        option.selected = true;
        selectElement.appendChild(option);
        return { devices: audioInputs, hasLabels: false };
    }
    
    // Separate meta-entries (Default, Communications) from actual devices
    const metaDevices = audioInputs.filter(d => 
        d.deviceId === 'default' || d.deviceId === 'communications'
    );
    const realDevices = audioInputs.filter(d => 
        d.deviceId !== 'default' && d.deviceId !== 'communications'
    );
    
    if (isChromiumBased && metaDevices.length > 0) {
        // Chromium path: use virtual "default" and "communications" entries
        metaDevices.forEach(device => {
            if (skipCommunications && device.deviceId === 'communications') {
                return;
            }
            
            const option = document.createElement('option');
            option.value = device.deviceId;
            
            if (device.deviceId === 'default') {
                option.textContent = `🔊 ${device.label || 'Default Device'}`;
                if (!selectedDeviceId) {
                    option.selected = true;
                }
            } else if (device.deviceId === 'communications') {
                option.textContent = `📞 ${device.label || 'Communications Device'}`;
            }
            
            if (device.deviceId === selectedDeviceId) {
                option.selected = true;
            }
            
            selectElement.appendChild(option);
        });
        
        // Add separator if requested
        if (showSeparator && realDevices.length > 0) {
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '──────────────';
            selectElement.appendChild(separator);
        }
        
        // Add actual devices
        realDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Microphone ${index + 1}`;
            
            if (device.deviceId === selectedDeviceId) {
                option.selected = true;
            }
            
            selectElement.appendChild(option);
        });
    } else {
        // Firefox/Safari path: first device in list is the OS default
        realDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            
            if (index === 0 && !selectedDeviceId) {
                option.textContent = `🔊 ${device.label || 'Microphone'} (System Default)`;
                option.selected = true;
            } else {
                option.textContent = device.label || `Microphone ${index + 1}`;
            }
            
            if (device.deviceId === selectedDeviceId) {
                option.selected = true;
            }
            
            selectElement.appendChild(option);
        });
    }
    
    // Ensure something is selected
    if (selectElement.selectedIndex === -1 && selectElement.options.length > 0) {
        selectElement.options[0].selected = true;
    }
    
    return { devices: audioInputs, hasLabels: true };
}
