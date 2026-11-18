import {header,close} from './ui/tokyo.js';
import {loadTheme} from './ui/themes.js';
import {showReports} from './ui/dashboard.js';
await loadTheme();header('REPORT HISTORY');await showReports();close('REPORTS LOADED');
