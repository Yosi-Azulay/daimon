import type { Routes } from '@angular/router';

// Route table (M156, v1.12). Deep-link back-compat is a HARD RULE: every URL
// shape that ever shipped keeps resolving — redirects are fine, a 404 never
// is. `/apps` is the canonical apps list since v1.12; `/` is the overview
// home (M158). The apps list was reachable at `/` before v1.12, and `/` still
// resolves, so no old URL 404s. The catch-all `**` lands home.
// dashboard/e2e/route-audit.ts enumerates every shape and the redirect spec
// drives it.
export const ROUTES: Routes = [
  { path: '', loadComponent: () => import('./home-page').then(m => m.HomePageComponent) },
  { path: 'apps', loadComponent: () => import('./apps-list').then(m => m.AppsListComponent) },
  { path: 'apps/:name', loadComponent: () => import('./app-detail').then(m => m.AppDetailComponent) },
  { path: 'events', loadComponent: () => import('./events-feed').then(m => m.EventsFeedComponent) },
  { path: 'logs', loadComponent: () => import('./logs-page').then(m => m.LogsPageComponent) },
  { path: 'logs/:name', loadComponent: () => import('./logs-page').then(m => m.LogsPageComponent) },
  { path: 'errors', loadComponent: () => import('./errors-panel').then(m => m.ErrorsPanelComponent) },
  { path: 'doctor', loadComponent: () => import('./doctor-page').then(m => m.DoctorPageComponent) },
  { path: 'config', loadComponent: () => import('./config-editor').then(m => m.ConfigEditorComponent) },
  { path: 'history', loadComponent: () => import('./history-page').then(m => m.HistoryPageComponent) },
  { path: 'history/:name', loadComponent: () => import('./history-page').then(m => m.HistoryPageComponent) },
  { path: 'trends', loadComponent: () => import('./trends-page').then(m => m.TrendsPageComponent) },
  { path: 'timeline', loadComponent: () => import('./timeline-page').then(m => m.TimelinePageComponent) },
  { path: 'tests', loadComponent: () => import('./tests-page').then(m => m.TestsPageComponent) },
  { path: 'sessions', loadComponent: () => import('./sessions-page').then(m => m.SessionsPageComponent) },
  { path: 'graph', loadComponent: () => import('./graph-page').then(m => m.GraphPageComponent) },
  { path: 'requests/:name', loadComponent: () => import('./requests-page').then(m => m.RequestsPageComponent) },
  { path: 'agents', loadComponent: () => import('./agents-page').then(m => m.AgentsPageComponent) },
  { path: 'regressions', loadComponent: () => import('./regressions-page').then(m => m.RegressionsPageComponent) },
  { path: 'report', loadComponent: () => import('./report-page').then(m => m.ReportPageComponent) },
  { path: '**', redirectTo: '' },
];
