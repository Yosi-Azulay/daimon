import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { AppComponent } from './app/app';
import { ROUTES } from './app/routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideAnimationsAsync(),
    provideHttpClient(withFetch()),
    provideRouter(ROUTES, withComponentInputBinding()),
  ],
}).catch(err => console.error(err));
