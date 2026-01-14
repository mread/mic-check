/**
 * Results Renderer Module
 * 
 * Handles rendering of level check results.
 * 
 * LEVEL CHECK PURPOSE:
 * The Level Check helps diagnose "why am I too quiet in calls?"
 * - With AGC ON: Tests if your mic provides enough signal for browser apps
 * - With AGC OFF: Measures raw levels for desktop apps or gain staging
 * 
 * If issues are found, the user should proceed to Gain Staging (coming soon)
 * to optimize their hardware and OS settings.
 */

import { QUALITY_REFERENCE, AGC_REFERENCE, formatDb, formatLufs, getQualityRating } from './standards.js';
import { levelCheckState } from './audio.js';
import { escapeHtml } from './utils.js';

/**
 * Render the level check results to the DOM
 */
export function displayQualityResults() {
    const data = {
        noiseFloor: levelCheckState.noiseFloorDb,
        voiceLufs: levelCheckState.voiceLufs,
        peakLevel: levelCheckState.voicePeakDb,
        snr: levelCheckState.snr
    };
    
    const resultsEl = document.getElementById('quality-results');
    if (!resultsEl) {
        console.error('Results container not found');
        return;
    }
    resultsEl.style.display = 'block';
    
    // Check AGC status - this changes how we interpret results
    const agcWasEnabled = levelCheckState.agcEnabled === true;
    
    // Determine ratings based on AGC state
    // With AGC ON: Different expectations (AGC normalizes levels, prevents clipping)
    // With AGC OFF: Use broadcast standards for raw level assessment
    
    let noiseRating, lufsRating, peakRating;
    
    if (agcWasEnabled) {
        // AGC ON: Focus on "is mic providing enough signal for AGC to work"
        noiseRating = getQualityRating(data.noiseFloor, AGC_REFERENCE.noiseFloor, false);
        
        // With AGC, anything above -25 LUFS means mic is working fine
        if (data.voiceLufs >= AGC_REFERENCE.lufs.good) {
            lufsRating = 'good';
        } else if (data.voiceLufs >= AGC_REFERENCE.lufs.acceptable) {
            lufsRating = 'marginal';
        } else {
            lufsRating = 'too-quiet';
        }
        
        // Peak is meaningless with AGC (limiter prevents clipping)
        peakRating = 'n/a';
    } else {
        // AGC OFF: Use broadcast standards
        noiseRating = getQualityRating(data.noiseFloor, QUALITY_REFERENCE.noiseFloor, false);
        
        if (data.voiceLufs < QUALITY_REFERENCE.lufs.min) {
            lufsRating = 'too-quiet';
        } else if (data.voiceLufs > QUALITY_REFERENCE.lufs.max) {
            lufsRating = 'too-loud';
        } else {
            lufsRating = 'good';
        }
        
        if (data.peakLevel < QUALITY_REFERENCE.peak.min - 6) {
            peakRating = 'too-quiet';
        } else if (data.peakLevel > QUALITY_REFERENCE.peak.max) {
            peakRating = 'clipping';
        } else {
            peakRating = 'good';
        }
    }
    
    const snrRating = getQualityRating(data.snr, QUALITY_REFERENCE.snr, true);
    
    // Check for stereo issues (most impactful issue we can detect)
    const hasStereoIssue = levelCheckState.channelBalance?.hasDeadChannel;
    
    // Determine overall status
    const isGood = !hasStereoIssue && 
                   noiseRating !== 'poor' && 
                   snrRating !== 'poor' && 
                   lufsRating === 'good' &&
                   (agcWasEnabled || peakRating === 'good');
    
    // Build issues and recommendations
    const issues = [];
    
    if (hasStereoIssue) {
        issues.push({
            text: 'Stereo misconfiguration causing ~50% volume loss in some browsers',
            severity: 'critical'
        });
    }
    
    if (lufsRating === 'too-quiet') {
        if (agcWasEnabled) {
            issues.push({
                text: 'Signal too weak for AGC to compensate — check mic connection, selection, or gain',
                severity: 'high'
            });
        } else {
            issues.push({
                text: 'Voice too quiet — increase system mic gain or move closer',
                severity: 'high'
            });
        }
    }
    
    if (lufsRating === 'marginal' && agcWasEnabled) {
        issues.push({
            text: 'Signal is low but AGC should compensate — test in an actual call',
            severity: 'medium'
        });
    }
    
    if (!agcWasEnabled) {
        if (lufsRating === 'too-loud') {
            issues.push({ text: 'Voice too loud — decrease mic gain or move back', severity: 'high' });
        }
        if (peakRating === 'clipping') {
            issues.push({ text: 'Audio clipping detected — reduce mic gain', severity: 'high' });
        }
    }
    
    if (noiseRating === 'poor') {
        issues.push({ text: 'High background noise — find a quieter location', severity: 'medium' });
    }
    
    if (snrRating === 'poor') {
        issues.push({ text: 'Voice doesn\'t stand out from noise — speak louder or reduce noise', severity: 'medium' });
    }
    
    // AGC-specific messaging
    const agcExplanation = agcWasEnabled 
        ? `<strong>AGC was ON</strong> — This matches how browser apps (Google Meet, Zoom web, Discord) will hear you. 
           AGC automatically adjusts levels, so exact numbers matter less than whether your mic is providing signal.`
        : `<strong>AGC was OFF</strong> — This shows your raw microphone levels. 
           Use this to set up gain staging for desktop apps or streaming software.`;
    
    // Build header message based on status
    let headerIcon, headerMessage, headerDetail;
    if (isGood) {
        headerIcon = '✅';
        headerMessage = agcWasEnabled 
            ? 'Your microphone is working well for calls'
            : 'Your levels look good for streaming/recording';
        headerDetail = 'No issues detected';
    } else if (hasStereoIssue) {
        headerIcon = '🔧';
        headerMessage = 'Fixable issue found';
        headerDetail = 'Stereo misconfiguration — see fix below';
    } else {
        headerIcon = '⚠️';
        headerMessage = 'Some adjustments recommended';
        headerDetail = 'See suggestions below';
    }

    resultsEl.innerHTML = `
        <div style="text-align: center; padding: 1.5rem 0; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem;">
            <div style="font-size: 3rem; margin-bottom: 0.5rem;">${headerIcon}</div>
            <div style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem;">
                ${headerMessage}
            </div>
            <div style="color: var(--text-secondary); font-size: 0.9rem;">
                ${headerDetail}
            </div>
            <div style="color: var(--text-muted); font-size: 0.8rem; margin-top: 0.5rem;">
                ${escapeHtml(levelCheckState.deviceLabel) || 'Unknown microphone'}
            </div>
        </div>
        
        ${hasStereoIssue ? `
        <div style="background: #fff3e0; border-left: 4px solid #ff9800; padding: 1rem; margin-bottom: 1.5rem;">
            <strong style="display: block; margin-bottom: 0.5rem;">🔧 Stereo Configuration Issue (Fixable!)</strong>
            <p style="margin-bottom: 0.75rem; color: var(--text-secondary);">
                Your mic reports as stereo but only one channel has audio. 
                This causes browsers to mix a silent channel with your voice, cutting volume by ~50%.
            </p>
            <details open>
                <summary style="cursor: pointer; color: var(--accent); font-weight: 500;">How to fix</summary>
                <div style="margin-top: 0.75rem; font-size: 0.9rem; color: var(--text-secondary);">
                    <strong>Windows:</strong> Sound Settings → Recording → Right-click mic → Properties → Advanced → Change to "1 channel"<br><br>
                    <strong>macOS:</strong> Audio MIDI Setup → Select interface → Configure as mono<br><br>
                    <strong>Then:</strong> Come back and run this test again to verify the fix.
                </div>
            </details>
        </div>
        ` : ''}
        
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 1.1rem;">
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 0.75rem 0;">Voice Level</td>
                <td style="padding: 0.75rem 0; text-align: right; font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; font-size: 1.15rem; font-weight: 500;">${formatLufs(data.voiceLufs)}</td>
                <td style="padding: 0.75rem 0; text-align: right; width: 100px;">
                    <span style="color: ${lufsRating === 'good' ? 'var(--success)' : lufsRating === 'marginal' ? '#f57c00' : 'var(--problem)'}; font-weight: 500;">
                        ${lufsRating === 'good' ? '✓ Good' : lufsRating === 'marginal' ? '~ OK' : lufsRating === 'too-loud' ? '↑ Loud' : '↓ Quiet'}
                    </span>
                </td>
            </tr>
            ${!agcWasEnabled ? `
            <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 0.75rem 0;">Peak Level</td>
                <td style="padding: 0.75rem 0; text-align: right; font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; font-size: 1.15rem; font-weight: 500;">${formatDb(data.peakLevel)}</td>
                <td style="padding: 0.75rem 0; text-align: right;">
                    <span style="color: ${peakRating === 'good' ? 'var(--success)' : 'var(--problem)'}; font-weight: 500;">
                        ${peakRating === 'good' ? '✓ Good' : peakRating === 'clipping' ? '⚠ Clip' : '↓ Low'}
                    </span>
                </td>
            </tr>
            ` : ''}
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
        <div style="margin-bottom: 1.5rem; padding: 1rem; background: var(--bg-muted); border-radius: 8px;">
            <strong style="display: block; margin-bottom: 0.5rem;">Recommendations:</strong>
            <ul style="margin: 0; padding-left: 1.25rem; color: var(--text-secondary);">
                ${issues.map(i => `<li style="margin-bottom: 0.25rem;">${i.text}</li>`).join('')}
            </ul>
            ${!hasStereoIssue && issues.some(i => i.severity === 'high') ? `
            <p style="margin: 0.75rem 0 0 0; font-size: 0.9rem; color: var(--text-muted);">
                💡 <strong>Next step:</strong> Check out <strong>Gain Staging</strong> (coming soon) to optimize your hardware and OS settings.
            </p>
            ` : ''}
        </div>
        ` : ''}
        
        <details style="margin-bottom: 1.5rem; font-size: 0.9rem;">
            <summary style="cursor: pointer; color: var(--accent); font-weight: 500;">ℹ️ Understanding these results</summary>
            <div style="margin-top: 0.75rem; padding: 1rem; background: var(--bg-muted); border-radius: 8px; color: var(--text-secondary);">
                <p style="margin-bottom: 0.75rem;">${agcExplanation}</p>
                ${agcWasEnabled ? `
                <p style="margin-bottom: 0;">
                    <strong>Still having issues?</strong> Try testing with AGC OFF to measure raw levels. 
                    This helps identify if your hardware gain needs adjustment.
                </p>
                ` : `
                <p style="margin-bottom: 0;">
                    <strong>For desktop apps:</strong> These raw levels show what apps like Discord, OBS, or DAWs will receive 
                    (before their own processing). Aim for peaks around -6 to -1 dBFS.
                </p>
                `}
            </div>
        </details>
        
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <button onclick="window.MicCheck.resetLevelCheck()" class="btn btn-primary">
                Test Again
            </button>
            <button onclick="window.MicCheck.downloadLevelCheckReport()" class="btn" style="background: var(--bg-muted); border: 1px solid var(--border);">
                Download Report
            </button>
        </div>
    `;
}
