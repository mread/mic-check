/**
 * Main Application Module
 * 
 * Handles top-level wiring, navigation, and global event handlers.
 */

import { detectBrowser } from './browser.js';
import { route, navigate, initRouter } from './router.js';

import { populateDeviceList } from './audio.js';

import {
    runMicrophoneTest,
    stopTest,
    continueWithPermissionTests,
    toggleMonitoring,
    startNoiseFloorTest,
    startVoiceLevelTest,
    testAgain,
    downloadQualityReport,
    startQualityTest,
    startSilenceRecording,
    goToVoiceStep,
    startVoiceRecording,
    showQualityResults,
    resetQualityTest,
    stopLevelCheck,
    downloadLevelCheckReport
} from './screens/test-screen.js';

import { initStudioScreen, stopStudioScreen } from './screens/studio-screen.js';
import { runPrivacyCheck } from './screens/privacy-screen.js';

// ============================================
// Event Listeners
// ============================================
function setupListeners() {
    // Home screen - Start Test button
    document.getElementById('btn-start-test')?.addEventListener('click', () => {
        navigate('test');
    });
    
    // Journey cards - handle both click and keyboard activation
    // Map journey names to route paths
    const journeyRoutes = {
        'preflight': 'test',      // Pre-flight check goes to unified test page
        'level-check': 'test',    // Legacy: redirect to test page
        'studio': 'studio',
        'privacy': 'privacy'
    };
    
    document.querySelectorAll('.journey-card').forEach(card => {
        const activateCard = () => {
            const journey = card.dataset.journey;
            const routePath = journeyRoutes[journey];
            if (routePath) {
                navigate(routePath);
            }
        };
        
        card.addEventListener('click', activateCard);
        
        // Keyboard accessibility: activate on Enter or Space
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); // Prevent Space from scrolling
                activateCard();
            }
        });
    });
    
    // Mic monitor panel - event delegation for toggle checkboxes
    // Uses delegation to avoid XSS from inline onclick handlers
    document.getElementById('mic-monitor-list')?.addEventListener('change', (e) => {
        if (e.target.classList.contains('mic-monitor-checkbox')) {
            const row = e.target.closest('.mic-monitor-row');
            const deviceId = row?.dataset.deviceId;
            if (deviceId) {
                toggleMonitoring(deviceId, e.target.checked);
            }
        }
    });
    
    // Note: window.MicCheck is set up in init() after all functions are defined
    
    document.getElementById('btn-retry-test')?.addEventListener('click', () => {
        runMicrophoneTest();
    });
    
    // Quality test buttons (in the unified pre-flight check)
    document.getElementById('btn-test-again')?.addEventListener('click', () => {
        testAgain();
    });
    
    document.getElementById('btn-download-report')?.addEventListener('click', () => {
        downloadQualityReport();
    });
    
    // Privacy check
    document.getElementById('btn-privacy-check')?.addEventListener('click', () => {
        runPrivacyCheck();
    });
    
    // Level check
    document.getElementById('btn-quality-start')?.addEventListener('click', () => {
        startQualityTest();
    });
    
    document.getElementById('btn-refresh-devices')?.addEventListener('click', async () => {
        const select = document.getElementById('quality-device-select');
        await populateDeviceList(select);
    });
    
    // Level check step buttons
    document.getElementById('btn-start-silence')?.addEventListener('click', startSilenceRecording);
    document.getElementById('btn-next-to-voice')?.addEventListener('click', goToVoiceStep);
    document.getElementById('btn-start-voice')?.addEventListener('click', startVoiceRecording);
    document.getElementById('btn-show-results')?.addEventListener('click', showQualityResults);
}

// ============================================
// Initialization
// ============================================
function init() {
    detectBrowser();
    setupListeners();
    
    // Define routes
    route('', {
        screen: 'screen-home',
        onLeave: () => {
            // No cleanup needed for home
        }
    });
    
    route('test', {
        screen: 'screen-mic-test',
        onEnter: runMicrophoneTest,
        onLeave: stopTest
    });
    
    // Legacy level-check route - redirect to unified test page
    route('level-check', {
        screen: 'screen-mic-test',
        onEnter: () => {
            // Redirect legacy level-check URLs to the unified test page
            navigate('test');
        },
        onLeave: () => {}
    });
    
    route('studio', {
        screen: 'screen-studio',
        onEnter: initStudioScreen,
        onLeave: stopStudioScreen
    });
    
    route('privacy', {
        screen: 'screen-privacy',
        onEnter: runPrivacyCheck,
        onLeave: () => {
            // No cleanup needed for privacy
        }
    });
    
    // Start the router
    initRouter();
    
    // Expose API for inline onclick handlers and programmatic navigation
    window.MicCheck = {
        navigate,
        stopTest,
        stopStudioScreen,
        stopLevelCheck,
        runPrivacyCheck,
        continueWithPermissionTests,
        toggleMonitoring,
        // Quality test functions (unified pre-flight check)
        startNoiseFloorTest,
        startVoiceLevelTest,
        testAgain,
        downloadQualityReport,
        // Legacy level check step functions (for backward compatibility)
        goToVoiceStep,
        startVoiceRecording,
        showQualityResults,
        startSilenceRecording,
        // Results screen functions (with aliases for backward compatibility)
        resetQualityTest,
        resetLevelCheck: resetQualityTest,
        downloadLevelCheckReport
    };
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
