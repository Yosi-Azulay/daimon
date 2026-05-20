import type { Routes } from '@angular/router';

export const ROUTES: Routes = [
  { path: '', loadComponent: () => import('./apps-list').then(m => m.AppsListComponent) },
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
  { path: 'tests', loadComponent: () => import('./tests-page').then(m => m.TestsPageComponent) },
  { path: 'sessions', loadComponent: () => import('./sessions-page').then(m => m.SessionsPageComponent) },
  { path: 'requests/:name', loadComponent: () => import('./requests-page').then(m => m.RequestsPageComponent) },
  { path: '**', redirectTo: '' },
];
