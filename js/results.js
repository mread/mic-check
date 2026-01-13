/**
 * Results Renderer Module
 * 
 * Handles rendering of quality analysis results.
 * This is kept separate due to the complexity of the HTML templates.
 */

import { QUALITY_REFERENCE, formatDb, formatLufs, getQualityRating } from './standards.js';
import { qualityTestData } from './audio.js';

/**
 * Render the quality analysis results to the DOM
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
    
    // LUFS rating
    let lufsRating = 'good';
    let lufsLabel = 'Good for streaming';
    if (data.voiceLufs < QUALITY_REFERENCE.lufs.min) {
        lufsRating = 'too-quiet';
        lufsLabel = 'Too Quiet';
    } else if (data.voiceLufs > QUALITY_REFERENCE.lufs.max) {
        lufsRating = 'too-loud';
        lufsLabel = 'Too Loud';
    } else if (data.voiceLufs <= -18) {
        lufsLabel = 'Good for broadcast';
    } else if (data.voiceLufs <= -15) {
        lufsLabel = 'Good for podcasts';
    } else {
        lufsLabel = 'Good for streaming';
    }
    
    // Peak rating
    let peakRating = 'good';
    if (data.peakLevel < QUALITY_REFERENCE.peak.min - 6) {
        peakRating = 'too-quiet';
    } else if (data.peakLevel > QUALITY_REFERENCE.peak.max) {
        peakRating = 'clipping';
    }
    
    // Overall assessment
    const isGood = noiseRating !== 'poor' && snrRating !== 'poor' && lufsRating === 'good' && peakRating === 'good';
    
    const ratingColors = {
        excellent: '#1e8e3e',
        good: '#34a853',
        acceptable: '#f9ab00',
        poor: '#d93025',
        'too-quiet': '#d93025',
        'too-loud': '#d93025',
        'clipping': '#d93025'
    };
    
    const ratingLabels = {
        excellent: 'Excellent',
        good: 'Good',
        acceptable: 'OK',
        poor: 'Poor',
        'too-quiet': 'Too Quiet',
        'too-loud': 'Too Loud',
        'clipping': 'Clipping!'
    };
    
    function getRecommendations() {
        const issues = [];
        
        if (lufsRating === 'too-quiet') {
            issues.push({
                icon: '🔈',
                title: 'Your voice is too quiet',
                detail: `At ${formatLufs(data.voiceLufs)}, you're below the minimum of ${formatLufs(QUALITY_REFERENCE.lufs.min)} for clear communication.`,
                fix: 'Move closer to the microphone (4-6 inches), speak louder, or increase your system microphone gain.'
            });
        }
        
        if (lufsRating === 'too-loud') {
            issues.push({
                icon: '🔊',
                title: 'Your voice is too loud',
                detail: `At ${formatLufs(data.voiceLufs)}, you're above ${formatLufs(QUALITY_REFERENCE.lufs.max)} which may sound harsh or distorted.`,
                fix: 'Move further from the microphone, speak softer, or decrease your system microphone gain.'
            });
        }
        
        if (peakRating === 'clipping') {
            issues.push({
                icon: '⚠️',
                title: 'Audio is clipping (distorting)',
                detail: `Your peak level of ${formatDb(data.peakLevel)} is too close to 0dB. Loud sounds will distort.`,
                fix: 'Reduce your microphone gain in system settings. Aim for peaks around -6dB to -3dB.'
            });
        }
        
        if (noiseRating === 'poor') {
            issues.push({
                icon: '🔇',
                title: 'Background noise is too high',
                detail: `Your noise floor of ${formatDb(data.noiseFloor)} is above the ${formatDb(QUALITY_REFERENCE.noiseFloor.acceptable)} threshold.`,
                fix: 'Move to a quieter location, use a directional microphone, or enable noise suppression.'
            });
        }
        
        if (snrRating === 'poor') {
            issues.push({
                icon: '📉',
                title: 'Voice doesn\'t stand out from noise',
                detail: `Your signal-to-noise ratio is only ${data.snr.toFixed(1)}dB. It should be at least ${QUALITY_REFERENCE.snr.acceptable}dB.`,
                fix: 'Speak louder, reduce background noise, or move closer to your microphone.'
            });
        }
        
        return issues;
    }
    
    const recommendations = getRecommendations();
    
    // Create LUFS comparison visualization
    const lufsMin = -30;
    const lufsMax = -5;
    const lufsRange = lufsMax - lufsMin;
    const yourLufsPercent = Math.max(0, Math.min(100, ((data.voiceLufs - lufsMin) / lufsRange) * 100));
    
    // AGC state for display
    const agcWasEnabled = qualityTestData.agcEnabled || false;
    
    // Build channel balance HTML
    let channelBalanceHtml = '';
    
    if (qualityTestData.channelBalance?.hasDeadChannel) {
        channelBalanceHtml = buildDeadChannelWarning();
    } else if (qualityTestData.channelBalance && qualityTestData.channelBalance.imbalanceDb > 6) {
        channelBalanceHtml = buildChannelImbalanceWarning();
    } else if (qualityTestData.channelBalance && qualityTestData.channelBalance.imbalanceDb <= 6) {
        channelBalanceHtml = buildChannelBalanceSuccess();
    } else if (qualityTestData.appliedSettings?.channelCount === 1) {
        channelBalanceHtml = buildMonoSuccess();
    }
    
    resultsEl.innerHTML = `
        <div class="status-card ${isGood ? 'success' : 'problem'}" style="margin-bottom: 1rem;">
            <span class="status-icon">${isGood ? '✅' : '⚠️'}</span>
            <div class="status-text">
                <div class="status-title">${isGood ? 'Your microphone sounds good!' : 'We found some issues'}</div>
                <div class="status-detail">${isGood 
                    ? 'People should be able to hear you clearly.' 
                    : 'These issues may affect how well people can hear you.'}</div>
            </div>
        </div>
        
        <div style="background: var(--bg-muted); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.85rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                <span>🎤</span>
                <strong>Device tested:</strong>
                <span style="color: var(--accent);">${qualityTestData.deviceLabel || 'Unknown'}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem; color: var(--text-muted);">
                <span>${agcWasEnabled ? '🔊' : '🎚️'}</span>
                <span>${agcWasEnabled 
                    ? 'AGC enabled — measurements reflect what apps typically hear' 
                    : 'Raw audio — measurements show your true microphone levels'}</span>
            </div>
        </div>
        
        ${channelBalanceHtml}
        
        <!-- LUFS Visual Comparison -->
        <h3 style="margin-bottom: 1rem; font-size: 1.1rem;">📊 Your Loudness vs Industry Standards</h3>
        
        <div style="background: var(--bg-muted); border-radius: 12px; padding: 1.25rem; margin-bottom: 1.5rem;">
            <div style="position: relative; height: 60px; background: linear-gradient(to right, #ffebee 0%, #fff3e0 25%, #e8f5e9 40%, #e8f5e9 70%, #fff3e0 85%, #ffebee 100%); border-radius: 8px; margin-bottom: 1rem;">
                <!-- Your level marker -->
                <div style="position: absolute; left: ${yourLufsPercent}%; top: -8px; transform: translateX(-50%); z-index: 10;">
                    <div style="width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 10px solid ${ratingColors[lufsRating]};"></div>
                    <div style="position: absolute; top: 12px; left: 50%; transform: translateX(-50%); background: ${ratingColors[lufsRating]}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; white-space: nowrap;">
                        You: ${formatLufs(data.voiceLufs)}
                    </div>
                </div>
                
                <!-- Zone labels -->
                <div style="position: absolute; bottom: 4px; left: 5%; font-size: 0.7rem; color: #d93025;">Too quiet</div>
                <div style="position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); font-size: 0.7rem; color: #1e8e3e;">Good range</div>
                <div style="position: absolute; bottom: 4px; right: 5%; font-size: 0.7rem; color: #d93025;">Too loud</div>
            </div>
            
            <!-- Reference markers -->
            <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted); padding: 0 0.5rem;">
                <span>-30 LUFS</span>
                <span>-20</span>
                <span>-14</span>
                <span>-5 LUFS</span>
            </div>
            
            <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border);">
                <div style="font-size: 0.85rem; color: var(--text-secondary);">
                    <strong>Industry targets:</strong>
                    <span style="margin-left: 1rem;">📺 Broadcast: -23 to -24 LUFS</span>
                    <span style="margin-left: 1rem;">🎙️ Podcasts: -16 LUFS</span>
                    <span style="margin-left: 1rem;">🎵 Streaming: -14 LUFS</span>
                </div>
            </div>
        </div>
        
        <!-- Detailed Metrics Table -->
        <h3 style="margin-bottom: 1rem; font-size: 1.1rem;">📋 Detailed Measurements</h3>
        
        <div style="background: var(--bg-muted); border-radius: 12px; padding: 1.25rem; margin-bottom: 1.5rem;">
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="text-align: left; font-size: 0.85rem; color: var(--text-muted);">
                        <th style="padding-bottom: 0.75rem;">Metric</th>
                        <th style="padding-bottom: 0.75rem;">Your Result</th>
                        <th style="padding-bottom: 0.75rem;">Target</th>
                        <th style="padding-bottom: 0.75rem;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    <tr style="border-top: 1px solid var(--border);">
                        <td style="padding: 0.75rem 0;">
                            <strong>Average Loudness</strong>
                            <div style="font-size: 0.8rem; color: var(--text-muted);">Perceived volume (LUFS)</div>
                        </td>
                        <td style="padding: 0.75rem 0; font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 1.1rem;">${formatLufs(data.voiceLufs)}</td>
                        <td style="padding: 0.75rem 0; font-size: 0.9rem;">-16 to -14 LUFS</td>
                        <td style="padding: 0.75rem 0;">
                            <span style="display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; background: ${ratingColors[lufsRating]}20; color: ${ratingColors[lufsRating]};">
                                ${lufsLabel}
                            </span>
                        </td>
                    </tr>
                    <tr style="border-top: 1px solid var(--border);">
                        <td style="padding: 0.75rem 0;">
                            <strong>Peak Level</strong>
                            <div style="font-size: 0.8rem; color: var(--text-muted);">Loudest moment (dBFS)</div>
                        </td>
                        <td style="padding: 0.75rem 0; font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace;">${formatDb(data.peakLevel)}</td>
                        <td style="padding: 0.75rem 0; font-size: 0.9rem;">-6 to -1 dB</td>
                        <td style="padding: 0.75rem 0;">
                            <span style="display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; background: ${ratingColors[peakRating]}20; color: ${ratingColors[peakRating]};">
                                ${ratingLabels[peakRating]}
                            </span>
                        </td>
                    </tr>
                    <tr style="border-top: 1px solid var(--border);">
                        <td style="padding: 0.75rem 0;">
                            <strong>Noise Floor</strong>
                            <div style="font-size: 0.8rem; color: var(--text-muted);">Background when silent</div>
                        </td>
                        <td style="padding: 0.75rem 0; font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace;">${formatDb(data.noiseFloor)}</td>
                        <td style="padding: 0.75rem 0; font-size: 0.9rem;">Below -35 dB</td>
                        <td style="padding: 0.75rem 0;">
                            <span style="display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; background: ${ratingColors[noiseRating]}20; color: ${ratingColors[noiseRating]};">
                                ${ratingLabels[noiseRating]}
                            </span>
                        </td>
                    </tr>
                    <tr style="border-top: 1px solid var(--border);">
                        <td style="padding: 0.75rem 0;">
                            <strong>Signal-to-Noise</strong>
                            <div style="font-size: 0.8rem; color: var(--text-muted);">Voice vs background</div>
                        </td>
                        <td style="padding: 0.75rem 0; font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace;">${data.snr.toFixed(1)} dB</td>
                        <td style="padding: 0.75rem 0; font-size: 0.9rem;">At least 20 dB</td>
                        <td style="padding: 0.75rem 0;">
                            <span style="display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; background: ${ratingColors[snrRating]}20; color: ${ratingColors[snrRating]};">
                                ${ratingLabels[snrRating]}
                            </span>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        
        ${recommendations.length > 0 ? `
            <h3 style="margin-bottom: 1rem; font-size: 1.1rem;">💡 How to Improve</h3>
            ${recommendations.map(rec => `
                <div class="info-box" style="margin-bottom: 1rem; background: #fff3e0; border: 1px solid #ff9800;">
                    <h4 style="margin-bottom: 0.5rem;">${rec.icon} ${rec.title}</h4>
                    <p style="margin-bottom: 0.5rem; color: var(--text-secondary);">${rec.detail}</p>
                    <p style="margin: 0;"><strong>Fix:</strong> ${rec.fix}</p>
                </div>
            `).join('')}
        ` : `
            <div class="info-box" style="background: #e8f5e9; border: 1px solid #4caf50;">
                <h4 style="margin-bottom: 0.5rem;">✨ Great job!</h4>
                <p style="margin: 0; color: var(--text-secondary);">
                    Your microphone levels are well-suited for video calls, streaming, and podcasting.
                    People should be able to hear you clearly.
                </p>
            </div>
        `}
        
        <details style="margin-top: 1.5rem; font-size: 0.9rem;">
            <summary style="cursor: pointer; color: var(--accent); font-weight: 500;">📖 Understanding LUFS and these measurements</summary>
            <div style="margin-top: 1rem; padding: 1rem; background: var(--bg-muted); border-radius: 8px;">
                <p style="margin-bottom: 1rem;"><strong>What is LUFS?</strong></p>
                <p style="margin-bottom: 1rem; color: var(--text-secondary);">
                    LUFS (Loudness Units Full Scale) measures perceived loudness — how loud audio actually <em>sounds</em> 
                    to human ears, not just peak amplitude. It's the industry standard for broadcast and streaming.
                </p>
                
                <p style="margin-bottom: 1rem;"><strong>Why is Peak Level different from LUFS?</strong></p>
                <p style="margin-bottom: 1rem; color: var(--text-secondary);">
                    Peak level shows the loudest single moment. LUFS shows average perceived loudness over time.
                    You can have high peaks but low LUFS if you speak softly with occasional loud words.
                </p>
                
                <p style="margin-bottom: 1rem;"><strong>Industry Standards:</strong></p>
                <ul style="margin: 0 0 0 1.25rem; color: var(--text-secondary);">
                    <li><strong>-14 LUFS</strong> — Spotify, YouTube, Apple Music (loudest common target)</li>
                    <li><strong>-16 LUFS</strong> — Podcasts, Apple Podcasts recommendation</li>
                    <li><strong>-23 LUFS</strong> — European TV broadcast (EBU R128)</li>
                    <li><strong>-24 LUFS</strong> — US TV broadcast (ATSC A/85)</li>
                </ul>
            </div>
        </details>
        
        <div style="display: flex; gap: 1rem; margin-top: 1.5rem; flex-wrap: wrap;">
            <button onclick="window.MicCheck.resetQualityTest()" class="btn btn-primary">
                🔄 Run Test Again
            </button>
            <button onclick="window.MicCheck.downloadDiagnosticsReport()" class="btn" style="background: var(--bg-muted); border: 1px solid var(--border);">
                📥 Download Diagnostics
            </button>
        </div>
    `;
}

function buildDeadChannelWarning() {
    const cb = qualityTestData.channelBalance;
    return `
    <div style="background: linear-gradient(135deg, #fff5f5 0%, #fff0f0 100%); border: 2px solid #e53935; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;">
        <h3 style="color: #c62828; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 1.5rem;">🔍</span> We Found Your Problem!
        </h3>
        
        <div style="background: white; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
            <h4 style="margin-bottom: 0.75rem;">What's Wrong</h4>
            <p style="margin-bottom: 0.75rem;">
                Your microphone is set up as a <strong>stereo device</strong>, but only <strong>one channel</strong> has audio. 
                The <strong>${cb.deadChannelSide === 'left' ? 'right' : 'left'} channel</strong> has your voice, 
                while the <strong>${cb.deadChannelSide} channel</strong> is silent.
            </p>
            
            <div style="display: flex; gap: 1rem; margin: 1rem 0;">
                <div style="flex: 1; text-align: center;">
                    <div style="font-weight: bold; margin-bottom: 0.5rem;">Left Channel</div>
                    <div style="background: ${cb.left.averageDb > -40 ? '#e8f5e9' : '#ffebee'}; 
                                height: 60px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
                                border: 2px solid ${cb.left.averageDb > -40 ? '#4caf50' : '#ef5350'};">
                        ${cb.left.averageDb > -40 ? '<span style="font-size: 1.5rem;">🎤</span>' : '<span style="color: #999;">Silent</span>'}
                    </div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">${cb.left.averageDb} dBFS</div>
                </div>
                <div style="flex: 1; text-align: center;">
                    <div style="font-weight: bold; margin-bottom: 0.5rem;">Right Channel</div>
                    <div style="background: ${cb.right.averageDb > -40 ? '#e8f5e9' : '#ffebee'}; 
                                height: 60px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
                                border: 2px solid ${cb.right.averageDb > -40 ? '#4caf50' : '#ef5350'};">
                        ${cb.right.averageDb > -40 ? '<span style="font-size: 1.5rem;">🎤</span>' : '<span style="color: #999;">Silent</span>'}
                    </div>
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">${cb.right.averageDb} dBFS</div>
                </div>
            </div>
        </div>
        
        <div style="background: white; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
            <h4 style="margin-bottom: 0.75rem;">Why This Matters</h4>
            <p style="margin-bottom: 0.5rem;">
                When your browser (especially Firefox) sees a stereo device, it <strong>averages both channels together</strong>. 
                Mixing a real signal with silence causes:
            </p>
            <ul style="margin: 0.5rem 0 0 1.25rem; color: var(--text-secondary);">
                <li><strong>~6 dB signal loss</strong> (half the volume)</li>
                <li>Your voice sounds quiet to others</li>
                <li>Poor signal-to-noise ratio</li>
            </ul>
            <p style="margin-top: 0.75rem; padding: 0.5rem; background: #e3f2fd; border-radius: 4px; font-size: 0.9rem;">
                💡 <strong>This is likely why your microphone sounds quiet in Firefox but fine in Chrome</strong>
            </p>
        </div>
        
        <div style="background: white; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
            <h4 style="margin-bottom: 0.75rem;">🔧 How to Fix It</h4>
            <p style="margin-bottom: 0.75rem;">Configure your audio interface to output <strong>mono</strong> instead of stereo:</p>
            
            <details style="margin-bottom: 0.75rem; border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem;" open>
                <summary style="cursor: pointer; font-weight: bold; color: var(--accent);">🎛️ Focusrite Scarlett / Solo / 2i2</summary>
                <div style="margin-top: 0.75rem; padding-left: 0.5rem;">
                    <p style="margin-bottom: 0.5rem;"><strong>Windows Sound Settings:</strong></p>
                    <ol style="margin: 0 0 0 1.25rem; color: var(--text-secondary); font-size: 0.9rem;">
                        <li>Right-click speaker icon → <strong>Sound settings</strong></li>
                        <li>Scroll down → <strong>More sound settings</strong></li>
                        <li>Go to <strong>Recording</strong> tab</li>
                        <li>Right-click your Focusrite → <strong>Properties</strong></li>
                        <li><strong>Advanced</strong> tab → Change to <strong>1 channel, 48000 Hz</strong></li>
                    </ol>
                </div>
            </details>
            
            <details style="border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem;">
                <summary style="cursor: pointer; font-weight: bold; color: var(--accent);">🍎 macOS</summary>
                <div style="margin-top: 0.75rem; padding-left: 0.5rem;">
                    <ol style="margin: 0 0 0 1.25rem; color: var(--text-secondary); font-size: 0.9rem;">
                        <li>Open <strong>Audio MIDI Setup</strong> (Applications → Utilities)</li>
                        <li>Select your audio interface</li>
                        <li>Set input to mono or route to both channels</li>
                    </ol>
                </div>
            </details>
        </div>
        
        <div style="background: #e8f5e9; border-radius: 8px; padding: 1rem; text-align: center;">
            <h4 style="margin-bottom: 0.5rem; color: #2e7d32;">✅ After You've Made Changes</h4>
            <p style="margin-bottom: 1rem; color: var(--text-secondary);">
                Apply the fix above, then click the button below to test again.
            </p>
            <button onclick="window.MicCheck.resetQualityTest()" class="btn btn-primary" style="background: #2e7d32;">
                🔄 Test Again to Verify Fix
            </button>
        </div>
    </div>
    `;
}

function buildChannelImbalanceWarning() {
    const cb = qualityTestData.channelBalance;
    return `
    <div style="background: #fff3e0; padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid #ffb74d;">
        <div style="display: flex; align-items: flex-start; gap: 0.75rem;">
            <span style="font-size: 1.25rem;">⚡</span>
            <div>
                <strong style="display: block; margin-bottom: 0.25rem;">Channel Imbalance Detected</strong>
                <p style="color: var(--text-secondary); margin-bottom: 0.5rem; font-size: 0.9rem;">
                    Your stereo channels have a ${cb.imbalanceDb} dB difference. 
                    This may indicate uneven input levels or a routing issue.
                </p>
                <div style="font-size: 0.85rem; color: var(--text-muted);">
                    Left: ${cb.left.averageDb} dBFS • Right: ${cb.right.averageDb} dBFS
                </div>
            </div>
        </div>
    </div>
    `;
}

function buildChannelBalanceSuccess() {
    const cb = qualityTestData.channelBalance;
    return `
    <div style="background: #e8f5e9; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.85rem;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span>✅</span>
            <span><strong>Stereo balance:</strong> Good (${cb.imbalanceDb} dB difference)</span>
        </div>
    </div>
    `;
}

function buildMonoSuccess() {
    return `
    <div style="background: #e8f5e9; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.85rem;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span>✅</span>
            <span><strong>Mono input:</strong> Correctly configured (no stereo issues possible)</span>
        </div>
    </div>
    `;
}
