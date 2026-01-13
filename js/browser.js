/**
 * Browser Detection Module
 * 
 * Handles browser detection and browser-specific quirks
 * (particularly Firefox audio handling differences).
 */

/**
 * Detected browser info
 */
export let detectedBrowser = null;

/**
 * Detect the current browser
 * @returns {{name: string, version: string, isFirefoxBased: boolean}}
 */
export function detectBrowser() {
    const ua = navigator.userAgent;
    let name = 'Unknown';
    let version = 'Unknown';
    let isFirefoxBased = false;
    
    if (ua.includes('Firefox')) {
        isFirefoxBased = true;
        const match = ua.match(/Firefox\/(\d+(\.\d+)?)/);
        if (match) version = match[1];
        
        if (ua.includes('LibreWolf')) {
            name = 'LibreWolf';
        } else if (ua.includes('Waterfox')) {
            name = 'Waterfox';
        } else {
            name = 'Firefox';
        }
    } else if (ua.includes('Edg/')) {
        name = 'Edge';
        const match = ua.match(/Edg\/(\d+(\.\d+)?)/);
        if (match) version = match[1];
    } else if (ua.includes('Chrome')) {
        const match = ua.match(/Chrome\/(\d+(\.\d+)?)/);
        if (match) version = match[1];
        
        if (ua.includes('Brave')) {
            name = 'Brave';
        } else if (ua.includes('Vivaldi')) {
            name = 'Vivaldi';
        } else if (ua.includes('OPR')) {
            name = 'Opera';
        } else {
            name = 'Chrome';
        }
    } else if (ua.includes('Safari')) {
        name = 'Safari';
        const match = ua.match(/Version\/(\d+(\.\d+)?)/);
        if (match) version = match[1];
    }
    
    detectedBrowser = { name, version, isFirefoxBased };
    return detectedBrowser;
}

/**
 * Check if the current browser is Firefox-based
 * @returns {boolean}
 */
export function isFirefoxBased() {
    if (!detectedBrowser) detectBrowser();
    return detectedBrowser?.isFirefoxBased || navigator.userAgent.includes('Firefox');
}

/**
 * Get browser-specific permission reset instructions
 * @param {string} browserName - Name of the browser
 * @returns {string} HTML instructions
 */
export function getResetInstructions(browserName) {
    const instructions = {
        'Chrome': `
            <ol>
                <li>Click the 🔒 icon in the address bar</li>
                <li>Click "Site settings"</li>
                <li>Find "Microphone" and select "Ask" or "Block"</li>
            </ol>
            <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                Or visit: <code>chrome://settings/content/microphone</code>
            </p>
        `,
        'Firefox': `
            <ol>
                <li>Click the 🔒 icon in the address bar</li>
                <li>Click "Clear Permissions" next to Microphone</li>
            </ol>
            <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                Or visit: <code>about:preferences#privacy</code> → Permissions → Microphone → Settings
            </p>
        `,
        'LibreWolf': `
            <ol>
                <li>Click the 🔒 icon in the address bar</li>
                <li>Click "Clear Permissions" or the X next to Microphone</li>
            </ol>
            <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                LibreWolf has stricter defaults. Check <code>about:preferences#privacy</code>
            </p>
        `,
        'Edge': `
            <ol>
                <li>Click the 🔒 icon in the address bar</li>
                <li>Click "Site permissions"</li>
                <li>Toggle Microphone off or select "Ask"</li>
            </ol>
        `,
        'Safari': `
            <ol>
                <li>Go to Safari menu → Settings for This Website</li>
                <li>Change Microphone to "Ask" or "Deny"</li>
            </ol>
        `
    };
    
    return instructions[browserName] || instructions['Chrome'];
}

/**
 * Check microphone permission status
 * @returns {Promise<{state: string, supported: boolean, result?: PermissionStatus}>}
 */
export async function checkPermission() {
    if (!navigator.permissions?.query) {
        return { state: 'unknown', supported: false };
    }
    try {
        const result = await navigator.permissions.query({ name: 'microphone' });
        return { state: result.state, supported: true, result };
    } catch (e) {
        return { state: 'unknown', supported: false };
    }
}

/**
 * Generate HTML for low volume warning
 * @returns {string} HTML content
 */
export function getLowVolumeWarningHtml() {
    return `
        <div id="low-volume-warning" class="info-box" style="margin-top: 1rem; background: #fff3cd; border: 1px solid #ffc107;">
            <h4 style="margin-bottom: 0.5rem;">📢 Volume seems low</h4>
            <p style="margin-bottom: 0.75rem;">
                Your mic is working, but the level is quite low. This might be normal, or your mic gain may need adjusting.
            </p>
            <p>
                <a href="#" id="link-to-level-check" style="color: var(--accent); font-weight: 500;">
                    📊 Try Level Check →
                </a>
                for a detailed analysis with standards comparison.
            </p>
        </div>
    `;
}

/**
 * Generate HTML for fingerprinting/audio blocked warning
 * @returns {string} HTML content
 */
export function getAudioBlockedWarningHtml() {
    const isFirefox = isFirefoxBased();
    
    return `
        <div class="status-card problem" style="margin-top: 1rem; flex-direction: column; align-items: stretch;">
            <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                <span class="status-icon">🔇</span>
                <div>
                    <div class="status-title">Your browser is blocking audio analysis</div>
                    <div class="status-detail">Permission granted, but a privacy setting is muting the data.</div>
                </div>
            </div>
            
            ${isFirefox ? `
            <div style="background: white; padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
                <strong style="display: block; margin-bottom: 0.5rem;">To fix this:</strong>
                <ol style="margin: 0; padding-left: 1.25rem; color: var(--text-secondary);">
                    <li>Open a new tab and go to <code>about:config</code></li>
                    <li>Search for <code>media.getusermedia.audio.capture.enabled</code></li>
                    <li>Set it to <strong>true</strong></li>
                    <li>Refresh this page</li>
                </ol>
            </div>
            <p style="font-size: 0.85rem; color: var(--text-secondary); margin: 0;">
                Zen, LibreWolf, and similar browsers disable this by default for privacy.
                Your mic still works in apps that don't need audio analysis.
            </p>
            ` : `
            <p style="margin: 0;">Check your browser's privacy or security settings to enable audio capture.</p>
            `}
        </div>
    `;
}
