import type { Routes } from '@angular/router';

export const ROUTES: Routes = [
  { path: '', loadComponent: () => import('./apps-list').then(m => m.AppsListComponent) },
  { path: 'apps/:name', loadComponent: () => import('./app-detail').then(m => m.AppDetailComponent) },
  { path: '**', redirectTo: '' },
];
