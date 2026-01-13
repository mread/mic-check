/**
 * Results Renderer Module
 * 
 * Handles rendering of level check results.
 * Simplified to reduce visual clutter.
 */

import { QUALITY_REFERENCE, formatDb, formatLufs, getQualityRating } from './standards.js';
import { qualityTestData } from './audio.js';

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

/**
 * Render the level check results to the DOM
 */
export function displayQualityResults() {
    const data = {
        noiseFloor: qualityTestData.noiseFloorDb,
        voiceLufs: qualityTestData.voiceLufs,
        peakLevel: qualityTestData.voicePeakDb,
        snr: qualityTestData.snr
    };
    
    const resultsEl = document.getElementById('quality-results');
    resultsEl.style.display = 'block';
    
    // Determine ratings
    const noiseRating = getQualityRating(data.noiseFloor, QUALITY_REFERENCE.noiseFloor, false);
    const snrRating = getQualityRating(data.snr, QUALITY_REFERENCE.snr, true);
    
    let lufsRating = 'good';
    if (data.voiceLufs < QUALITY_REFERENCE.lufs.min) {
        lufsRating = 'too-quiet';
    } else if (data.voiceLufs > QUALITY_REFERENCE.lufs.max) {
        lufsRating = 'too-loud';
    }
    
    let peakRating = 'good';
    if (data.peakLevel < QUALITY_REFERENCE.peak.min - 6) {
        peakRating = 'too-quiet';
    } else if (data.peakLevel > QUALITY_REFERENCE.peak.max) {
        peakRating = 'clipping';
    }
    
    const isGood = noiseRating !== 'poor' && snrRating !== 'poor' && lufsRating === 'good' && peakRating === 'good';
    
    // Check AGC status
    const agcWasEnabled = qualityTestData.appliedSettings?.autoGainControl === true;
    
    // Build issues list - prioritize actionable fixes
    const issues = [];
    
    // Check for stereo issues first (most impactful)
    const hasStereoIssue = qualityTestData.channelBalance?.hasDeadChannel;
    
    if (lufsRating === 'too-quiet') {
        issues.push('Voice too quiet — move closer to mic or increase system mic gain');
    }
    if (lufsRating === 'too-loud') {
        issues.push('Voice too loud — move back or decrease mic gain');
    }
    if (peakRating === 'clipping') {
        issues.push('Audio clipping — reduce mic gain to avoid distortion');
    }
    if (noiseRating === 'poor') {
        issues.push('High background noise — find a quieter location');
    }
    if (snrRating === 'poor') {
        issues.push('Voice doesn\'t stand out from noise — speak louder or reduce background noise');
    }
    
    // AGC info line
    const agcInfo = agcWasEnabled 
        ? 'Tested with Auto Gain Control (same as most apps)'
        : 'Tested without AGC (raw levels)';
    
    resultsEl.innerHTML = `
        <div style="text-align: center; padding: 1.5rem 0; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem;">
            <div style="font-size: 3rem; margin-bottom: 0.5rem;">${isGood && !hasStereoIssue ? '✅' : '⚠️'}</div>
            <div style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem;">
                ${isGood && !hasStereoIssue ? 'You should be heard clearly' : 'Some issues to address'}
            </div>
            <div style="color: var(--text-secondary); font-size: 0.9rem;">
                ${escapeHtml(qualityTestData.deviceLabel) || 'Unknown microphone'}
            </div>
            <div style="color: var(--text-muted); font-size: 0.8rem; margin-top: 0.25rem;">
                ${agcInfo}
            </div>
        </div>
        
        ${hasStereoIssue ? `
        <div style="background: #fff3e0; border-left: 4px solid #ff9800; padding: 1rem; margin-bottom: 1.5rem;">
            <strong style="display: block; margin-bottom: 0.5rem;">⚠️ Stereo Configuration Issue</strong>
            <p style="margin-bottom: 0.75rem; color: var(--text-secondary);">
                Your mic is set as stereo but only one channel has audio. This causes ~50% volume loss.
            </p>
            <details>
                <summary style="cursor: pointer; color: var(--accent);">How to fix</summary>
                <div style="margin-top: 0.75rem; font-size: 0.9rem; color: var(--text-secondary);">
                    <strong>Windows:</strong> Sound Settings → Recording → Right-click mic → Properties → Advanced → Change to "1 channel"<br><br>
                    <strong>macOS:</strong> Audio MIDI Setup → Select interface → Configure as mono
                </div>
            </details>
        </div>
        ` : ''}
        
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 1.1rem;">
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 0.75rem 0;">Voice Level</td>
                <td style="padding: 0.75rem 0; text-align: right; font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; font-size: 1.15rem; font-weight: 500;">${formatLufs(data.voiceLufs)}</td>
                <td style="padding: 0.75rem 0; text-align: right; width: 90px;">
                    <span style="color: ${lufsRating === 'good' ? 'var(--success)' : 'var(--problem)'}; font-weight: 500;">
                        ${lufsRating === 'good' ? '✓ Good' : lufsRating === 'too-quiet' ? '↓ Quiet' : '↑ Loud'}
                    </span>
                </td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 0.75rem 0;">Peak Level</td>
                <td style="padding: 0.75rem 0; text-align: right; font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; font-size: 1.15rem; font-weight: 500;">${formatDb(data.peakLevel)}</td>
                <td style="padding: 0.75rem 0; text-align: right;">
                    <span style="color: ${peakRating === 'good' ? 'var(--success)' : 'var(--problem)'}; font-weight: 500;">
                        ${peakRating === 'good' ? '✓ Good' : peakRating === 'clipping' ? '⚠ Clip' : '↓ Low'}
                    </span>
                </td>
            </tr>
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 0.75rem 0;">Background Noise</td>
                <td style="padding: 0.75rem 0; text-align: right; font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; font-size: 1.15rem; font-weight: 500;">${formatDb(data.noiseFloor)}</td>
                <td style="padding: 0.75rem 0; text-align: right;">
                    <span style="color: ${noiseRating !== 'poor' ? 'var(--success)' : 'var(--problem)'}; font-weight: 500;">
                        ${noiseRating === 'excellent' || noiseRating === 'good' ? '✓ Good' : noiseRating === 'acceptable' ? '~ OK' : '✗ High'}
                    </span>
                </td>
            </tr>
            <tr>
                <td style="padding: 0.75rem 0;">Signal vs Noise</td>
                <td style="padding: 0.75rem 0; text-align: right; font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; font-size: 1.15rem; font-weight: 500;">${Number.isFinite(data.snr) ? data.snr.toFixed(0) : '—'} dB</td>
                <td style="padding: 0.75rem 0; text-align: right;">
                    <span style="color: ${snrRating !== 'poor' ? 'var(--success)' : 'var(--problem)'}; font-weight: 500;">
                        ${snrRating === 'excellent' || snrRating === 'good' ? '✓ Good' : snrRating === 'acceptable' ? '~ OK' : '✗ Poor'}
                    </span>
                </td>
            </tr>
        </table>
        
        ${issues.length > 0 ? `
        <div style="margin-bottom: 1.5rem;">
            <strong style="display: block; margin-bottom: 0.5rem;">To improve:</strong>
            <ul style="margin: 0; padding-left: 1.25rem; color: var(--text-secondary);">
                ${issues.map(issue => `<li style="margin-bottom: 0.25rem;">${issue}</li>`).join('')}
            </ul>
        </div>
        ` : ''}
        
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <button onclick="window.MicCheck.resetQualityTest()" class="btn btn-primary">
                Test Again
            </button>
            <button onclick="window.MicCheck.downloadDiagnosticsReport()" class="btn" style="background: var(--bg-muted); border: 1px solid var(--border);">
                Download Report
            </button>
        </div>
    `;
}
