/// <reference types="vite/client" />

const RENDER_BACKEND_HOST = 'radix-kv.onrender.com';

/**
 * Returns the base URL for REST API calls.
 * - In local Vite development: http://localhost:3000
 * - In Vercel deployments (*.vercel.app): https://radix-kv.onrender.com
 * - On Render / custom domain: window.location.origin
 */
export function getApiBaseUrl(): string {
  if (import.meta.env.VITE_BACKEND_URL) {
    return import.meta.env.VITE_BACKEND_URL.replace(/\/$/, '');
  }
  if (typeof window !== 'undefined') {
    if (window.location.port === '5173') {
      return 'http://localhost:3000';
    }
    if (window.location.hostname.includes('vercel.app')) {
      return `https://${RENDER_BACKEND_HOST}`;
    }
    return window.location.origin;
  }
  return `https://${RENDER_BACKEND_HOST}`;
}

/**
 * Returns the WebSocket endpoint URL for live cluster telemetry.
 * - In local Vite development: ws://localhost:3000/ws
 * - In Vercel deployments: wss://radix-kv.onrender.com/ws
 * - On Render / custom domain: wss://<host>/ws or ws://<host>/ws
 */
export function getWebSocketUrl(): string {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  if (typeof window !== 'undefined') {
    if (window.location.port === '5173') {
      return 'ws://localhost:3000/ws';
    }
    if (window.location.hostname.includes('vercel.app')) {
      return `wss://${RENDER_BACKEND_HOST}/ws`;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }
  return `wss://${RENDER_BACKEND_HOST}/ws`;
}
