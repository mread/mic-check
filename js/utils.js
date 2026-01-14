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
    
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        
        selectElement.innerHTML = '';
        
        if (audioInputs.length === 0) {
            selectElement.innerHTML = '<option value="">No microphones found</option>';
            return { devices: [], hasLabels: false };
        }
        
        // Check if we have labels (permission was previously granted)
        const hasLabels = audioInputs.some(d => d.label && d.label.length > 0);
        
        if (!hasLabels) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = `${audioInputs.length} microphone${audioInputs.length > 1 ? 's' : ''} detected`;
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
        
    } catch (error) {
        console.error('Failed to populate device dropdown:', error);
        selectElement.innerHTML = '<option value="">Error loading devices</option>';
        return { devices: [], hasLabels: false };
    }
}
