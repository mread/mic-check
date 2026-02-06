/**
 * Privacy Check Screen Logic
 */

import {
    detectBrowser,
    checkPermission,
    getResetInstructions
} from '../browser.js';

async function runPrivacyCheck() {
    const browser = detectBrowser();
    const statusEl = document.getElementById('privacy-permission-status');
    const resetEl = document.getElementById('reset-instructions');
    
    if (!statusEl || !resetEl) {
        console.error('Privacy screen: required DOM elements not found');
        return;
    }
    
    // Show reset instructions for detected browser
    resetEl.innerHTML = getResetInstructions(browser.name);
    
    // Check permission
    const { state, supported } = await checkPermission();
    
    let statusHtml = '';
    if (!supported) {
        statusHtml = `
            <div class="status-card info">
                <span class="status-icon">ℹ️</span>
                <div class="status-text">
                    <div class="status-title">Permission status unknown</div>
                    <div class="status-detail">Your browser (${browser.name}) doesn't support the Permissions API for microphone.</div>
                </div>
            </div>
        `;
    } else if (state === 'granted') {
        statusHtml = `
            <div class="status-card success">
                <span class="status-icon">🔓</span>
                <div class="status-text">
                    <div class="status-title">Microphone permission granted</div>
                    <div class="status-detail">This site can request access to your microphone. It is NOT currently listening unless you started a test.</div>
                </div>
            </div>
        `;
    } else if (state === 'denied') {
        statusHtml = `
            <div class="status-card problem">
                <span class="status-icon">🔒</span>
                <div class="status-text">
                    <div class="status-title">Microphone permission blocked</div>
                    <div class="status-detail">You previously blocked microphone access for this site. See below for how to reset.</div>
                </div>
            </div>
        `;
    } else {
        statusHtml = `
            <div class="status-card info">
                <span class="status-icon">❓</span>
                <div class="status-text">
                    <div class="status-title">Microphone permission not requested</div>
                    <div class="status-detail">This site hasn't asked for microphone access yet. You'll be prompted when it does.</div>
                </div>
            </div>
        `;
    }
    
    statusEl.innerHTML = statusHtml;
    
    // Show re-check button
    const recheckBtn = document.getElementById('btn-privacy-check');
    if (recheckBtn) {
        recheckBtn.style.display = 'inline-flex';
    }
}

export { runPrivacyCheck };
